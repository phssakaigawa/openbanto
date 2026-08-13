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
  /** For engines that select a shared in-tree impl (impl:"openai"). */
  impl?: string;
  /** Non-secret openai engine fields surfaced so the Web edit form can prefill.
   *  The apiKey is NEVER included — only whether one is set. */
  openai?: { baseUrl?: string; model?: string; temperature?: number; hasApiKey: boolean };
  /** Non-secret view of the built-in "sample" guardrail policy, so the Web form
   *  can prefill. The audit endpoint / auth headers are masked to a boolean. */
  sample?: {
    allowUsers: string[];
    denyKeywords: string[];
    approvalTools: string[];
    approvers: string[];
    auditSink: "log" | "http";
    hasAuditEndpoint: boolean;
  };
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
  // openai impl block keys
  "impl", "baseUrl", "apiKey", "headers", "temperature", "name",
]);

/** Reduce a stored `guardrails.config` (the sample policy shape) to the flat,
 *  non-secret fields the Web form edits. The audit endpoint / headers are masked
 *  to a boolean — never echoed. Tolerant of hand-written YAML (missing keys OK). */
function summarizeSampleConfig(cfg: unknown): PluginEntry["sample"] {
  const c = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, any>;
  const strArr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  // denyKeywords: flatten every deny rule's `contains` (the form models one rule).
  const denyKeywords: string[] = [];
  if (Array.isArray(c.deny)) {
    for (const r of c.deny) {
      if (r && typeof r === "object") denyKeywords.push(...strArr((r as any).contains));
    }
  }
  // approvalTools / approvers: flatten every requireApproval rule.
  const approvalTools: string[] = [];
  const approvers: string[] = [];
  if (Array.isArray(c.requireApproval)) {
    for (const r of c.requireApproval) {
      if (r && typeof r === "object") {
        approvalTools.push(...strArr((r as any).tools));
        approvers.push(...strArr((r as any).approvers));
      }
    }
  }
  const audit = (c.audit && typeof c.audit === "object" ? c.audit : {}) as Record<string, any>;
  const auditSink = audit.sink === "http" ? "http" : "log";
  return {
    allowUsers: strArr(c.allowUsers),
    denyKeywords,
    approvalTools,
    approvers: Array.from(new Set(approvers)),
    auditSink,
    hasAuditEndpoint: typeof audit.endpoint === "string" && audit.endpoint.length > 0,
  };
}

/** Build the plugin summary from the live config. */
export function summarizePlugins(config: JinnConfig): PluginsSummary {
  const engines: PluginEntry[] = [];
  const enginesCfg = (config.engines || {}) as Record<string, any>;
  const defaultEngine = enginesCfg.default;
  for (const [name, block] of Object.entries(enginesCfg)) {
    if (name === "default") continue;
    if (!block || typeof block !== "object") continue;
    const module = typeof block.module === "string" ? block.module : undefined;
    const impl = typeof block.impl === "string" ? block.impl : undefined;
    const isBuiltin = (BUILTIN_ENGINE_NAMES as readonly string[]).includes(name) && !module && !impl;
    const hasConfig = Object.keys(block).some((k) => !ENGINE_META_KEYS.has(k));
    engines.push({
      name,
      kind: isBuiltin ? "builtin" : "module",
      module,
      enabled: name === defaultEngine,
      hasConfig,
      ...(impl ? { impl } : {}),
      // Surface non-secret openai fields for the edit form (apiKey masked to a boolean).
      ...(impl === "openai"
        ? {
            openai: {
              baseUrl: typeof block.baseUrl === "string" ? block.baseUrl : undefined,
              model: typeof block.model === "string" ? block.model : undefined,
              temperature: typeof block.temperature === "number" ? block.temperature : undefined,
              hasApiKey: typeof block.apiKey === "string" && block.apiKey.length > 0,
            },
          }
        : {}),
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
  const gr = config.guardrails as
    | { module?: string; impl?: string; config?: Record<string, any> }
    | undefined;
  if (gr && (gr.module || gr.impl || gr.config)) {
    const impl = typeof gr.impl === "string" ? gr.impl : undefined;
    guardrails.push({
      name: gr.module ? gr.module : impl ? impl : "noop",
      kind: gr.module ? "module" : "builtin",
      module: gr.module,
      enabled: true,
      hasConfig: !!gr.config && Object.keys(gr.config).length > 0,
      ...(impl ? { impl } : {}),
      // Non-secret view of the sample policy so the Web form can prefill. The
      // audit endpoint and any auth headers are masked to a boolean.
      ...(impl === "sample" ? { sample: summarizeSampleConfig(gr.config) } : {}),
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

// ---- OpenAI-compatible engine (built-in impl, no pnpm add) -----------------

export interface OpenAiEngineRequest {
  /** Config engine key (aidea/kannon/…). [a-z0-9-]+ */
  name: string;
  baseUrl: string;
  /** Omit / empty on an EDIT to keep the stored key unchanged. Required on create. */
  apiKey?: string;
  model?: string;
  temperature?: number;
  headers?: Record<string, string>;
}

/** Engine identifier: lowercase, digits, hyphen. Distinct from PLUGIN_NAME_RE
 *  (which allows uppercase/dots) — engine keys are used as YAML keys and model
 *  ids, so keep them tight. */
const OPENAI_ENGINE_NAME_RE = /^[a-z0-9-]+$/;

/** Accept only http(s) URLs for the OpenAI-compatible base. */
function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) return false;
  try {
    const u = new URL(value);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Create or update an OpenAI-compatible engine. Unlike installPlugin this does
 * NOT run `pnpm add` — the implementation is in-tree (impl:"openai"). It writes
 * `engines.<name> = { impl:"openai", baseUrl, apiKey, model, … }` using the same
 * merge-from-disk config writer, so an EDIT preserves the existing apiKey when
 * the caller omits it. Always needsRestart (engine map is built at boot).
 *
 * Returns `patched:false` on validation error so the router skips the audit's
 * success path; the apiKey is NEVER echoed back in the response.
 */
export function upsertOpenAiEngine(
  reqBody: OpenAiEngineRequest,
): { http: number; body: { status: string; message?: string; needsRestart?: boolean; created?: boolean }; patched: boolean } {
  const name = typeof reqBody?.name === "string" ? reqBody.name.trim() : "";
  if (!OPENAI_ENGINE_NAME_RE.test(name)) {
    return { http: 400, body: { status: "error", message: "name must match [a-z0-9-]+" }, patched: false };
  }
  // Refuse to shadow a built-in engine key.
  if ((BUILTIN_ENGINE_NAMES as readonly string[]).includes(name) || name === "default") {
    return { http: 400, body: { status: "error", message: `"${name}" is a reserved engine name` }, patched: false };
  }
  if (!isHttpUrl(reqBody?.baseUrl)) {
    return { http: 400, body: { status: "error", message: "baseUrl must be an http(s) URL" }, patched: false };
  }
  if (reqBody.temperature !== undefined && typeof reqBody.temperature !== "number") {
    return { http: 400, body: { status: "error", message: "temperature must be a number" }, patched: false };
  }

  const cfg = readConfigFromDisk();
  cfg.engines = cfg.engines || {};
  const existing =
    cfg.engines[name] && typeof cfg.engines[name] === "object" ? (cfg.engines[name] as Record<string, any>) : undefined;
  const created = !existing;

  // On create, an apiKey is mandatory. On edit, an empty/omitted apiKey keeps
  // the stored one; a provided one replaces it.
  const providedKey = typeof reqBody.apiKey === "string" ? reqBody.apiKey.trim() : "";
  if (created && !providedKey) {
    return { http: 400, body: { status: "error", message: "apiKey is required to create an engine" }, patched: false };
  }

  const block: Record<string, any> = { ...(existing ?? {}) };
  block.impl = "openai";
  block.baseUrl = reqBody.baseUrl.trim();
  if (providedKey) block.apiKey = providedKey; // else: keep existing key
  if (typeof reqBody.model === "string" && reqBody.model.trim()) block.model = reqBody.model.trim();
  if (typeof reqBody.temperature === "number") block.temperature = reqBody.temperature;
  else delete block.temperature;
  if (reqBody.headers && typeof reqBody.headers === "object" && !Array.isArray(reqBody.headers)) {
    block.headers = reqBody.headers;
  }
  // Drop any stale external-module specifier — this is an impl engine now.
  delete block.module;

  cfg.engines[name] = block;
  writeConfigToDisk(cfg);
  return { http: 200, body: { status: "ok", needsRestart: true, created }, patched: true };
}

// ---- Guardrail (single policy pack) ----------------------------------------

export interface SetGuardrailRequest {
  /** "none" clears the policy (falls back to no-op allow-all); "sample" writes
   *  the built-in policy from the flat form fields; "module" writes an external
   *  plugin specifier plus a raw JSON config. */
  policy: "none" | "sample" | "module";
  // sample fields
  allowUsers?: string[];
  denyKeywords?: string[];
  denyReason?: string;
  approvalTools?: string[];
  approvers?: string[];
  approvalReason?: string;
  auditSink?: "log" | "http";
  auditEndpoint?: string;
  // module fields
  module?: string;
  config?: Record<string, unknown>;
}

/** Coerce an unknown to a clean string[] (trim, drop empties, dedupe-preserving). */
function cleanStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== "string") continue;
    const t = x.trim();
    if (t) out.push(t);
  }
  return out;
}

/**
 * Write the single `guardrails` policy block. Unlike installPlugin this does NOT
 * run `pnpm add` for the "sample" / "none" paths — the sample policy is in-tree
 * (impl:"sample"). The "module" path validates the specifier with the SAME
 * validateModuleSpec used by install (external plugins still require the package
 * to be installed separately). Always needsRestart (the guardrail is built once
 * at boot). The audit endpoint is stored but NEVER echoed back.
 */
export function setGuardrail(
  reqBody: SetGuardrailRequest,
): { http: number; body: { status: string; message?: string; needsRestart?: boolean; policy?: string }; patched: boolean } {
  const policy = reqBody?.policy;
  if (policy !== "none" && policy !== "sample" && policy !== "module") {
    return { http: 400, body: { status: "error", message: "policy must be none|sample|module" }, patched: false };
  }

  const cfg = readConfigFromDisk();

  if (policy === "none") {
    // Clear the policy entirely → no-op allow-all.
    delete cfg.guardrails;
    writeConfigToDisk(cfg);
    return { http: 200, body: { status: "ok", needsRestart: true, policy: "none" }, patched: true };
  }

  if (policy === "sample") {
    const allowUsers = cleanStrings(reqBody.allowUsers);
    const denyKeywords = cleanStrings(reqBody.denyKeywords).map((s) => s.toLowerCase());
    const approvalTools = cleanStrings(reqBody.approvalTools);
    const approvers = cleanStrings(reqBody.approvers);
    const auditSink = reqBody.auditSink === "http" ? "http" : "log";
    const auditEndpoint = typeof reqBody.auditEndpoint === "string" ? reqBody.auditEndpoint.trim() : "";

    if (auditSink === "http") {
      if (!isHttpUrl(auditEndpoint)) {
        return { http: 400, body: { status: "error", message: "auditSink=http は http(s) の endpoint が必要です" }, patched: false };
      }
    }

    const config: Record<string, any> = {};
    if (allowUsers.length) config.allowUsers = allowUsers;
    if (denyKeywords.length) {
      config.deny = [
        {
          contains: denyKeywords,
          reason:
            typeof reqBody.denyReason === "string" && reqBody.denyReason.trim()
              ? reqBody.denyReason.trim()
              : "危険な操作をブロックしました",
        },
      ];
    }
    if (approvalTools.length) {
      config.requireApproval = [
        {
          tools: approvalTools,
          ...(approvers.length ? { approvers } : {}),
          reason:
            typeof reqBody.approvalReason === "string" && reqBody.approvalReason.trim()
              ? reqBody.approvalReason.trim()
              : "書き込み操作には承認が必要です",
        },
      ];
    }
    config.audit = { sink: auditSink, ...(auditSink === "http" ? { endpoint: auditEndpoint } : {}) };

    cfg.guardrails = { impl: "sample", config };
    writeConfigToDisk(cfg);
    return { http: 200, body: { status: "ok", needsRestart: true, policy: "sample" }, patched: true };
  }

  // policy === "module": external plugin specifier + raw JSON config.
  const mv = validateModuleSpec(reqBody.module);
  if (!mv.ok) {
    return { http: 400, body: { status: "error", message: `invalid module: ${mv.reason}` }, patched: false };
  }
  if (reqBody.config !== undefined && (typeof reqBody.config !== "object" || reqBody.config === null || Array.isArray(reqBody.config))) {
    return { http: 400, body: { status: "error", message: "config must be a JSON object" }, patched: false };
  }
  const block: Record<string, any> = { module: (reqBody.module as string).trim() };
  if (reqBody.config && typeof reqBody.config === "object") block.config = reqBody.config;
  cfg.guardrails = block;
  writeConfigToDisk(cfg);
  return { http: 200, body: { status: "ok", needsRestart: true, policy: "module" }, patched: true };
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
