/**
 * Air-reading triage runner for Slack.
 *
 * Invokes a cheap LLM (Haiku, via Claude Code CLI by default) to decide
 * whether an incoming Slack message should be ignored, acknowledged
 * with an emoji, or replied to with a full engine session.
 *
 * This sits BEFORE the main session manager and prevents the expensive
 * engine from running on messages that don't actually want a reply.
 */

import { spawn } from "node:child_process";
import { logger } from "../../shared/logger.js";
import {
  defaultBinForEngine,
  defaultModelForEngine,
  invokeOneShot,
  type OneShotEngine,
} from "../../shared/oneShotCli.js";
import {
  buildTriagePrompt,
  parseTriageDecision,
  type TriageDecision,
  type TriagePromptInput,
} from "./triage-prompt.js";

export interface TriageRunnerOptions {
  /** CLI engine to use for triage. Defaults to "codex"; "claude" is supported. */
  engine?: OneShotEngine;
  /** Binary to invoke — defaults to the selected engine's CLI. */
  bin?: string;
  /** Model to use for the triage call (e.g. "claude-haiku-4-5" or "gpt-5-nano") */
  model?: string;
  /** Soft timeout before we fall back to the fail-open action */
  timeoutMs?: number;
  /** Override the spawner (for tests) */
  spawnImpl?: typeof spawn;
  /**
   * Action to fall back to when triage itself fails (timeout / spawn error /
   * unparseable output). Defaults to "reply" because in the most dangerous
   * scenario — our bot_user_id didn't load and so @-mentions silently slip
   * through to triage — missing a real question is worse than a stray reply.
   *
   * Callers that *know* the message is ambient (not a DM, not an @-mention,
   * not addressed to us) should pass "silent" instead: in that path a
   * fail-open reply is guaranteed to barge into someone else's conversation.
   */
  failOpenAction?: "reply" | "silent";
}

// Triage spawns a CLI which has a 3–5s startup overhead before it
// even hits the API; combined with Haiku latency variance, an 8s budget was
// causing routine timeouts in production. 30s gives headroom for slow days
// while still being short enough that the user notices triage isn't free.
const DEFAULT_TIMEOUT_MS = 30000;

/**
 * Run a triage decision. Never throws — on error returns a fail-open fallback
 * decision ("reply") so a failing triage cannot silently drop a real message.
 * Missing a reply is far worse than an unwanted reply; if triage can't decide,
 * let the full engine through.
 */
export async function runTriage(
  input: TriagePromptInput,
  options: TriageRunnerOptions = {},
): Promise<TriageDecision> {
  const prompt = buildTriagePrompt(input);
  const engine = options.engine ?? "codex";
  const bin = options.bin || defaultBinForEngine(engine);
  const model = options.model || defaultModelForEngine(engine);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnFn = options.spawnImpl || spawn;
  const failOpenAction = options.failOpenAction ?? "reply";

  try {
    const output = await invokeOneShot(prompt, {
      engine,
      bin,
      model,
      timeoutMs,
      spawnFn,
      label: "triage",
    });
    const decision = parseTriageDecision(output);
    if (!decision) {
      logger.warn(`[triage] unparseable output, defaulting to ${failOpenAction.toUpperCase()} (fail-open): ${output.slice(0, 200)}`);
      return { action: failOpenAction, reason: "parse_failed" };
    }
    return decision;
  } catch (err) {
    logger.warn(`[triage] execution failed, defaulting to ${failOpenAction.toUpperCase()} (fail-open): ${err}`);
    return { action: failOpenAction, reason: "triage_error" };
  }
}
