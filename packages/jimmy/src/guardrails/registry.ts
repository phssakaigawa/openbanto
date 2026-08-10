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

/**
 * Resolve the guardrail plugin. With no `module` the built-in no-op "allow-all"
 * plugin is returned (guardrails are opt-in). An external `module` specifier is
 * dynamic-imported by name; a load failure is surfaced with an install hint,
 * mirroring resolvePlugin/resolveEngine.
 */
export async function resolveGuardrail(module?: string): Promise<GuardrailPlugin> {
  if (!module) return NOOP_PLUGIN;
  const mod = await import(module).catch(() => {
    throw new Error(
      `Guardrail plugin "${module}" could not be loaded. Install it: npm i ${module}`,
    );
  });
  return (mod.default ?? mod) as GuardrailPlugin;
}

/** Authoring helper mirroring @openbanto/guardrail-sdk's `defineGuardrailPlugin`
 *  — identity function that type-checks a plugin object against the contract.
 *  Built-in reference plugins (example.plugin.ts) use this so they read exactly
 *  like an external SDK plugin would. */
export function defineGuardrailPlugin(plugin: GuardrailPlugin): GuardrailPlugin {
  return plugin;
}
