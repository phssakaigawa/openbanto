// Guardrail plugin registry (registry + built-in no-op default + external
// plugin loading). The guardrail counterpart of connectors/registry.ts and
// engines/registry.ts.
//
// Goal: make per-turn permission / approval / audit policy pluggable the same
// way connectors and engines are. Guardrails are a CORE concern — they must sit
// on the turn path for every engine and connector — so the core owns the two
// hook points (sessions/manager.ts) and this loader; an external plugin supplies
// the policy that runs in the hooks.
//
// The type surface here mirrors @openbanto/guardrail-sdk exactly (structurally
// identical), so an external plugin built against the SDK is assignable at the
// dynamic-import boundary — but the core keeps its own copy so it never takes a
// runtime dependency on the SDK package (same pattern as connectors/registry.ts
// and engines/registry.ts).
//
// See docs/design/guardrails-hooks.md and the BANTO-PORT-PLAN §H.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { logger } from "../shared/logger.js";

/** One turn's worth of context handed to a guardrail. Mirrors the SDK. */
export interface GuardrailContext {
  sessionKey: string;
  connector: string;
  channel: string;
  userId: string;
  userName: string;
  employee?: string;
  engine: string;
  text: string;
  toolbelt: string[];
}

/** beforeTurn's return. Mirrors the SDK. */
export type GuardrailDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "require_approval"; approvers?: string[]; reason?: string };

/** Structured turn outcome handed to afterTurn. Mirrors the SDK. */
export interface GuardrailTurnResult {
  ok: boolean;
  cost?: number;
  tokens?: number;
  error?: string;
  toolWrites?: string[];
}

/** A guardrail INSTANCE. Mirrors the SDK. */
export interface Guardrail {
  beforeTurn(ctx: GuardrailContext): Promise<GuardrailDecision> | GuardrailDecision;
  afterTurn(ctx: GuardrailContext, result: GuardrailTurnResult): void | Promise<void>;
}

/** Context handed to a plugin's create(). Heavy deps are imported lazily inside. */
export interface GuardrailPluginContext {
  logger: typeof logger;
  config: Record<string, any>;
}

export interface GuardrailPlugin {
  name: string;
  create(cfg: Record<string, any>, ctx: GuardrailPluginContext): Promise<Guardrail> | Guardrail;
}

/** The built-in "allow-all" guardrail: installed when no plugin is configured.
 *  beforeTurn always allows; afterTurn is a no-op. Guardrails are opt-in, so the
 *  absence of a policy pack must be behaviourally identical to "no guardrail". */
const NOOP_GUARDRAIL: Guardrail = {
  beforeTurn() {
    return { action: "allow" };
  },
  afterTurn() {
    /* no-op audit sink */
  },
};

const NOOP_PLUGIN: GuardrailPlugin = {
  name: "noop",
  create() {
    return NOOP_GUARDRAIL;
  },
};

// ---- `impl`-selected built-in policy packs ---------------------------------
// A guardrail block may name a shared IN-TREE IMPLEMENTATION rather than an
// external `module`: `guardrails.impl = "sample"`. This is the second resolution
// path (mirroring engines/registry.ts `IMPL_PLUGINS` / `engineImplOf`): it lets
// an operator turn on a real, config-driven policy pack from the Web form without
// running `pnpm add`. The lazy factory keeps the module out of the graph until an
// impl guardrail is actually configured.

const IMPL_PLUGINS: Record<string, () => Promise<GuardrailPlugin>> = {
  sample: async () => (await import("./sample.plugin.js")).default,
};

/** Known guardrail impl names (config `guardrails.impl` values). */
export const GUARDRAIL_IMPL_NAMES = ["sample"] as const;

/** The `impl` a guardrail block selects (e.g. "sample"), or undefined. */
export function guardrailImplOf(block: unknown): string | undefined {
  if (block && typeof block === "object") {
    const impl = (block as { impl?: unknown }).impl;
    if (typeof impl === "string" && impl in IMPL_PLUGINS) return impl;
  }
  return undefined;
}

/**
 * Resolve the guardrail plugin. Three paths, in order (mirroring resolveEngine):
 *  1. external `module` specifier → dynamic import (load failure ⇒ install hint);
 *  2. `impl: "sample"` in the block → shared in-tree implementation;
 *  3. neither → the built-in no-op "allow-all" plugin (guardrails are opt-in).
 *
 * The argument accepts either the whole `guardrails` block (preferred) or, for
 * backward compatibility, just the `module` string.
 */
export async function resolveGuardrail(
  blockOrModule?: string | { module?: string; impl?: string; config?: Record<string, any> },
): Promise<GuardrailPlugin> {
  const block: { module?: string; impl?: string } | undefined =
    typeof blockOrModule === "string" ? { module: blockOrModule } : blockOrModule;

  // (1) external module plugin.
  if (block?.module) {
    const module = block.module;
    const mod = await import(module).catch(() => {
      throw new Error(
        `Guardrail plugin "${module}" could not be loaded. Install it: npm i ${module}`,
      );
    });
    return (mod.default ?? mod) as GuardrailPlugin;
  }

  // (2) impl-selected built-in policy pack (e.g. sample).
  const impl = guardrailImplOf(block);
  if (impl) return IMPL_PLUGINS[impl]();

  // (3) opt-in default: no policy ⇒ allow-all.
  return NOOP_PLUGIN;
}

/** Authoring helper mirroring @openbanto/guardrail-sdk's `defineGuardrailPlugin`
 *  — identity function that type-checks a plugin object against the contract.
 *  Built-in reference plugins (example.plugin.ts) use this so they read exactly
 *  like an external SDK plugin would. */
export function defineGuardrailPlugin(plugin: GuardrailPlugin): GuardrailPlugin {
  return plugin;
}
