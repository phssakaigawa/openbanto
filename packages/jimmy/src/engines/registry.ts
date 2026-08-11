// Engine plugin registry (Phase 1+2: registry + capability table + lazy built-ins
// + external plugin loading). The engine counterpart of connectors/registry.ts.
//
// Goal: generalise LLM engines the same way connectors were generalised. Instead
// of `new ClaudeEngine()` / `new BobEngine()` hard-coded in gateway/server.ts and
// `engine === "claude"` scattered across the codebase, engines register here as
// lazy plugins that declare their capabilities. The gateway builds its engine map
// by looping over configured engines and calling resolveEngine(); behavioural
// name-checks (interactive / fork / syncResume) read capabilities() instead.
//
// The type surface here mirrors @openbanto/engine-sdk exactly (structurally
// identical), so an external plugin built against the SDK is assignable at the
// dynamic-import boundary — but the core keeps its own copy so it never takes a
// runtime dependency on the SDK package (same pattern as connectors/registry.ts).
//
// See docs/design/engine-plugins.md.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { InterruptibleEngine, JinnConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";

/** How an engine conveys reasoning-effort. Mirrors the SDK. */
export type EngineEffortMechanism = "none" | "flag" | "model";

/** Static, declarative facts the core consults instead of `engine === "claude"`. */
export interface EngineCapabilities {
  transport: "cli" | "http";
  interactive: boolean;
  supportsFork: boolean;
  syncResume: boolean;
  usableAsFallback: boolean;
  usableAsOneShot: boolean;
  models: string[];
  effort: EngineEffortMechanism;
}

/** Context handed to a plugin's create(). Heavy deps are imported lazily inside. */
export interface EngineContext {
  logger: typeof logger;
  config: JinnConfig;
}

export interface EnginePlugin {
  name: string;
  capabilities: EngineCapabilities;
  defaultBin?: string;
  /** Heavy deps are dynamic-imported inside create(); may be async. */
  create(cfg: Record<string, any>, ctx: EngineContext): Promise<InterruptibleEngine> | InterruptibleEngine;
}

// ---- Built-in plugins (lazy factories) -------------------------------------
// Each entry dynamic-imports the engine module only when invoked, keeping the
// class construction lazy. bob is expressed through the SDK-shaped
// defineEnginePlugin wrapper (bob.plugin.ts) as the reference first engine; the
// others are declared inline for now (their capability tables live here so the
// synchronous capability lookups below don't have to import the modules).

const BUILTINS: Record<string, () => Promise<EnginePlugin>> = {
  bob: async () => (await import("./bob.plugin.js")).default,
  claude: async () => ({
    name: "claude",
    capabilities: CAPABILITIES.claude,
    defaultBin: "claude",
    async create(_cfg, ctx) {
      // Interactive PTY Claude replaces the headless engine under the same
      // "claude" key when enabled; the gateway owns that wiring (it needs the
      // PtyLifecycleManager / HookRegistry), so here we always build the
      // headless engine. gateway/server.ts swaps in the interactive one.
      void ctx;
      const { ClaudeEngine } = await import("./claude.js");
      return new ClaudeEngine();
    },
  }),
  codex: async () => ({
    name: "codex",
    capabilities: CAPABILITIES.codex,
    defaultBin: "codex",
    async create() {
      const { CodexEngine } = await import("./codex.js");
      return new CodexEngine();
    },
  }),
  gemini: async () => ({
    name: "gemini",
    capabilities: CAPABILITIES.gemini,
    defaultBin: "gemini",
    async create() {
      const { GeminiEngine } = await import("./gemini.js");
      return new GeminiEngine();
    },
  }),
};

// ---- `impl`-selected plugins ------------------------------------------------
// A config engine block may name a shared IMPLEMENTATION rather than being a
// built-in name or an external module: `engines.aidea = { impl: "openai", … }`.
// This is the third resolution path (see resolveEngine). It lets an operator
// declare MANY named engines (aidea, kannon, …) that all share one in-tree
// implementation, each with its own baseUrl/apiKey/model. The lazy factories
// mirror BUILTINS; their capability tables live in IMPL_CAPABILITIES.

const IMPL_PLUGINS: Record<string, () => Promise<EnginePlugin>> = {
  openai: async () => (await import("./openai.plugin.js")).default,
};

/** Capability tables for `impl`-selected engines, keyed by impl name (not by the
 *  config engine name). engineCapabilities()/CAPABILITIES resolve through this
 *  when a name isn't a built-in but its block declares an impl. */
export const IMPL_CAPABILITIES: Record<string, EngineCapabilities> = {
  openai: {
    transport: "http",
    interactive: false,
    supportsFork: false,
    syncResume: false,
    usableAsFallback: false,
    usableAsOneShot: false,
    models: [],
    effort: "none",
  },
};

/** Known impl names (config `engines.<name>.impl` values). */
export const ENGINE_IMPL_NAMES = ["openai"] as const;

/** True when a config engine block selects a shared impl (e.g. `impl: "openai"`). */
export function engineImplOf(block: unknown): string | undefined {
  if (block && typeof block === "object") {
    const impl = (block as { impl?: unknown }).impl;
    if (typeof impl === "string" && impl in IMPL_PLUGINS) return impl;
  }
  return undefined;
}

/**
 * Static capability table for the built-in engines. Kept separate from the lazy
 * factories so the core can answer capability questions (interactive? fork?
 * syncResume?) synchronously without constructing — or even importing — the
 * engine. External plugins carry their capabilities on the resolved plugin
 * object instead; `engineCapabilities()` covers both.
 */
export const CAPABILITIES: Record<string, EngineCapabilities> = {
  // IBM Bob: model bound to the team/API key, one-shot `bob run` per turn.
  bob: {
    transport: "cli",
    interactive: false,
    supportsFork: false,
    syncResume: false,
    usableAsFallback: true,
    usableAsOneShot: true,
    models: [],
    effort: "none",
  },
  // Claude Code: the rich one — interactive PTY, forkable, resumable/syncable,
  // the primary engine (not itself a fallback target).
  claude: {
    transport: "cli",
    interactive: true,
    supportsFork: true,
    syncResume: true,
    usableAsFallback: false,
    usableAsOneShot: true,
    models: [],
    effort: "flag",
  },
  codex: {
    transport: "cli",
    interactive: false,
    supportsFork: true,
    syncResume: false,
    usableAsFallback: true,
    usableAsOneShot: true,
    models: [],
    effort: "model",
  },
  gemini: {
    transport: "cli",
    interactive: false,
    supportsFork: true,
    syncResume: false,
    usableAsFallback: false,
    usableAsOneShot: false,
    models: [],
    effort: "none",
  },
};

/** Built-in engine names, in a stable order (mirrors the historic engine map). */
export const BUILTIN_ENGINE_NAMES = ["bob", "claude", "codex", "gemini"] as const;

/**
 * Resolve a plugin for a config engine name. Three paths, in order:
 *  1. built-in name (bob/claude/codex/gemini) → lazy factory;
 *  2. `impl: "openai"` in the block → shared in-tree implementation (many named
 *     instances of one impl);
 *  3. external `module` specifier → dynamic import.
 *
 * The second arg accepts either the whole `engines.<name>` block (preferred) or,
 * for backward compatibility, just the `module` string.
 */
export async function resolveEngine(
  name: string,
  blockOrModule?: string | Record<string, unknown>,
): Promise<EnginePlugin> {
  const builtin = BUILTINS[name];
  if (builtin) return builtin();

  const block: Record<string, unknown> | undefined =
    typeof blockOrModule === "string" ? { module: blockOrModule } : blockOrModule;
  const module = typeof block?.module === "string" ? (block.module as string) : undefined;

  // (2) impl-selected shared implementation (e.g. openai).
  const impl = engineImplOf(block);
  if (impl) return IMPL_PLUGINS[impl]();

  // (3) external module plugin.
  if (module) {
    const mod = await import(module).catch(() => {
      throw new Error(
        `Engine "${name}" needs the plugin package "${module}". Install it: npm i ${module}`,
      );
    });
    return (mod.default ?? mod) as EnginePlugin;
  }
  throw new Error(`Unknown engine "${name}" and no "impl"/"module" given.`);
}

export function hasBuiltinEngine(name: string): boolean {
  return name in BUILTINS;
}

/** Authoring helper mirroring @openbanto/engine-sdk's `defineEnginePlugin` —
 *  identity function that type-checks a plugin object against the contract.
 *  Built-in plugins (e.g. bob.plugin.ts) use this so they read exactly like an
 *  external SDK plugin would. */
export function defineEnginePlugin(plugin: EnginePlugin): EnginePlugin {
  return plugin;
}

/**
 * Synchronous capability lookup used by the core's behavioural branches
 * (interactive / fork / syncResume / fallback / one-shot). Returns the static
 * table entry for a built-in, or undefined for an unknown/external engine — call
 * sites treat undefined as "no special capability" (the conservative default).
 */
export function engineCapabilities(name: string, config?: JinnConfig): EngineCapabilities | undefined {
  const builtin = CAPABILITIES[name];
  if (builtin) return builtin;
  // impl-selected engine (e.g. an aidea/kannon block with impl:"openai"): look
  // up the block in config and return the impl's capability table.
  if (config) {
    const block = (config.engines as unknown as Record<string, unknown>)?.[name];
    const impl = engineImplOf(block);
    if (impl) return IMPL_CAPABILITIES[impl];
  }
  return undefined;
}

/**
 * Resolve the `engines.<name>` config block for an engine name — the single
 * place that used to be a duplicated 4-way ternary in sessions/manager.ts,
 * gateway/api.ts, sessions/context.ts and cli/migrate.ts. Each picked
 * `config.engines.codex | gemini | bob | claude` by name and fell back to the
 * `claude` block for the ones whose block may be absent (gemini/bob).
 *
 * ★ BANTO-PORT-PLAN: this is the bob-critical selection. If bob's block is
 * dropped from the fallback here, `bin` silently reverts to claude's and Bob
 * fails to start. Keep bob (and any external engine) resolving to ITS OWN block.
 */
export function resolveEngineConfig(
  config: JinnConfig,
  engineName: string,
): {
  bin?: string;
  model?: string;
  effortLevel?: string;
  childEffortOverride?: string;
  module?: string;
  impl?: string;
  baseUrl?: string;
  apiKey?: string;
} {
  const engines = config.engines as unknown as Record<string, any>;
  // The engine's own block if present; otherwise fall back to claude's so the
  // caller always has bin/model/effort defaults (claude is always configured).
  return (engines[engineName] as any) ?? engines.claude;
}

/** Convenience predicates over the capability table (undefined → false). */
export function engineIsInteractive(name: string): boolean {
  return CAPABILITIES[name]?.interactive ?? false;
}
export function engineSupportsFork(name: string): boolean {
  return CAPABILITIES[name]?.supportsFork ?? false;
}
export function engineSupportsSyncResume(name: string): boolean {
  return CAPABILITIES[name]?.syncResume ?? false;
}
