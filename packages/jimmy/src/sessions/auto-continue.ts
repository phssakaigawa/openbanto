import type { EngineResult, JinnConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";

/**
 * Bounded auto-continuation for turns an engine mechanically flagged as
 * ended-mid-workflow (EngineResult.incomplete): the tool-round or context
 * budget ran out and the closing text came from the summary round, so the
 * task is likely unfinished even though real work already executed.
 *
 * Both gateway paths (connector sessions in sessions/manager.ts and
 * web/employee sessions in gateway/api.ts) drive the same loop: re-run the
 * engine on the SAME session with a continuation prompt that carries the
 * authoritative executed-tool record — the same anti-duplication contract as
 * the engine's own summary round — until the model completes organically or
 * the limit is reached. The precedent for continuation-instead-of-resend is
 * sessions.retryInteractiveTimeout.
 */

export const DEFAULT_AUTO_CONTINUE_LIMIT = 2;

/** Effective continuation limit: sessions.autoContinueLimit, default 2, clamped to 0..10. */
export function autoContinueLimit(config?: JinnConfig): number {
  const raw = config?.sessions?.autoContinueLimit;
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_AUTO_CONTINUE_LIMIT;
  return Math.max(0, Math.min(10, Math.floor(raw)));
}

/** A turn qualifies for continuation only when the engine flagged it AND it is not an error turn. */
export function isIncompleteTurn(result: EngineResult): boolean {
  return result.incomplete === true && !result.error;
}

/**
 * The continuation prompt. Carries the executed-tool record so the continued
 * turn treats prior work as done instead of re-running side-effecting calls
 * (the "comments pasted twice" class of accident).
 */
export function buildContinuationPrompt(
  attempt: number,
  limit: number,
  executed: Array<{ name: string; ok: boolean }>,
): string {
  const digest = executed
    .slice(-60)
    .map((c) => `- ${c.name}: ${c.ok ? "ok" : "FAILED"}`)
    .join("\n");
  return (
    `(system note — auto-continuation ${attempt}/${limit}) The previous turn ended mid-workflow before the task was finished. ` +
    `Continue the SAME task now and complete the remaining work.\n` +
    (digest
      ? `This is the authoritative record of the tool calls that ALREADY EXECUTED in the previous turn(s) of this task. ` +
        `Treat everything marked ok as done — do NOT run it again:\n${digest}\n`
      : "") +
    `Only perform the remaining work. When everything is done, write the final report for the requester ` +
    `in the same language as the original request.`
  );
}

/**
 * Drive up to `limit` continuation turns. `runTurn` executes one engine turn
 * with the given continuation prompt (`prev` is the immediately preceding
 * result — use `prev.sessionId` to resume). `onIntermediate` observes each
 * partial result BEFORE its continuation runs (e.g. to persist it to the
 * session log); its errors never break the loop.
 *
 * Returns the final result with cost/turn/duration accounting summed across
 * all turns and the cumulative executed-tool record attached. When the limit
 * is reached with the turn still incomplete, the last (partial) result is
 * returned as-is for the caller to deliver — same behavior as before this
 * feature existed.
 */
export async function autoContinueIncompleteTurn(
  label: string,
  first: EngineResult,
  limit: number,
  runTurn: (continuationPrompt: string, prev: EngineResult, attempt: number) => Promise<EngineResult>,
  onIntermediate?: (partial: EngineResult, attempt: number) => void,
): Promise<EngineResult> {
  let result = first;
  if (limit <= 0 || !isIncompleteTurn(first)) return result;

  const executed: Array<{ name: string; ok: boolean }> = [...(first.executedToolCalls ?? [])];
  let costSum = first.cost ?? 0;
  let turnsSum = first.numTurns ?? 0;
  let durationSum = first.durationMs ?? 0;

  let attempt = 0;
  while (isIncompleteTurn(result) && attempt < limit) {
    attempt++;
    try {
      onIntermediate?.(result, attempt);
    } catch (e: unknown) {
      logger.warn(`${label}: auto-continuation observer failed: ${e instanceof Error ? e.message : e}`);
    }
    logger.info(`${label}: turn ended mid-workflow — auto-continuing (${attempt}/${limit})`);
    const next = await runTurn(buildContinuationPrompt(attempt, limit, executed), result, attempt);
    executed.push(...(next.executedToolCalls ?? []));
    costSum += next.cost ?? 0;
    turnsSum += next.numTurns ?? 0;
    durationSum += next.durationMs ?? 0;
    result = next;
  }

  if (isIncompleteTurn(result)) {
    logger.warn(`${label}: still mid-workflow after ${limit} auto-continuation(s) — delivering the partial report`);
  }
  if (result !== first) {
    result = {
      ...result,
      ...(costSum > 0 ? { cost: costSum } : {}),
      ...(turnsSum > 0 ? { numTurns: turnsSum } : {}),
      ...(durationSum > 0 ? { durationMs: durationSum } : {}),
      ...(executed.length > 0 ? { executedToolCalls: executed } : {}),
    };
  }
  return result;
}
