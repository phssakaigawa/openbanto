import http from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { JinnConfig, Connector, Employee, InterruptibleEngine, EngineConfigBlock } from "../shared/types.js";
import { loadConfig } from "../shared/config.js";
import { invalidateModelRegistry } from "../shared/models.js";
import { configureLogger, logger } from "../shared/logger.js";
import { initDb, recoverStaleSessions, recoverStaleQueueItems, getInterruptedSessions, listSessions, updateSession, getSession } from "../sessions/registry.js";
import { SessionManager, type RouteOptions } from "../sessions/manager.js";
import type { ClaudeEngine } from "../engines/claude.js";
import { InteractiveClaudeEngine } from "../engines/claude-interactive.js";
import { resolveEngine, BUILTIN_ENGINE_NAMES, type EngineContext } from "../engines/registry.js";
import { resolveGuardrail } from "../guardrails/registry.js";
import { PtyLifecycleManager } from "../engines/pty-lifecycle.js";
import type { PtyViewEngine } from "../engines/pty-view-engine.js";
import { attachPtyWebSocket } from "./pty-ws.js";
import { HookRegistry } from "./hook-registry.js";
import { startStatusReconciler } from "./status-reconciler.js";
import { writeGatewayInfo } from "./gateway-info.js";
import { cleanupSessionSettings, seedTrust } from "../shared/claude-settings.js";
import { GATEWAY_INFO_FILE, HOOK_RELAY_SCRIPT, CLAUDE_SETTINGS_DIR, JINN_HOME } from "../shared/paths.js";
import { handleApiRequest, resumePendingWebQueueItems, type ApiContext } from "./api.js";
import { ensureFilesDir } from "./files.js";
import { initStt } from "../stt/stt.js";
import { startWatchers, stopWatchers, syncSkillSymlinks } from "./watcher.js";
import {
  resolvePlugin,
  type ConnectorContext,
  type WebhookHandler,
} from "../connectors/registry.js";
import { loadJobs } from "../cron/jobs.js";
import { startScheduler, reloadScheduler, stopScheduler } from "../cron/scheduler.js";
import { scanOrg } from "./org.js";


const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Copy the hook-relay.mjs asset next to JINN_HOME so PTY-spawned Claude (running
 *  with our per-session --settings) can invoke it to POST turn hooks back to the
 *  gateway. Tries dev (src) and built (dist) layouts. Best-effort: a failure only
 *  degrades interactive turn resolution, which we log. */
function copyHookRelayAsset(): void {
  const candidates = [
    path.join(__dirname, "..", "..", "..", "assets", "hook-relay.mjs"), // dev: src/gateway → packages/jimmy/assets
    path.join(__dirname, "..", "..", "assets", "hook-relay.mjs"),       // built: dist/src/gateway → dist/assets
    path.join(__dirname, "..", "assets", "hook-relay.mjs"),
  ];
  try {
    const src = candidates.find((p) => fs.existsSync(p));
    if (!src) {
      logger.warn("hook-relay.mjs asset not found in any candidate location; interactive Claude hooks may not work");
      return;
    }
    fs.copyFileSync(src, HOOK_RELAY_SCRIPT);
  } catch (err) {
    logger.warn(`Failed to copy hook-relay.mjs: ${err instanceof Error ? err.message : err}`);
  }
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function serveStatic(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  webDir: string,
): boolean {
  if (!fs.existsSync(webDir)) return false;

  // Strip query string before resolving file path
  const urlPath = (req.url || "/").split("?")[0];
  let filePath = path.join(webDir, urlPath);
  if (filePath.endsWith("/")) filePath = path.join(filePath, "index.html");

  // Prevent directory traversal
  const resolved = path.resolve(filePath);
  if (!resolved.startsWith(path.resolve(webDir))) {
    res.writeHead(403);
    res.end("Forbidden");
    return true;
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    // Next.js static export produces /chat.html, /sessions.html, etc.
    // Try appending .html before falling back to index.html
    const htmlPath = resolved.endsWith("/")
      ? path.join(resolved, "index.html")
      : resolved + ".html";
    if (fs.existsSync(htmlPath) && !fs.statSync(htmlPath).isDirectory()) {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(htmlPath).pipe(res);
      return true;
    }

    // SPA fallback: serve index.html for non-API, non-WS routes
    const indexPath = path.join(webDir, "index.html");
    if (fs.existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      fs.createReadStream(indexPath).pipe(res);
      return true;
    }
    return false;
  }

  const ext = path.extname(resolved);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(resolved).pipe(res);
  return true;
}

export type GatewayCleanup = () => Promise<void>;

export async function startGateway(
  config: JinnConfig,
): Promise<GatewayCleanup> {
  const bootId = randomUUID().slice(0, 8);

  // Configure logging
  configureLogger({
    level: config.logging.level,
    stdout: config.logging.stdout,
    file: config.logging.file,
  });

  const gatewayName = config.portal?.portalName || "Banto";
  logger.info(`Starting ${gatewayName} gateway (boot ${bootId}, pid ${process.pid})...`);

  // Initialize database and recover any sessions stuck from a previous run
  initDb();
  ensureFilesDir();
  const recovered = recoverStaleSessions();
  if (recovered > 0) {
    logger.info(`Recovered ${recovered} stale session(s) — marked as "interrupted" for resume`);
  }

  // Log resumable sessions so operators know what can be picked up
  const resumable = getInterruptedSessions();
  if (resumable.length > 0) {
    logger.info(`${resumable.length} interrupted session(s) available for resume:`);
    for (const s of resumable) {
      logger.info(`  - ${s.id} (engine: ${s.engine}, employee: ${s.employee || "none"}, engineSessionId: ${s.engineSessionId})`);
    }
  }
  const recoveredQueue = recoverStaleQueueItems();
  if (recoveredQueue > 0) {
    logger.info(`Recovered ${recoveredQueue} in-flight queue item(s) from previous run — reset to pending`);
  }

  // Set up engines. Engines are pluggable (engines/registry.ts): the built-ins
  // (claude/codex/gemini/bob) resolve through the SAME registry as external
  // engine plugins, and each is lazily constructed via its plugin's create().
  // This replaces the old hand-written `new ClaudeEngine()` / … block; the map
  // ends up with exactly the same engine group as before, plus any external
  // engine declared with `engines.<name>.module`.
  const engineCtx: EngineContext = { logger, config };

  // Resolve the set of engine names to build: every built-in, plus any config
  // engine block that carries a `module` specifier OR an `impl` (e.g. named
  // openai instances aidea/kannon that share the in-tree openai implementation).
  const engineNames = new Set<string>(BUILTIN_ENGINE_NAMES);
  for (const [name, block] of Object.entries(config.engines ?? {})) {
    if (name === "default") continue;
    if (block && typeof block === "object") {
      const b = block as { module?: unknown; impl?: unknown };
      if (typeof b.module === "string" || typeof b.impl === "string") {
        engineNames.add(name);
      }
    }
  }

  const engines = new Map<string, InterruptibleEngine>();
  for (const name of engineNames) {
    const block = (config.engines as unknown as Record<string, EngineConfigBlock | undefined>)[name];
    const plugin = await resolveEngine(name, block as Record<string, unknown> | undefined);
    // Pass the engine's config key as `name` so shared-impl instances
    // (impl:"openai") report their own name in logs/results.
    const cfg = { ...(block ?? {}), name } as Record<string, unknown>;
    engines.set(name, await plugin.create(cfg, engineCtx));
  }
  // The headless Claude engine is the SSH fallback for the interactive PTY engine
  // (the local PTY can't run over SSH). The registry's claude factory builds the
  // headless engine, so pull it back out here.
  const claudeEngine = engines.get("claude") as ClaudeEngine;

  // Interactive Claude (PTY) engine — opt-in via config.engines.claude.interactive.
  // When enabled it REPLACES the headless `claude -p` engine under the "claude" key,
  // so all existing engine-config / fallback / rate-limit logic keys on "claude"
  // unchanged. It runs the genuine `claude` CLI in a PTY (no -p → cc_entrypoint=cli),
  // which bills against the Max subscription instead of metered API usage. Turns are
  // resolved via Claude Code Stop hooks relayed back through /api/internal/hook.
  const useInteractiveClaude = config.engines?.claude?.interactive === true;
  const hookSecret = randomBytes(24).toString("hex");
  let hookRegistry: HookRegistry | undefined;
  let claudeLifecycle: PtyLifecycleManager | undefined;
  let interactiveClaudeEngine: InteractiveClaudeEngine | undefined;
  if (useInteractiveClaude) {
    hookRegistry = new HookRegistry();
    claudeLifecycle = new PtyLifecycleManager({
      maxLivePtys: config.engines?.claude?.maxLivePtys ?? 8,
      onCleanup: (id) => {
        hookRegistry?.unregister(id);
        cleanupSessionSettings(CLAUDE_SETTINGS_DIR, id);
      },
      // Never reap/evict a PTY whose claude is mid-API-call (background
      // sub-agents keep streaming after the managed turn settles). Lazily bound:
      // the engine is constructed a few lines below.
      isBusy: (id) => interactiveClaudeEngine?.isEngineBusy(id) ?? false,
    });
    // Pass the headless engine as a remote fallback so sshHost employees still run
    // over SSH (the local PTY can't), while local turns get the Max-subsidized PTY.
    interactiveClaudeEngine = new InteractiveClaudeEngine(
      claudeLifecycle,
      hookRegistry,
      claudeEngine,
      config.engines?.claude?.interactiveTurnTimeoutMs ?? 90 * 60 * 1000,
    );
    copyHookRelayAsset();
    // Pre-trust JINN_HOME in the real ~/.claude.json so PTY-spawned Claude (cwd =
    // JINN_HOME) doesn't block every turn on the interactive "trust this folder?"
    // dialog — which has no Stop hook, so the turn would hang forever.
    try {
      seedTrust(path.join(os.homedir(), ".claude.json"), JINN_HOME);
    } catch (err) {
      logger.warn(`seedTrust failed for ${JINN_HOME}: ${err instanceof Error ? err.message : err}`);
    }
    logger.info("Interactive Claude (PTY) engine enabled — Claude work turns run via PTY (Max-subsidized cc_entrypoint=cli)");
  }

  // When interactive Claude is enabled it REPLACES the headless engine under the
  // "claude" key, so all engine-config / fallback / rate-limit logic keys on
  // "claude" unchanged (capabilities.interactive on "claude" is already true).
  if (interactiveClaudeEngine) engines.set("claude", interactiveClaudeEngine);

  // PTY-capable engines keyed by engine name — the /ws/pty/:sessionId handler
  // routes by session.engine so the live xterm CLI view attaches to the right one.
  // Only the interactive Claude engine exposes a PTY; absent when interactive is off.
  const ptyViewEngines: Record<string, PtyViewEngine> = {};
  if (interactiveClaudeEngine) ptyViewEngines["claude"] = interactiveClaudeEngine;

  // Derive connector names from config
  const connectorNames: string[] = [];
  if (config.connectors?.slack?.appToken && config.connectors?.slack?.botToken) {
    connectorNames.push("slack");
  }
  if (config.connectors?.discord?.botToken || config.connectors?.discord?.proxyVia) {
    connectorNames.push("discord");
  }
  if (config.connectors?.telegram?.botToken) {
    connectorNames.push("telegram");
  }
  if (config.connectors?.whatsapp) {
    connectorNames.push("whatsapp");
  }

  // Guardrail — pluggable per-turn permission / approval / audit policy
  // (guardrails/registry.ts), resolved through the SAME loader as an external
  // policy pack. With no config.guardrails.module the built-in no-op "allow-all"
  // guardrail is installed (opt-in), so behaviour is unchanged unless a policy
  // pack is configured. Built once and injected into the SessionManager, mirroring
  // how the engines Map is injected.
  // Pass the whole block so the registry can pick module → impl → no-op. With no
  // module and no impl the built-in no-op "allow-all" is installed (opt-in).
  const guardrailPlugin = await resolveGuardrail(config.guardrails);
  const guardrail = await guardrailPlugin.create(config.guardrails?.config ?? {}, { logger, config });
  if (config.guardrails?.module) {
    logger.info(`Guardrail plugin "${guardrailPlugin.name}" loaded from module "${config.guardrails.module}"`);
  } else if (config.guardrails?.impl) {
    logger.info(`Guardrail policy pack "${guardrailPlugin.name}" loaded (impl:"${config.guardrails.impl}")`);
  }

  // Session manager
  const sessionManager = new SessionManager(config, engines, connectorNames, guardrail);

  // Orphan hooks = engine activity AFTER a turn settled (background sub-agents /
  // tasks still running in the PTY). Any orphan event keeps the PTY alive; a
  // terminal Stop orphan is the final output of that background work and gets
  // delivered to the session's conversation instead of being dropped.
  hookRegistry?.setOrphanHandler((sid, hook) => {
    interactiveClaudeEngine?.noteBackgroundActivity(sid);
    void sessionManager.handleOrphanHook(sid, hook);
  });

  // Build employee registry
  let employeeRegistry = scanOrg();
  logger.info(`Loaded ${employeeRegistry.size} employee(s) from org directory`);

  // Start connectors
  const connectors: Connector[] = [];
  const connectorMap = new Map<string, Connector>();
  /** IDs of connectors created from config.connectors.instances[] (vs legacy top-level connectors) */
  const instanceConnectorIds = new Set<string>();

  // ---- Inbound webhook routes (ConnectorContext.mountWebhook) ----
  // Connectors that receive events over HTTP (LINE WORKS, Messenger, generic
  // callback bots) register a path→handler here; the gateway HTTP server
  // dispatches matching requests below. Outbound connectors (Slack Socket Mode,
  // Discord GW) never touch this. Phase-1 foundation: minimal, exact-path match.
  const webhookRoutes = new Map<string, WebhookHandler>();
  function mountWebhook(routePath: string, handler: WebhookHandler): void {
    const normalized = routePath.startsWith("/") ? routePath : `/${routePath}`;
    if (webhookRoutes.has(normalized)) {
      logger.warn(`mountWebhook: overriding existing route "${normalized}"`);
    }
    webhookRoutes.set(normalized, handler);
    logger.info(`Connector webhook route mounted: ${normalized}`);
  }

  /**
   * Single wiring path for every connector (legacy top-level, named instances,
   * and reload). Resolves the plugin (lazy dynamic-import of its heavy dep),
   * creates the connector, wires onMessage → sessionManager.route with the
   * employee binding, starts it, and registers it in connectors/connectorMap.
   *
   * Behaviour-preserving replacement for the previously duplicated blocks:
   * same route wiring, same employee lookup, same connectorMap keys, same
   * `!connectorMap.has(key)` guard. Returns the connector on success, or null
   * (already-present key or start failure — logged/collected by the caller).
   */
  async function wireConnector(opts: {
    type: string;
    /** connectorMap key: legacy uses the fixed type ("slack"/"discord"/…);
     *  instances use their `id`. */
    key: string;
    /** Config object passed to the connector constructor. */
    connectorConfig: Record<string, unknown>;
    /** Employee name to bind (undefined → engine default). */
    employeeName?: string;
    /** Fresh config for portal identity / goalInjection derivation. */
    cfg: JinnConfig;
    /** External plugin module specifier (Phase 2; unused for built-ins). */
    module?: string;
    /** true for connectors.instances[] entries (tracked in instanceConnectorIds). */
    isInstance: boolean;
    /** Label used in route-error logs (legacy used the type; instances used the id). */
    routeErrorLabel: string;
  }): Promise<{ connector: Connector | null; error?: string }> {
    if (connectorMap.has(opts.key)) {
      // Duplicate key: legacy top-level wins over instances at boot and reload.
      return { connector: null };
    }
    try {
      const emp = opts.employeeName ? employeeRegistry.get(opts.employeeName) : undefined;
      const ctx: ConnectorContext = {
        logger,
        config: opts.cfg,
        employee: emp,
        portalName: opts.cfg.portal?.portalName,
        operatorName: opts.cfg.portal?.operatorName,
        operatorAliases: opts.cfg.portal?.operatorAliases,
        // Slack /goal injection is only meaningful for the Claude engine —
        // preserves the old (employee?.engine ?? engines.default) === "claude" test.
        goalInjectionEnabled:
          (opts.employeeName ? emp?.engine : opts.cfg.engines.default) === "claude",
        mountWebhook,
      };
      const plugin = await resolvePlugin(opts.type, opts.module);
      const connector = await plugin.create(opts.connectorConfig as Record<string, unknown>, ctx);
      connector.onMessage((msg) => {
        const routeOpts: RouteOptions = {};
        if (emp) routeOpts.employee = emp;
        sessionManager.route(msg, connector, routeOpts).catch((err) => {
          logger.error(`${opts.routeErrorLabel} route error: ${err instanceof Error ? err.message : err}`);
        });
      });
      await connector.start();
      connectors.push(connector);
      connectorMap.set(opts.key, connector);
      if (opts.isInstance) instanceConnectorIds.add(opts.key);
      return { connector };
    } catch (err) {
      const message = `Failed to start connector "${opts.key}" (type: ${opts.type}): ${err instanceof Error ? err.message : err}`;
      logger.error(message);
      return { connector: null, error: message };
    }
  }

  // ---- Top-level connector start/stop helpers (closure over employeeRegistry, connectors, etc.) ----
  // These are defined here so they can be reused by both initial startup AND
  // reloadAllConnectors() when config.yaml changes (e.g. user saves new Slack
  // tokens via the WebUI).

  async function stopTopLevelConnectors(): Promise<{ stopped: string[]; errors: string[] }> {
    const stopped: string[] = [];
    const errors: string[] = [];
    for (const [id, connector] of [...connectorMap.entries()]) {
      // Instance-based connectors are handled by reloadConnectorInstances()
      if (instanceConnectorIds.has(id)) continue;
      try {
        await connector.stop();
        // stop() succeeded — safe to drop reference and let reload recreate.
        connectorMap.delete(id);
        const idx = connectors.indexOf(connector);
        if (idx >= 0) connectors.splice(idx, 1);
        stopped.push(id);
        logger.info(`Stopped top-level connector "${id}" for reload`);
      } catch (err) {
        // stop() FAILED. Don't drop the reference: the underlying client
        // (Slack websocket, Discord gateway, etc.) may still be live. If we
        // recreated it now, we'd have two live clients processing the same
        // events and sending duplicate replies. Better to surface a loud
        // error and require a daemon restart for recovery.
        const message = `stop() failed for top-level connector "${id}" — leaving in place to avoid duplicate replies. A full daemon restart may be required. Error: ${err instanceof Error ? err.message : err}`;
        logger.error(message);
        errors.push(message);
      }
    }
    return { stopped, errors };
  }

  async function startTopLevelConnectorsFromConfig(
    cfg: JinnConfig,
  ): Promise<{ started: string[]; errors: string[] }> {
    const started: string[] = [];
    const errors: string[] = [];

    // Legacy single-instance top-level connectors. Each is gated by the same
    // config predicate as before, keyed by its fixed type name in connectorMap.
    // All share the one wireConnector() path (plugin resolve → create →
    // onMessage/route → start → register); the per-type differences that remain
    // are just (a) the config-presence gate and (b) which config object to pass.
    const c = cfg.connectors ?? {};

    if (c.slack?.appToken && c.slack?.botToken) {
      const res = await wireConnector({
        type: "slack",
        key: "slack",
        connectorConfig: {
          appToken: c.slack.appToken,
          botToken: c.slack.botToken,
          allowFrom: c.slack.allowFrom,
          ignoreOldMessagesOnBoot: c.slack.ignoreOldMessagesOnBoot,
          triage: c.slack.triage,
          goalExtraction: c.slack.goalExtraction,
          agentsCanvas: c.slack.agentsCanvas,
        },
        employeeName: c.slack.employee,
        cfg,
        isInstance: false,
        routeErrorLabel: "Slack",
      });
      if (res.connector) started.push("slack");
      if (res.error) errors.push(res.error);
    }

    if (c.discord?.proxyVia) {
      // Legacy proxyVia form → RemoteDiscordConnector (no discord.js dependency).
      const res = await wireConnector({
        type: "discord-remote",
        key: "discord",
        connectorConfig: { proxyVia: c.discord.proxyVia, channelId: c.discord.channelId },
        employeeName: c.discord.employee,
        cfg,
        isInstance: false,
        routeErrorLabel: "Discord",
      });
      if (res.connector) { started.push("discord"); logger.info("Discord remote connector started"); }
      if (res.error) errors.push(res.error);
    } else if (c.discord?.botToken) {
      const res = await wireConnector({
        type: "discord",
        key: "discord",
        connectorConfig: c.discord as Record<string, unknown>,
        employeeName: c.discord.employee,
        cfg,
        isInstance: false,
        routeErrorLabel: "Discord",
      });
      if (res.connector) { started.push("discord"); logger.info("Discord connector started"); }
      if (res.error) errors.push(res.error);
    }

    if (c.telegram?.botToken) {
      const res = await wireConnector({
        type: "telegram",
        key: "telegram",
        connectorConfig: {
          botToken: c.telegram.botToken,
          allowFrom: c.telegram.allowFrom,
          ignoreOldMessagesOnBoot: c.telegram.ignoreOldMessagesOnBoot,
        },
        employeeName: c.telegram.employee,
        cfg,
        isInstance: false,
        routeErrorLabel: "Telegram",
      });
      if (res.connector) started.push("telegram");
      if (res.error) errors.push(res.error);
    }

    if (c.whatsapp) {
      const res = await wireConnector({
        type: "whatsapp",
        key: "whatsapp",
        connectorConfig: (c.whatsapp ?? {}) as Record<string, unknown>,
        employeeName: c.whatsapp.employee,
        cfg,
        isInstance: false,
        routeErrorLabel: "WhatsApp",
      });
      if (res.connector) { started.push("whatsapp"); logger.info("WhatsApp connector started (scan QR code if first run)"); }
      if (res.error) errors.push(res.error);
    }

    return { started, errors };
  }

  // Initial top-level connector startup
  await startTopLevelConnectorsFromConfig(config);

  /**
   * Start every connector declared in config.connectors.instances[]. Shared by
   * the initial boot and the reload path (startConfiguredInstances). Each entry
   * goes through the same wireConnector() path as the legacy top-level ones;
   * the only instance-specific bits are the id/type/employee destructuring and
   * the `{...typeConfig, id}` config shape (whatsapp historically omitted id,
   * kept identical below). Uses `freshCfg` for portal/goalInjection derivation
   * so a hot-reload picks up renamed portals.
   */
  async function startInstancesFromConfig(
    freshCfg: JinnConfig,
  ): Promise<{ started: string[]; errors: string[] }> {
    const started: string[] = [];
    const errors: string[] = [];
    if (!freshCfg.connectors?.instances) return { started, errors };
    for (const instance of freshCfg.connectors.instances) {
      const { id, type, employee, ...typeConfig } = instance;
      if (!id || !type) {
        errors.push(`Skipping connector instance without id or type`);
        logger.warn(`Skipping connector instance without id or type`);
        continue;
      }
      if (connectorMap.has(id)) {
        logger.warn(`Duplicate connector instance id "${id}", skipping`);
        continue;
      }
      // whatsapp historically received `{...typeConfig}` (no id spread); the
      // others got `{...typeConfig, id}`. Both are harmless supersets, kept
      // exactly as before for behaviour parity.
      const connectorConfig =
        type === "whatsapp" ? { ...typeConfig } : { ...typeConfig, id };
      const res = await wireConnector({
        type: type as string,
        key: id,
        connectorConfig: connectorConfig as Record<string, unknown>,
        employeeName: employee,
        cfg: freshCfg,
        module: (instance as { module?: string }).module,
        isInstance: true,
        routeErrorLabel: id,
      });
      if (res.connector) {
        started.push(id);
        logger.info(`Connector instance "${id}" (type: ${type}, employee: ${employee || "default"}) started`);
      }
      if (res.error) errors.push(res.error);
    }
    return { started, errors };
  }

  // Initial named-instance startup (result logged inside; errors already logged).
  await startInstancesFromConfig(config);

  sessionManager.setConnectorProvider(() => connectorMap);

  // Reload connector instances from config (stop old instances, start new ones)
  /**
   * Stop only the instance-based connectors. Split out from the legacy
   * combined reload so reloadAllConnectors() can interleave: stop top-level
   * + stop instances → start top-level → start instances. That order
   * preserves boot-time precedence (top-level wins for duplicate ids).
   */
  async function stopInstanceConnectors(): Promise<{ stopped: string[]; errors: string[] }> {
    const stopped: string[] = [];
    const errors: string[] = [];
    for (const [id, connector] of [...connectorMap.entries()]) {
      if (!instanceConnectorIds.has(id)) continue;
      try {
        await connector.stop();
        // stop() succeeded — safe to drop reference and let restart create afresh.
        connectorMap.delete(id);
        instanceConnectorIds.delete(id);
        const idx = connectors.indexOf(connector);
        if (idx >= 0) connectors.splice(idx, 1);
        stopped.push(id);
        logger.info(`Stopped connector instance "${id}" for reload`);
      } catch (err) {
        // stop() FAILED. Same reasoning as stopTopLevelConnectors: leave
        // the reference in place rather than risk duplicate live clients.
        const message = `stop() failed for instance "${id}" — leaving in place to avoid duplicate replies. A full daemon restart may be required. Error: ${err instanceof Error ? err.message : err}`;
        logger.error(message);
        errors.push(message);
      }
    }
    return { stopped, errors };
  }

  async function startConfiguredInstances(
    freshConfig: JinnConfig,
  ): Promise<{ started: string[]; errors: string[] }> {
    // Reload path reuses the same instance wiring as boot. wireConnector uses
    // freshConfig for portal/goalInjection derivation so a renamed portal shows
    // up after a hot-reload (matches the old freshConfig.portal.* handling).
    return startInstancesFromConfig(freshConfig);
  }

  /**
   * Backwards-compatible wrapper: stop+start instances in one call. Used by
   * the `POST /api/connectors/reload` endpoint and exposed via ApiContext
   * for any external consumer that still calls reloadConnectorInstances().
   */
  async function reloadConnectorInstances(
    preloadedConfig?: JinnConfig,
  ): Promise<{ started: string[]; stopped: string[]; errors: string[] }> {
    const fresh = preloadedConfig ?? loadConfig();
    const stopRes = await stopInstanceConnectors();
    const startRes = await startConfiguredInstances(fresh);
    return {
      started: startRes.started,
      stopped: stopRes.stopped,
      errors: [...stopRes.errors, ...startRes.errors],
    };
  }

  /**
   * Stop and re-initialize ALL connectors (top-level + instance-based) from
   * the on-disk config. Called automatically when ~/.openbanto/config.yaml
   * changes via the chokidar watcher, and via POST /api/connectors/reload.
   *
   * This is what makes "save Slack tokens in WebUI → bot reconnects" work
   * without a daemon restart. Previously only instance-based connectors
   * were reloaded, so editing top-level slack tokens required `ryoko stop`
   * + `ryoko start`.
   */
  async function doReloadOnce(): Promise<{ started: string[]; stopped: string[]; errors: string[] }> {
    const fresh = loadConfig();
    // Push fresh config into the SessionManager so new sessions see new
    // engines.default / portal.* / bin paths. Callers (watcher / API) are
    // responsible for updating apiContext.config too.
    currentConfig = fresh;
    invalidateModelRegistry(); // rebuild the model/capability registry from the new config
    sessionManager.setConfig(fresh);

    // Order:
    //   1. Stop old top-level + old instance connectors (clear the map).
    //   2. Start top-level FIRST (matches boot precedence: if a duplicate
    //      id exists in both forms, the legacy top-level wins).
    //   3. Start instances last — same `!connectorMap.has(...)` guard as
    //      boot, so duplicate-id instances are skipped, not the top-level.
    const stopTopRes = await stopTopLevelConnectors();
    const stopInstRes = await stopInstanceConnectors();
    const startTopRes = await startTopLevelConnectorsFromConfig(fresh);
    const startInstRes = await startConfiguredInstances(fresh);
    // Refresh the connector names baked into engine system prompts.
    sessionManager.setConnectorNames(Array.from(connectorMap.keys()));

    const result = {
      started: [...startTopRes.started, ...startInstRes.started],
      stopped: [...stopTopRes.stopped, ...stopInstRes.stopped],
      errors: [
        ...stopTopRes.errors,
        ...stopInstRes.errors,
        ...startTopRes.errors,
        ...startInstRes.errors,
      ],
    };

    // Only mark this config as "successfully applied" when no errors arose.
    // Otherwise the watcher's next event (after clearSuppressNextConnectorReload
    // in the API failure path) would diff fresh-vs-fresh and skip the retry.
    if (result.errors.length === 0) {
      lastConnectorReloadConfig = fresh;
    }
    return result;
  }

  async function reloadAllConnectors(): Promise<{ started: string[]; stopped: string[]; errors: string[] }> {
    // Coalesce concurrent callers: if a reload is in flight, mark a follow-up
    // so newer config (the second caller's intent) gets picked up after the
    // current one completes — and return the in-flight promise's result.
    // Without this, two overlapping reloads can both observe an empty map
    // after their respective stop pass and start duplicate live clients.
    if (reloadInFlight) {
      pendingReload = true;
      return reloadInFlight;
    }
    reloadInFlight = (async () => {
      try {
        let result = await doReloadOnce();
        // Drain any reload requests that arrived during this run, with
        // the most recent on-disk config. Keep going until quiet.
        while (pendingReload) {
          pendingReload = false;
          result = await doReloadOnce();
        }
        return result;
      } finally {
        reloadInFlight = null;
      }
    })();
    return reloadInFlight;
  }

  // Start cron scheduler
  const cronJobs = loadJobs();
  startScheduler(cronJobs, sessionManager, config, connectorMap);
  logger.info(`Loaded ${cronJobs.length} cron job(s)`);

  // Mutable config reference for hot-reload
  let currentConfig = config;
  // Tracks the config version that was last successfully applied to connectors.
  // The watcher diffs against THIS (not currentConfig) so that a failed reload
  // does not poison the next chokidar event into thinking "nothing changed".
  let lastConnectorReloadConfig = config;

  // Single-flight gate for connector reloads: any caller that arrives while
  // one is in flight is coalesced (no duplicate clients), and any reload
  // request received during a run schedules a single follow-up so newer
  // config doesn't get lost.
  let reloadInFlight: Promise<{ started: string[]; stopped: string[]; errors: string[] }> | null = null;
  let pendingReload = false;

  // Coordination flag between the API config-save path and the file watcher.
  // PUT /api/config eagerly reloads connectors for snappy UX, then sets this
  // flag so the chokidar event for the same file write doesn't double-reload
  // and race against the in-flight reload.
  let suppressNextWatcherConnectorReload = false;
  let suppressTimer: ReturnType<typeof setTimeout> | null = null;
  function suppressNextConnectorReload(): void {
    suppressNextWatcherConnectorReload = true;
    if (suppressTimer) clearTimeout(suppressTimer);
    // Auto-clear after 3s in case the watcher event never arrives (the file
    // write was rolled back, chokidar missed it, etc.) — we don't want to
    // permanently suppress legitimate future reloads.
    suppressTimer = setTimeout(() => {
      suppressNextWatcherConnectorReload = false;
      suppressTimer = null;
    }, 3000);
  }
  function clearSuppressNextConnectorReload(): void {
    suppressNextWatcherConnectorReload = false;
    if (suppressTimer) {
      clearTimeout(suppressTimer);
      suppressTimer = null;
    }
  }

  const startTime = Date.now();

  // Broadcast function (defined early so apiContext can reference it)
  const wsClients = new Set<import("ws").WebSocket>();
  const emit = (event: string, payload: unknown): void => {
    const message = JSON.stringify({ event, payload, ts: Date.now() });
    for (const client of wsClients) {
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch (err) {
          logger.warn(`WebSocket send failed, removing dead client: ${err instanceof Error ? err.message : err}`);
          wsClients.delete(client);
        }
      }
    }
  };

  // Backstop for lost completion events: unstick sessions stuck at
  // status:"running" with no live turn (see status-reconciler.ts).
  const stopStatusReconciler = startStatusReconciler({ engines, emit });

  // API context
  const apiContext: ApiContext = {
    config: currentConfig,
    sessionManager,
    startTime,
    getConfig: () => currentConfig,
    emit,
    connectors: connectorMap,
    reloadConnectorInstances,
    reloadAllConnectors,
    suppressNextConnectorReload,
    clearSuppressNextConnectorReload,
    hookRegistry,
    hookSecret: useInteractiveClaude ? hookSecret : undefined,
    // Reuse the live guardrail as the plugin-management audit sink. With no
    // guardrail module configured this is the no-op "allow-all" whose afterTurn
    // is harmless, so audit falls back to logger.info only.
    auditSink: guardrail,
  };

  // NOTE: replaying pending web queue items is deferred until AFTER the server is
  // listening and gateway.json (port + hook secret) has been written — otherwise an
  // interactive (PTY) recovery turn could spawn before hook-relay.mjs can discover
  // the gateway, leaving its Stop hook undeliverable and the turn hung.

  // Resolve web UI directory — bundled into dist/web/ by postbuild script
  // At runtime __dirname is dist/src/gateway/, so ../../web resolves to dist/web/
  const webDir = path.resolve(__dirname, "..", "..", "web");

  // Loopback Host header guard.
  //
  // The gateway binds to 127.0.0.1 by default but every API route is
  // unauthenticated, which makes the daemon vulnerable to classic DNS
  // rebinding from any browser tab on the same machine: an attacker page
  // can resolve a hostile DNS name to 127.0.0.1 and then `fetch()` against
  // our endpoints. We reject any request whose `Host` header isn't a
  // loopback / explicit-bind value the operator has configured.
  const configuredHost = config.gateway.host || "127.0.0.1";
  const LOOPBACK_HOSTNAMES = new Set([
    "127.0.0.1",
    "[::1]",
    "::1",
    "localhost",
  ]);
  function hostIsAllowed(hostHeader: string | undefined): boolean {
    if (!hostHeader) return false;
    // Strip port for comparison; "host:port" or "[::1]:port".
    const lastColon = hostHeader.lastIndexOf(":");
    const closingBracket = hostHeader.lastIndexOf("]");
    const hostname = lastColon > closingBracket
      ? hostHeader.slice(0, lastColon)
      : hostHeader;
    if (LOOPBACK_HOSTNAMES.has(hostname)) return true;
    if (hostname === configuredHost) return true;
    // Bare-IP case where the operator pinned to a LAN address.
    if (configuredHost === "0.0.0.0") return true; // explicit opt-in: any host
    return false;
  }

  // Create HTTP server
  const server = http.createServer((req, res) => {
    const url = req.url || "/";

    // Host header check before anything else — applies to both API and
    // static asset paths so a malicious cross-origin browser tab can't
    // pull session JSON either.
    if (!hostIsAllowed(req.headers.host)) {
      res.writeHead(421, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "host_not_allowed" }));
      return;
    }

    // CORS: restrict to localhost-style origins by default. The operator
    // can broaden via `gateway.host = 0.0.0.0`, in which case we mirror
    // the request's Origin header (still safer than a blanket `*`).
    const origin = req.headers.origin as string | undefined;
    if (origin && configuredHost !== "0.0.0.0") {
      try {
        const u = new URL(origin);
        if (LOOPBACK_HOSTNAMES.has(u.hostname)) {
          res.setHeader("Access-Control-Allow-Origin", origin);
          res.setHeader("Vary", "Origin");
        }
      } catch { /* invalid Origin header — leave CORS unset */ }
    } else if (origin && configuredHost === "0.0.0.0") {
      // explicit opt-in: reflect the origin (subject to operator policy)
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    // Connector inbound webhooks (ConnectorContext.mountWebhook). Matched by
    // exact path (query string stripped). The raw body is buffered and passed to
    // the plugin's handler, which performs its own signature verification. This
    // is the Phase-1 foundation for inbound connectors (LINE WORKS, etc.).
    const pathname = url.split("?")[0];
    const webhookHandler = webhookRoutes.get(pathname);
    if (webhookHandler) {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks);
        Promise.resolve(webhookHandler(req, res, body)).catch((err) => {
          logger.error(`Webhook handler error for ${pathname}: ${err instanceof Error ? err.message : err}`);
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "webhook_handler_error" }));
          }
        });
      });
      req.on("error", (err) => {
        logger.error(`Webhook request stream error for ${pathname}: ${err.message}`);
      });
      return;
    }

    // API routes
    if (url.startsWith("/api/")) {
      handleApiRequest(req, res, apiContext);
      return;
    }

    // Static files for web UI
    if (!serveStatic(req, res, webDir)) {
      if (url === "/" || url === "/index.html") {
        res.writeHead(503, { "Content-Type": "text/html" });
        res.end("<html><body><h1>Web UI not built</h1><p>Run <code>pnpm build</code> from the project root to build the web UI.</p></body></html>");
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    }
  });

  // WebSocket server
  const wss = new WebSocketServer({ noServer: true });
  // Dedicated WS server for per-session PTY streams (/ws/pty/:sessionId) — kept
  // separate from the global broadcast `wss` so its sockets aren't added to the
  // broadcast client set.
  const ptyWss = new WebSocketServer({ noServer: true });

  wss.on("connection", (ws) => {
    wsClients.add(ws);
    logger.info(`WebSocket client connected (${wsClients.size} total)`);

    ws.on("close", () => {
      wsClients.delete(ws);
      logger.info(`WebSocket client disconnected (${wsClients.size} total)`);
    });

    ws.on("error", (err) => {
      logger.error(`WebSocket error: ${err.message}`);
      wsClients.delete(ws);
    });
  });

  // Origin guard for WS upgrades. WebSocket isn't covered by CORS preflight, so a
  // cross-site browser page could otherwise open /ws/pty and inject stdin into the
  // Claude PTY. Allow only same-host / loopback / configured-host origins; a non-
  // browser client (no Origin header) is allowed. Mirrors the HTTP CORS intent.
  function wsOriginAllowed(originHeader: string | undefined, hostHeader: string | undefined): boolean {
    if (!originHeader) return true; // non-browser client
    let originHost: string;
    try { originHost = new URL(originHeader).hostname; } catch { return false; }
    if (LOOPBACK_HOSTNAMES.has(originHost)) return true;
    if (originHost === configuredHost) return true;
    // Same-origin as the request's Host (strip port) — the gateway-served UI.
    if (hostHeader) {
      const lastColon = hostHeader.lastIndexOf(":");
      const closingBracket = hostHeader.lastIndexOf("]");
      const hostname = lastColon > closingBracket ? hostHeader.slice(0, lastColon) : hostHeader;
      if (originHost === hostname) return true;
    }
    return false;
  }

  server.on("upgrade", (req, socket, head) => {
    const reqUrl = req.url || "";
    // DNS-rebinding / cross-host guard — mirror the HTTP request path so a WS
    // upgrade can't bypass it. Applies to both /ws and /ws/pty.
    if (!hostIsAllowed(req.headers.host)) { socket.destroy(); return; }
    if (reqUrl === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    // Dedicated per-session PTY channel for the live xterm CLI view. Routes to the
    // session's OWN engine — no claude fallback (codex/gemini have no PTY view, and
    // the FE hides the CLI toggle for them, so this only refuses stragglers).
    const ptyMatch = reqUrl.split("?")[0].match(/^\/ws\/pty\/([^/]+)$/);
    if (ptyMatch) {
      // /ws/pty forwards stdin to the PTY — reject cross-site browser origins.
      if (!wsOriginAllowed(req.headers.origin, req.headers.host)) { socket.destroy(); return; }
      let sessionId: string;
      try { sessionId = decodeURIComponent(ptyMatch[1]); } catch { socket.destroy(); return; }
      const ptySession = getSession(sessionId);
      const ptyEngine = ptySession ? ptyViewEngines[ptySession.engine] : undefined;
      if (!ptyEngine) { socket.destroy(); return; }
      ptyWss.handleUpgrade(req, socket, head, (ws) => {
        attachPtyWebSocket(ws, sessionId, ptyEngine);
      });
      return;
    }
    socket.destroy();
  });


  // Sync skill symlinks to .claude/skills/ and .agents/skills/
  syncSkillSymlinks();

  // Initialize STT model symlinks
  try {
    initStt();
  } catch (err) {
    logger.warn(`STT init skipped: ${err instanceof Error ? err.message : err}`);
  }

  // Start file watchers
  startWatchers({
    onConfigReload: () => {
      try {
        const previous = currentConfig;
        currentConfig = loadConfig();
        invalidateModelRegistry(); // rebuild the model/capability registry from the reloaded config
        apiContext.config = currentConfig;
        // Propagate the fresh config into SessionManager so new sessions
        // pick up edits to engines.default / portal.* / engine bin paths
        // even when the connectors block didn't change.
        sessionManager.setConfig(currentConfig);
        logger.info("Config reloaded successfully");
        emit("config:reloaded", {});

        // If the API just wrote this file (PUT /api/config) it has already
        // triggered reloadAllConnectors itself and may still be mid-reconnect.
        // Skip our reload to avoid stop→start→stop→start churn and the
        // race that comes with two overlapping reloads.
        if (suppressNextWatcherConnectorReload) {
          suppressNextWatcherConnectorReload = false;
          if (suppressTimer) {
            clearTimeout(suppressTimer);
            suppressTimer = null;
          }
          logger.debug("Skipping watcher-triggered connector reload (API just wrote config and reloaded)");
          return;
        }

        // External edits to ~/.openbanto/config.yaml (vim, ryoko CLI, etc.) need
        // a connector refresh when either:
        //   (a) the connectors block changed, OR
        //   (b) portal.portalName/operatorName changed — Slack connectors
        //       capture those at construction so the live ones would keep
        //       triaging with the old portal identity until restart.
        //
        // Diff against lastConnectorReloadConfig (NOT `previous`) so that a
        // failed previous reload doesn't poison this comparison: if the
        // last successful reload was config v1 and we've since written v2
        // unsuccessfully, comparing v2-vs-v2 would skip the retry.
        const baseline = lastConnectorReloadConfig;
        const portalNamesChanged =
          baseline.portal?.portalName !== currentConfig.portal?.portalName ||
          baseline.portal?.operatorName !== currentConfig.portal?.operatorName;
        const connectorsChanged =
          JSON.stringify(baseline.connectors ?? null) !==
          JSON.stringify(currentConfig.connectors ?? null);
        if (connectorsChanged || portalNamesChanged) {
          reloadAllConnectors()
            .then((result) => {
              logger.info(
                `Connectors reloaded after config change — started=[${result.started.join(",")}] stopped=[${result.stopped.join(",")}] errors=${result.errors.length}`,
              );
              emit("connectors:reloaded", result);
            })
            .catch((err) => {
              logger.error(
                `reloadAllConnectors failed: ${err instanceof Error ? err.message : err}`,
              );
            });
        }
      } catch (err) {
        logger.error(
          `Failed to reload config: ${err instanceof Error ? err.message : err}`,
        );
      }
    },
    onCronReload: () => {
      const updatedJobs = loadJobs();
      reloadScheduler(updatedJobs);
      logger.info(`Cron jobs reloaded (${updatedJobs.length} job(s))`);
      emit("cron:reloaded", {});
    },
    onOrgChange: () => {
      employeeRegistry = scanOrg();
      logger.info(`Org directory changed, reloaded ${employeeRegistry.size} employee(s)`);
      emit("org:changed", {});
    },
    onSkillsChange: () => {
      logger.info("Skills changed, notifying clients");
      emit("skills:changed", {});
    },
  });

  // Start listening
  const port = config.gateway.port || 7777;
  const host = config.gateway.host || "127.0.0.1";

  await new Promise<void>((resolve, reject) => {
    server.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        const msg = `Port ${port} is already in use.`;
        logger.error(msg);
        console.error(`\nError: ${msg}`);
        console.error(`\nTry: ryoko start -p ${port + 1}`);
        console.error(`Or update the port in config.yaml\n`);
        process.exit(1);
      }
      reject(err);
    });
    server.listen(port, host, () => {
      logger.info(`${gatewayName} gateway listening on http://${host}:${port} (boot ${bootId})`);
      resolve();
    });
  });

  // Publish gateway connection info (port + hook secret + pid) so hook-relay.mjs —
  // spawned by the interactive Claude PTY — can discover where to POST turn hooks.
  if (useInteractiveClaude) {
    try {
      writeGatewayInfo(GATEWAY_INFO_FILE, { port, pid: process.pid, secret: hookSecret });
    } catch (err) {
      logger.warn(`Failed to write ${GATEWAY_INFO_FILE}: ${err instanceof Error ? err.message : err}`);
    }
  }

  // Replay any pending web queue items (e.g. gateway restart mid-run). Deferred to
  // here so the server is listening and gateway.json exists before any interactive
  // recovery turn spawns — so hook-relay.mjs can deliver its Stop hook.
  resumePendingWebQueueItems(apiContext);

  // Notify connected WebSocket clients about interrupted sessions available for resume
  if (resumable.length > 0) {
    // Small delay to let WebSocket clients connect after server starts
    setTimeout(() => {
      emit("sessions:interrupted", {
        count: resumable.length,
        sessions: resumable.map((s) => ({
          id: s.id,
          engine: s.engine,
          employee: s.employee,
          title: s.title,
          lastActivity: s.lastActivity,
        })),
      });
    }, 1000);
  }

  // Prevent macOS from sleeping while the gateway is running
  let caffeinate: ChildProcess | null = null;
  if (process.platform === "darwin") {
    caffeinate = spawn("caffeinate", ["-s"], {
      stdio: "ignore",
      detached: false,
    });
    caffeinate.unref();
    caffeinate.on("error", (err) => {
      logger.warn(`caffeinate failed to start: ${err.message}`);
      caffeinate = null;
    });
    logger.info("caffeinate started — macOS sleep prevention active");
  }

  // Return cleanup function
  return async () => {
    logger.info("Gateway cleanup starting...");

    // Stop caffeinate
    if (caffeinate && caffeinate.exitCode === null) {
      caffeinate.kill();
      logger.info("caffeinate stopped");
    }

    // Mark all running sessions as "interrupted" before killing engine processes.
    // This preserves their engine_session_id so they can be resumed on next startup.
    const runningSessions = listSessions({ status: "running" });
    for (const session of runningSessions) {
      updateSession(session.id, {
        status: "interrupted",
        lastActivity: new Date().toISOString(),
        lastError: "Interrupted: gateway shutting down gracefully",
      });
      logger.info(`Marked session ${session.id} as interrupted for resume`);
    }

    // Terminate live engine subprocesses after marking sessions. When interactive
    // is active, interactiveClaudeEngine.killAll() also kills its headless fallback
    // (the same claudeEngine), so call only one to avoid a redundant double-kill.
    if (interactiveClaudeEngine) {
      // interactiveClaudeEngine.killAll() also kills its headless Claude fallback.
      claudeLifecycle?.dispose();
      try { stopStatusReconciler(); } catch { /* best effort */ }
      try { hookRegistry?.dispose(); } catch { /* best effort */ }
      try { fs.rmSync(GATEWAY_INFO_FILE, { force: true }); } catch { /* best effort */ }
    }
    // Tear down every engine in the map (claude/codex/gemini/bob + externals).
    for (const engine of engines.values()) {
      try { engine.killAll(); } catch { /* best effort */ }
    }

    // Stop cron scheduler
    stopScheduler();

    // Stop connectors
    for (const connector of connectors) {
      try {
        await connector.stop();
      } catch (err) {
        logger.error(`Failed to stop ${connector.name} connector: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Stop watchers
    await stopWatchers();

    // Close WebSocket connections
    for (const client of wsClients) {
      client.close(1001, "Server shutting down");
    }
    wsClients.clear();

    // Close the per-session PTY WS sockets + server too (separate from `wss`).
    for (const client of ptyWss.clients) {
      try { client.close(1001, "Server shutting down"); } catch { /* already closing */ }
    }

    // Close WebSocket servers
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await new Promise<void>((resolve) => ptyWss.close(() => resolve()));

    // Close HTTP server
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

    logger.info("Gateway shutdown complete");
  };
}
