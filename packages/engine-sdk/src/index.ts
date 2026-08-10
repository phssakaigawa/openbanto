/**
 * `@openbanto/engine-sdk`
 *
 * The stable contract an OpenBanto **engine plugin** implements. An engine is
 * the thing that actually runs a turn: it takes a prompt (plus a resumable
 * session id, model, effort level, attachments, …) and produces a reply,
 * optionally streaming deltas as it goes. Today's built-ins spawn a CLI
 * (`claude`, `codex`, `gemini`, `bob`) or drive a PTY; tomorrow's could speak
 * HTTP to a hosted model — the core does not care, it only calls `run()`.
 *
 * External plugins depend on THIS package only — never on the OpenBanto core —
 * so an engine can be published as its own npm package / repo. The core resolves
 * a plugin by dynamic `import(module)` and calls its `create(cfg, ctx)`.
 *
 * These types are intentionally self-contained (no core imports); the core's
 * own equivalents in `packages/jimmy/src/shared/types.ts` are structurally
 * identical, so an engine built against the SDK is assignable at the loader
 * boundary (an `EnginePlugin.create()` result is a valid core
 * `InterruptibleEngine`, and vice-versa).
 *
 * See: https://github.com/phssakaigawa/openbanto/blob/main/docs/design/engine-plugins.md
 */

// ---------------------------------------------------------------------------
// Core turn contract — MUST stay structurally identical to
// packages/jimmy/src/shared/types.ts (Engine / InterruptibleEngine /
// EngineRunOpts / EngineResult / StreamDelta / EngineRateLimitInfo).
// ---------------------------------------------------------------------------

export type StreamDeltaType =
  | "text"
  | "text_snapshot"
  | "tool_use"
  | "tool_result"
  | "status"
  | "error"
  | "context";

export interface StreamDelta {
  type: StreamDeltaType;
  content: string;
  toolName?: string;
  toolId?: string;
  /** Set when this delta belongs to a Task sub-agent (interactive PTY engine).
   *  The chat pane routes tagged deltas into a collapsible sub-agent card instead
   *  of the main transcript. Absent for main-agent deltas. */
  subAgent?: { id: string; label?: string };
}

export interface EngineRunOpts {
  prompt: string;
  resumeSessionId?: string;
  systemPrompt?: string;
  cwd: string;
  bin?: string;
  model?: string;
  effortLevel?: string;
  attachments?: string[];
  /** Extra CLI flags to pass to the engine binary (e.g. ["--chrome"]) */
  cliFlags?: string[];
  /** Path to MCP config JSON file (passed as --mcp-config to Claude Code) */
  mcpConfigPath?: string;
  onStream?: (delta: StreamDelta) => void;
  /** Unique Jinn session ID for tracking the spawned process. */
  sessionId?: string;
  /** If set, run the engine binary on a remote host via SSH instead of locally. */
  sshHost?: string;
  /** Working directory on the remote host (only used when sshHost is set). */
  remoteCwd?: string;
}

export interface EngineRateLimitInfo {
  status?: string;
  /** Unix timestamp in seconds */
  resetsAt?: number;
  rateLimitType?: string;
  overageStatus?: string;
  overageDisabledReason?: string;
  isUsingOverage?: boolean;
}

export interface EngineResult {
  sessionId: string;
  result: string;
  cost?: number;
  durationMs?: number;
  numTurns?: number;
  /**
   * Most recent turn's INPUT context size (input + cache-read + cache-creation
   * tokens) — i.e. how full the context window currently is. Undefined when the
   * engine doesn't surface usage. Powers the context meter in the UI.
   */
  contextTokens?: number;
  error?: string;
  /** Optional rate limit metadata returned by an engine. */
  rateLimit?: EngineRateLimitInfo;
  /**
   * For sessions that span multiple assistant turns, each turn's final text in
   * chronological order. `result` remains the LAST turn's text for backward
   * compatibility.
   */
  turns?: string[];
}

/** The minimum an engine implements: name + run a turn. */
export interface Engine {
  name: string;
  run(opts: EngineRunOpts): Promise<EngineResult>;
}

/**
 * An engine whose turns run as cancellable processes/PTYs. The core needs these
 * hooks to interrupt a running turn and to tear everything down on shutdown.
 * Built-in engines all implement this; an HTTP engine can implement the kill
 * hooks as an in-flight-request abort.
 */
export interface InterruptibleEngine extends Engine {
  /** Kill a running engine process for a specific Jinn session. */
  kill(sessionId: string, reason?: string): void;
  /** Check if a live engine process is still running for this session. */
  isAlive(sessionId: string): boolean;
  /** Kill all live engine processes during gateway shutdown. */
  killAll(): void;
}

// ---------------------------------------------------------------------------
// Plugin surface — the OpenBanto-original wrapper around the turn contract.
// ---------------------------------------------------------------------------

/** How an engine conveys reasoning-effort to its turn.
 *  - 'none'  : no effort concept (bob, gemini)
 *  - 'flag'  : a CLI flag / request field per turn (claude's `--effort`)
 *  - 'model' : effort is baked into the model id (a `-high` variant, etc.) */
export type EngineEffortMechanism = "none" | "flag" | "model";

/**
 * Static, declarative facts about what an engine can do. The core reads these
 * INSTEAD of hard-coding `engine === "claude"` checks: e.g. "does this engine's
 * process survive across turns?" (`interactive`), "can I fork its session?"
 * (`supportsFork`), "can it resume/sync context after a fallback?"
 * (`syncResume`), "is it safe as a rate-limit fallback?" (`usableAsFallback`),
 * "can I use it for a one-shot triage/goal call?" (`usableAsOneShot`).
 */
export interface EngineCapabilities {
  /** 'cli' spawns a binary / PTY; 'http' talks to a remote model endpoint. */
  transport: "cli" | "http";
  /** The engine's process/connection survives across turns (PTY-style). When
   *  false, each turn is a fresh one-shot whose background work dies at turn end. */
  interactive: boolean;
  /** The core can fork a live session into a new branch (see sessions/fork.ts). */
  supportsFork: boolean;
  /** The engine can resume a prior session id and be handed a context-sync
   *  transcript (used by the rate-limit fallback → primary handback path). */
  syncResume: boolean;
  /** Safe to switch TO when the primary engine hits a usage/rate limit. */
  usableAsFallback: boolean;
  /** Usable for short one-shot calls (Slack triage, /goal extraction, migrate). */
  usableAsOneShot: boolean;
  /** Model ids this engine exposes to the picker. Empty when the model is bound
   *  to the account/key (bob) or discovered elsewhere. */
  models: string[];
  /** How effort is conveyed for this engine. */
  effort: EngineEffortMechanism;
}

/** Minimal logger the host provides to plugins. */
export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Context handed to a plugin's `create()`. Heavy provider SDKs (an HTTP client,
 * a PTY lib, …) must be imported lazily INSIDE `create()` so a plugin's
 * dependency is only required when the engine is actually configured.
 */
export interface EngineContext {
  logger: Logger;
  /**
   * The full host config, loosely typed so the SDK stays dependency-free.
   * Most plugins only need their own `cfg` (the first `create()` argument),
   * which is `engines.<name>` from config.yaml.
   */
  config: Record<string, unknown>;
}

/**
 * What an engine plugin module exports as its `default`. The core calls
 * `create()` once to build the engine instance it stores in its engine map.
 */
export interface EnginePlugin {
  /** Engine name this plugin provides (e.g. "bob", "claude", "codex"). */
  name: string;
  /** Static capabilities the core consults instead of name checks. */
  capabilities: EngineCapabilities;
  /** Default binary name, when transport === 'cli'. */
  defaultBin?: string;
  /** Build the engine instance. Heavy deps are dynamic-imported inside here. */
  create(
    cfg: Record<string, unknown>,
    ctx: EngineContext,
  ): Promise<InterruptibleEngine> | InterruptibleEngine;
}

/**
 * Identity helper for plugin authors — wraps a plugin object so TypeScript
 * checks it against the contract at authoring time:
 *
 * ```ts
 * export default defineEnginePlugin({
 *   name: "bob",
 *   capabilities: { transport: "cli", interactive: false, ... },
 *   defaultBin: "bob",
 *   create(cfg, ctx) { return new BobEngine(); },
 * });
 * ```
 */
export function defineEnginePlugin(plugin: EnginePlugin): EnginePlugin {
  return plugin;
}
