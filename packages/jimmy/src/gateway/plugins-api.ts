// Plugin management API (Gated Install).
//
// Exposes GET /api/plugins, POST /api/plugins/install, POST /api/plugins/toggle
// and PUT /api/plugins/config through the gateway's hand-written /api/ router
// (gateway/api.ts). This is a STRONG, code-executing operation — install runs
// `pnpm add <module>`, which pulls arbitrary code that then runs with the
// daemon's own privileges — so every route is protected by requirePluginAdmin()
// and the module specifier is strictly validated before it ever reaches pnpm.
//
// Security model (see docs/design/plugin-manage-ui.md):
//   1. Feature is OPT-IN: config.plugins.manageUi must be exactly true, else 403.
//   2. Authorization is re-checked SERVER-SIDE on every call. We trust an edge
//      proxy (Keycloak / oauth2-proxy) to inject X-Forwarded-Groups; the caller
//      must be in config.plugins.adminGroup. If the header is absent we only
//      allow loopback (127.0.0.1/::1) — i.e. the operator on the box.
//   3. The module specifier is an allow-list (npm package name OR git+https),
//      shell metacharacters are rejected, and local paths are refused.
//   4. pnpm is invoked with execFile (argv array — NEVER a shell string), so a
//      crafted module string can't inject a command.
//   5. Every mutating operation is audited (logger.info + guardrail sink if one
//      is configured).
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { IncomingMessage as HttpRequest } from "node:http";
import { execFile } from "node:child_process";
import fs from "node:fs";
import yaml from "js-yaml";
import type { JinnConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { CONFIG_PATH } from "../shared/paths.js";
import { BUILTIN_ENGINE_NAMES } from "../engines/registry.js";
import { BUILTIN_CONNECTOR_TYPES } from "../connectors/registry.js";

export type PluginType = "engine" | "connector" | "guardrail";

/** Audit sink: an optional guardrail whose afterTurn we opportunistically use as
 *  a structured audit channel. Kept intentionally loose — any object with an
 *  afterTurn function qualifies. */
export interface AuditSink {
  afterTurn?: (ctx: any, result: any) => void | Promise<void>;
}

export interface PluginAdminGate {
  ok: boolean;
  who?: string;
  reason?: string;
  /** HTTP status to use when ok=false. */
  status?: number;
}

/** Extract the loopback-ness of the connection. oauth2-proxy strips inbound
 *  X-Forwarded-* from untrusted clients and re-adds its own, so the presence of
 *  X-Forwarded-Groups is treated as "came through the proxy". When it's absent
 *  we require the socket to be loopback (the operator running curl on the box). */
function isLoopback(req: HttpRequest): boolean {
  const addr = req.socket?.remoteAddress ?? "";
  return (
    addr === "127.0.0.1" ||
    addr === "::1" ||
    addr === "::ffff:127.0.0.1"
  );
}

function headerValue(req: HttpRequest, name: string): string | undefined {
  const v = req.headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

/**
 * The single authorization gate for every /api/plugins/* route. Returns
 * `{ ok:false, status, reason }` to reject or `{ ok:true, who }` to proceed.
 */
export function requirePluginAdmin(req: HttpRequest, config: JinnConfig): PluginAdminGate {
  // (1) Feature must be explicitly enabled.
  if (config.plugins?.manageUi !== true) {
    return { ok: false, status: 403, reason: "Plugin management UI is disabled (config.plugins.manageUi)" };
  }

  const adminGroup = config.plugins?.adminGroup || "openbanto-admins";
  const groupsHeader = headerValue(req, "X-Forwarded-Groups");

  // (2) Proxy path: authorize by group membership.
  if (groupsHeader !== undefined) {
    const groups = groupsHeader.split(",").map((g) => g.trim()).filter(Boolean);
    if (groups.includes(adminGroup)) {
      const who = headerValue(req, "X-Forwarded-Email") || "unknown";
      return { ok: true, who };
    }
    return { ok: false, status: 403, reason: `Not a member of admin group "${adminGroup}"` };
  }

  // (2b) No proxy headers → only trust a loopback connection (operator on box).
  if (isLoopback(req)) {
    return { ok: true, who: "localhost" };
  }

  return { ok: false, status: 403, reason: "Missing X-Forwarded-Groups and not a loopback connection" };
}

// ---- Module specifier validation ------------------------------------------

/** npm package name: optional @scope/, lowercase-ish, may carry a @version. */
const NPM_NAME_RE = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(@[a-zA-Z0-9._^~><=+*.-]+)?$/;
/** git+https URL: git+https://host/path(.git)?(#ref)? — no auth, no shell meta. */
const GIT_HTTPS_RE = /^git\+https:\/\/[a-zA-Z0-9._~:/?#[\]@!$&'()*+,;=%-]+$/;
/** Any of these anywhere in the string aborts validation (shell metacharacters,
 *  whitespace, path traversal). */
const FORBIDDEN_CHARS = /[\s;&|`$(){}<>\\"'\n\r\t]/;

export interface ModuleValidation {
  ok: boolean;
  kind?: "npm" | "git";
  reason?: string;
}

/**
 * Validate a module specifier before it is handed to `pnpm add`. Only an npm
 * package name (optionally versioned) or a `git+https://` URL is accepted.
 * Local/absolute paths, `file:`/`link:` specifiers, and anything containing a
 * shell metacharacter are rejected. Pure — unit-tested in plugins-api.test.ts.
 */
export function validateModuleSpec(moduleSpec: unknown): ModuleValidation {
  if (typeof moduleSpec !== "string") {
    return { ok: false, reason: "module must be a string" };
  }
  const m = moduleSpec.trim();
  if (m.length === 0) return { ok: false, reason: "module is empty" };
  if (m.length > 512) return { ok: false, reason: "module is too long" };

  // Reject shell metacharacters / whitespace outright (belt-and-braces: execFile
  // already avoids the shell, but we never want these near a package manager).
  if (FORBIDDEN_CHARS.test(m)) {
    return { ok: false, reason: "module contains forbidden characters" };
  }

  // Refuse local / absolute / relative / protocol-local specifiers explicitly.
  if (
    m.startsWith("/") ||
    m.startsWith(".") ||
    m.startsWith("~") ||
    /^[a-zA-Z]:[\\/]/.test(m) || // Windows drive path
    m.startsWith("file:") ||
    m.startsWith("link:") ||
    m.startsWith("portal:")
  ) {
    return { ok: false, reason: "local/relative paths are not allowed" };
  }

  if (m.startsWith("git+https://")) {
    if (GIT_HTTPS_RE.test(m)) return { ok: true, kind: "git" };
    return { ok: false, reason: "invalid git+https URL" };
  }

  // Reject other git/ssh/http(s) forms — only git+https is permitted.
  if (
    m.startsWith("git+") ||
    m.startsWith("git:") ||
    m.startsWith("http:") ||
    m.startsWith("https:") ||
    m.startsWith("ssh:") ||
    m.includes("://")
  ) {
    return { ok: false, reason: "only git+https:// URLs are allowed" };
  }

  if (NPM_NAME_RE.test(m)) return { ok: true, kind: "npm" };
  return { ok: false, reason: "not a valid npm package name" };
}

// ---- Config helpers --------------------------------------------------------

/** Read config.yaml as a mutable plain object (never throws — returns {} if
 *  unreadable). We deliberately re-read from disk rather than trusting the
 *  in-memory snapshot, matching PUT /api/config's merge-from-disk behaviour. */
function readConfigFromDisk(): Record<string, any> {
  try {
    return (yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, any>) || {};
  } catch {
    return {};
  }
}

function writeConfigToDisk(cfg: Record<string, any>): void {
  fs.writeFileSync(CONFIG_PATH, yaml.dump(cfg));
}

/** Resolve the directory to run `pnpm add` in. */
export function resolveInstallRoot(config: JinnConfig): string {
  const configured = config.plugins?.installRoot;
  if (configured && typeof configured === "string") return configured;
  // Repo root: this file lives at packages/jimmy/src/gateway/plugins-api.ts;
  // at runtime it's dist/src/gateway/, so climb to the repo root either way by
  // resolving from the jimmy package root upward. process.cwd() is the safest
  // default for the daemon (started from the repo), so prefer it.
  return process.cwd();
}

// ---- Aggregation (GET /api/plugins) ---------------------------------------

export interface PluginEntry {
  name: string;
  kind: "builtin" | "module";
  module?: string;
  enabled: boolean;
  hasConfig: boolean;
}

export interface PluginsSummary {
  manageUi: boolean;
  adminGroup: string;
  engines: PluginEntry[];
  connectors: PluginEntry[];
  guardrails: PluginEntry[];
}

/** Reserved keys inside an engine block that are not "config" for hasConfig. */
const ENGINE_META_KEYS = new Set([
  "bin", "model", "effortLevel", "childEffortOverride", "module",
  "interactive", "maxLivePtys", "interactiveTurnTimeoutMs",
]);

/** Build the plugin summary from the live config. */
export function summarizePlugins(config: JinnConfig): PluginsSummary {
  const engines: PluginEntry[] = [];
  const enginesCfg = (config.engines || {}) as Record<string, any>;
  const defaultEngine = enginesCfg.default;
  for (const [name, block] of Object.entries(enginesCfg)) {
    if (name === "default") continue;
    if (!block || typeof block !== "object") continue;
    const module = typeof block.module === "string" ? block.module : undefined;
    const isBuiltin = (BUILTIN_ENGINE_NAMES as readonly string[]).includes(name) && !module;
    const hasConfig = Object.keys(block).some((k) => !ENGINE_META_KEYS.has(k));
    engines.push({
      name,
      kind: isBuiltin ? "builtin" : "module",
      module,
      enabled: name === defaultEngine,
      hasConfig,
    });
  }

  const connectors: PluginEntry[] = [];
  const connCfg = (config.connectors || {}) as Record<string, any>;
  for (const [key, block] of Object.entries(connCfg)) {
    if (key === "instances") continue;
    if (!block || typeof block !== "object") continue;
    const module = typeof block.module === "string" ? block.module : undefined;
    const isBuiltin = (BUILTIN_CONNECTOR_TYPES as readonly string[]).includes(key) && !module;
    const enabled = block.enabled !== false; // default on unless explicitly disabled
    const hasConfig = Object.keys(block).some((k) => k !== "module" && k !== "enabled");
    connectors.push({ name: key, kind: isBuiltin ? "builtin" : "module", module, enabled, hasConfig });
  }
  // Named instances are module/builtin connectors too — surface them by id.
  if (Array.isArray(connCfg.instances)) {
    for (const inst of connCfg.instances) {
      if (!inst || typeof inst !== "object" || !inst.id) continue;
      const module = typeof inst.module === "string" ? inst.module : undefined;
      const isBuiltin = (BUILTIN_CONNECTOR_TYPES as readonly string[]).includes(inst.type) && !module;
      connectors.push({
        name: String(inst.id),
        kind: isBuiltin ? "builtin" : "module",
        module,
        enabled: inst.enabled !== false,
        hasConfig: true,
      });
    }
  }

  const guardrails: PluginEntry[] = [];
  const gr = config.guardrails;
  if (gr && (gr.module || gr.config)) {
    guardrails.push({
      name: gr.module ? gr.module : "noop",
      kind: gr.module ? "module" : "builtin",
      module: gr.module,
      enabled: true,
      hasConfig: !!gr.config && Object.keys(gr.config).length > 0,
    });
  } else {
    guardrails.push({ name: "noop", kind: "builtin", enabled: true, hasConfig: false });
  }

  return {
    manageUi: config.plugins?.manageUi === true,
    adminGroup: config.plugins?.adminGroup || "openbanto-admins",
    engines,
    connectors,
    guardrails,
  };
}

// ---- Install ---------------------------------------------------------------

export interface InstallRequest {
  pluginType: PluginType;
  name: string;
  module: string;
  config?: Record<string, unknown>;
}

export interface InstallResult {
  status: "installed" | "error";
  needsRestart?: boolean;
  reloaded?: unknown;
  stderr?: string;
  message?: string;
}

/** Run `corepack pnpm@10.6.4 add "<module>"` via execFile (no shell). */
function pnpmAdd(moduleSpec: string, cwd: string): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "corepack",
      ["pnpm@10.6.4", "add", moduleSpec],
      { cwd, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      },
    );
  });
}

/** A simple package-name regex for validating the plugin `name` field (engine
 *  name / connector id / not a path). Keep it conservative. */
const PLUGIN_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

/**
 * Perform an install: validate, `pnpm add`, patch config.yaml, and report
 * whether a restart is needed. Reload of connectors is the caller's job (it
 * owns reloadAllConnectors); engine/guardrail changes return needsRestart:true.
 */
export async function installPlugin(
  reqBody: InstallRequest,
  config: JinnConfig,
): Promise<{ http: number; body: InstallResult; patched: boolean }> {
  const { pluginType, name, module } = reqBody;
  if (pluginType !== "engine" && pluginType !== "connector" && pluginType !== "guardrail") {
    return { http: 400, body: { status: "error", message: "invalid pluginType" }, patched: false };
  }
  if (typeof name !== "string" || !PLUGIN_NAME_RE.test(name)) {
    return { http: 400, body: { status: "error", message: "invalid name" }, patched: false };
  }
  const mv = validateModuleSpec(module);
  if (!mv.ok) {
    return { http: 400, body: { status: "error", message: `invalid module: ${mv.reason}` }, patched: false };
  }

  const cwd = resolveInstallRoot(config);
  const add = await pnpmAdd(module.trim(), cwd);
  if (!add.ok) {
    return { http: 500, body: { status: "error", stderr: add.stderr || add.stdout, message: "pnpm add failed" }, patched: false };
  }

  // Patch config.yaml (merge-from-disk, matching PUT /api/config's writer).
  const cfg = readConfigFromDisk();
  if (pluginType === "engine") {
    cfg.engines = cfg.engines || {};
    const block = (cfg.engines[name] && typeof cfg.engines[name] === "object") ? cfg.engines[name] : {};
    block.module = module.trim();
    if (reqBody.config && typeof reqBody.config === "object") Object.assign(block, reqBody.config);
    cfg.engines[name] = block;
  } else if (pluginType === "connector") {
    cfg.connectors = cfg.connectors || {};
    const block = (cfg.connectors[name] && typeof cfg.connectors[name] === "object") ? cfg.connectors[name] : {};
    block.module = module.trim();
    block.enabled = true;
    if (reqBody.config && typeof reqBody.config === "object") Object.assign(block, reqBody.config);
    cfg.connectors[name] = block;
  } else {
    // guardrail — single policy pack
    cfg.guardrails = cfg.guardrails || {};
    cfg.guardrails.module = module.trim();
    if (reqBody.config && typeof reqBody.config === "object") cfg.guardrails.config = reqBody.config;
  }
  writeConfigToDisk(cfg);

  // connector → hot-reloadable; engine/guardrail → require restart.
  const needsRestart = pluginType !== "connector";
  return {
    http: 200,
    body: { status: "installed", needsRestart },
    patched: true,
  };
}

// ---- Toggle ----------------------------------------------------------------

export interface ToggleRequest {
  pluginType: PluginType;
  name: string;
  enabled: boolean;
}

export function togglePlugin(
  reqBody: ToggleRequest,
): { http: number; body: { status: string; message?: string; needsRestart?: boolean }; patched: boolean } {
  const { pluginType, name, enabled } = reqBody;
  if (typeof enabled !== "boolean" || typeof name !== "string" || !PLUGIN_NAME_RE.test(name)) {
    return { http: 400, body: { status: "error", message: "invalid request" }, patched: false };
  }
  const cfg = readConfigFromDisk();
  let needsRestart = false;
  if (pluginType === "engine") {
    // Enable = make it the default engine; disable = revert default to claude.
    cfg.engines = cfg.engines || {};
    if (!cfg.engines[name] && enabled) {
      return { http: 404, body: { status: "error", message: "engine not configured" }, patched: false };
    }
    cfg.engines.default = enabled ? name : "claude";
    needsRestart = true;
  } else if (pluginType === "connector") {
    cfg.connectors = cfg.connectors || {};
    // Top-level connector by key, else a named instance by id.
    if (cfg.connectors[name] && typeof cfg.connectors[name] === "object") {
      cfg.connectors[name].enabled = enabled;
    } else if (Array.isArray(cfg.connectors.instances)) {
      const inst = cfg.connectors.instances.find((i: any) => i && i.id === name);
      if (!inst) return { http: 404, body: { status: "error", message: "connector not found" }, patched: false };
      inst.enabled = enabled;
    } else {
      return { http: 404, body: { status: "error", message: "connector not found" }, patched: false };
    }
    // connector hot-reloads
  } else if (pluginType === "guardrail") {
    // Disable = drop the module (falls back to no-op allow-all).
    cfg.guardrails = cfg.guardrails || {};
    if (!enabled) delete cfg.guardrails.module;
    needsRestart = true;
  } else {
    return { http: 400, body: { status: "error", message: "invalid pluginType" }, patched: false };
  }
  writeConfigToDisk(cfg);
  return { http: 200, body: { status: "ok", needsRestart }, patched: true };
}

// ---- Config update ---------------------------------------------------------

export interface ConfigUpdateRequest {
  pluginType: PluginType;
  name: string;
  config: Record<string, unknown>;
}

export function updatePluginConfig(
  reqBody: ConfigUpdateRequest,
): { http: number; body: { status: string; message?: string; needsRestart?: boolean }; patched: boolean } {
  const { pluginType, name, config: newConfig } = reqBody;
  if (typeof name !== "string" || !PLUGIN_NAME_RE.test(name) || !newConfig || typeof newConfig !== "object" || Array.isArray(newConfig)) {
    return { http: 400, body: { status: "error", message: "invalid request" }, patched: false };
  }
  const cfg = readConfigFromDisk();
  let needsRestart = false;
  if (pluginType === "engine") {
    cfg.engines = cfg.engines || {};
    const block = (cfg.engines[name] && typeof cfg.engines[name] === "object") ? cfg.engines[name] : {};
    Object.assign(block, newConfig);
    cfg.engines[name] = block;
    needsRestart = true;
  } else if (pluginType === "connector") {
    cfg.connectors = cfg.connectors || {};
    if (cfg.connectors[name] && typeof cfg.connectors[name] === "object") {
      Object.assign(cfg.connectors[name], newConfig);
    } else if (Array.isArray(cfg.connectors.instances)) {
      const inst = cfg.connectors.instances.find((i: any) => i && i.id === name);
      if (!inst) return { http: 404, body: { status: "error", message: "connector not found" }, patched: false };
      Object.assign(inst, newConfig);
    } else {
      return { http: 404, body: { status: "error", message: "connector not found" }, patched: false };
    }
  } else if (pluginType === "guardrail") {
    cfg.guardrails = cfg.guardrails || {};
    cfg.guardrails.config = newConfig;
    needsRestart = true;
  } else {
    return { http: 400, body: { status: "error", message: "invalid pluginType" }, patched: false };
  }
  writeConfigToDisk(cfg);
  return { http: 200, body: { status: "ok", needsRestart }, patched: true };
}

// ---- Audit -----------------------------------------------------------------

export interface AuditRecord {
  who: string;
  action: string;
  pluginType?: PluginType;
  name?: string;
  module?: string;
  result: string;
}

/** Audit an operation: always logger.info; opportunistically flow through a
 *  configured guardrail's afterTurn as a structured audit sink (best-effort). */
export async function auditPluginAction(record: AuditRecord, sink?: AuditSink): Promise<void> {
  logger.info(`[plugin-admin] ${JSON.stringify(record)}`);
  if (sink && typeof sink.afterTurn === "function") {
    try {
      await sink.afterTurn(
        {
          sessionKey: "plugin-admin",
          connector: "web",
          channel: "plugins",
          userId: record.who,
          userName: record.who,
          engine: "n/a",
          text: `${record.action} ${record.pluginType ?? ""} ${record.name ?? ""} ${record.module ?? ""}`.trim(),
          toolbelt: [],
        },
        { ok: record.result === "ok" || record.result === "installed", error: record.result },
      );
    } catch (err) {
      logger.warn(`[plugin-admin] audit sink error: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// Re-export the config path so the router can force a fresh reload after a patch.
export { CONFIG_PATH };
