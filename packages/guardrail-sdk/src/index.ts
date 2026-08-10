/**
 * `@openbanto/guardrail-sdk`
 *
 * The stable contract an OpenBanto **guardrail plugin** implements. A guardrail
 * wraps every turn: BEFORE the engine runs it can allow, deny (with a
 * user-facing reason), or require human approval; AFTER the engine runs it
 * receives a structured audit record (who / where / engine / tokens / cost /
 * outcome). This is where per-user permission, rate/scope policy, approval
 * routing and audit sinks live.
 *
 * Guardrails are a **core** concern (they must sit on the turn path for every
 * engine and connector), so the core owns the two hook points and the loader;
 * the plugin supplies the *policy* that runs in the hooks. External plugins
 * depend on THIS package only — never on the OpenBanto core — so a policy pack
 * can be published as its own npm package / repo. The core resolves a plugin by
 * dynamic `import(module)` and calls its `create(cfg, ctx)`.
 *
 * These types are intentionally self-contained (no core imports); the core's
 * own equivalents (packages/jimmy/src/guardrails/registry.ts) are structurally
 * identical, so a plugin built against the SDK is assignable at the loader
 * boundary.
 *
 * See: https://github.com/phssakaigawa/openbanto/blob/main/docs/design/guardrails-hooks.md
 */

/**
 * One turn's worth of context handed to a guardrail's `beforeTurn` / `afterTurn`.
 * All fields are already resolved by the core (identity, routing, engine).
 */
export interface GuardrailContext {
  /** Stable key that groups messages into one conversation/session. */
  sessionKey: string;
  /** Connector instance name/id the turn arrived on (e.g. "slack", "lw-support"). */
  connector: string;
  /** Channel/room the turn belongs to. */
  channel: string;
  /** Stable sender id — the per-user permission key. */
  userId: string;
  /** Human-readable sender name. */
  userName: string;
  /** Which assistant persona/employee this session routes to, if any. */
  employee?: string;
  /** Resolved engine name for this turn (e.g. "claude", "bob"). */
  engine: string;
  /** Inbound prompt text for this turn. */
  text: string;
  /** MCP servers / tools this turn is permitted to use (declared toolbelt). */
  toolbelt: string[];
}

/**
 * What `beforeTurn` returns.
 * - `allow` → the turn proceeds normally.
 * - `deny` → the turn is not run; `reason` is shown to the user.
 * - `require_approval` → the turn is parked until a human approves (or rejects).
 *   `approvers` optionally scopes who may approve; `reason` is shown to the user.
 */
export type GuardrailDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "require_approval"; approvers?: string[]; reason?: string };

/** Structured outcome of a turn, handed to `afterTurn` for the audit record. */
export interface GuardrailTurnResult {
  /** True when the turn produced a normal result (no error). */
  ok: boolean;
  /** Turn cost in USD, if the engine reported it. */
  cost?: number;
  /** Context/usage tokens for the turn, if known. */
  tokens?: number;
  /** Error message when the turn failed. */
  error?: string;
  /** Names of tools that performed writes this turn (MVP: often omitted). */
  toolWrites?: string[];
}

/**
 * A guardrail INSTANCE (one per configured policy pack, built by `create()`).
 * `beforeTurn` gates the turn; `afterTurn` is a fire-and-forget audit sink and
 * MUST NOT throw into the turn (the core wraps it, but be defensive).
 */
export interface Guardrail {
  /** Runs before engine.run(). Deny/approval short-circuit the turn. */
  beforeTurn(ctx: GuardrailContext): Promise<GuardrailDecision> | GuardrailDecision;
  /** Runs after the turn returns. Structured audit sink; never throws into the turn. */
  afterTurn(ctx: GuardrailContext, result: GuardrailTurnResult): void | Promise<void>;
}

/** Minimal logger the host provides to plugins. */
export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Context handed to a plugin's `create()`. Heavy dependencies (an audit client,
 * a policy database driver, …) must be imported lazily INSIDE `create()` so a
 * plugin's dependency is only required when the guardrail is actually configured.
 */
export interface GuardrailPluginContext {
  logger: Logger;
  /**
   * The full host config, loosely typed so the SDK stays dependency-free.
   * Most plugins only need their own `cfg` (the first `create()` argument).
   */
  config: Record<string, unknown>;
}

/**
 * What a guardrail plugin module exports as its `default`. The core calls
 * `create()` once at boot with the `guardrails.config` block.
 */
export interface GuardrailPlugin {
  /** Human-readable name for this guardrail (for logs). */
  name: string;
  create(
    cfg: Record<string, unknown>,
    ctx: GuardrailPluginContext,
  ): Promise<Guardrail> | Guardrail;
}

/**
 * Identity helper for plugin authors — wraps a plugin object so TypeScript
 * checks it against the contract at authoring time:
 *
 * ```ts
 * export default defineGuardrailPlugin({
 *   name: "my-guardrail",
 *   async create(cfg, ctx) { ... }
 * });
 * ```
 */
export function defineGuardrailPlugin(plugin: GuardrailPlugin): GuardrailPlugin {
  return plugin;
}
