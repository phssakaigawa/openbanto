import { describe, it, expect, vi } from "vitest";
import {
  autoContinueIncompleteTurn,
  autoContinueLimit,
  buildContinuationPrompt,
  isIncompleteTurn,
  DEFAULT_AUTO_CONTINUE_LIMIT,
} from "../auto-continue.js";
import type { EngineResult, JinnConfig } from "../../shared/types.js";

function res(partial: Partial<EngineResult>): EngineResult {
  return { sessionId: "s1", result: "", ...partial };
}

function cfg(limit?: number): JinnConfig {
  return { sessions: limit === undefined ? {} : { autoContinueLimit: limit } } as JinnConfig;
}

describe("autoContinueLimit", () => {
  it("defaults to 2 and clamps to 0..10", () => {
    expect(autoContinueLimit(undefined)).toBe(DEFAULT_AUTO_CONTINUE_LIMIT);
    expect(autoContinueLimit(cfg())).toBe(2);
    expect(autoContinueLimit(cfg(3))).toBe(3);
    expect(autoContinueLimit(cfg(0))).toBe(0);
    expect(autoContinueLimit(cfg(-5))).toBe(0);
    expect(autoContinueLimit(cfg(99))).toBe(10);
    expect(autoContinueLimit(cfg(Number.NaN))).toBe(2);
  });
});

describe("isIncompleteTurn", () => {
  it("requires the incomplete flag and no error", () => {
    expect(isIncompleteTurn(res({ incomplete: true }))).toBe(true);
    expect(isIncompleteTurn(res({}))).toBe(false);
    expect(isIncompleteTurn(res({ incomplete: true, error: "boom" }))).toBe(false);
  });
});

describe("buildContinuationPrompt", () => {
  it("carries the executed-tool record and the no-repeat instruction", () => {
    const p = buildContinuationPrompt(1, 2, [
      { name: "fetcher__fetch_page", ok: true },
      { name: "nextcloud__upload", ok: false },
    ]);
    expect(p).toContain("auto-continuation 1/2");
    expect(p).toContain("- fetcher__fetch_page: ok");
    expect(p).toContain("- nextcloud__upload: FAILED");
    expect(p).toContain("do NOT run it again");
  });

  it("omits the record block when nothing executed", () => {
    const p = buildContinuationPrompt(2, 3, []);
    expect(p).toContain("auto-continuation 2/3");
    expect(p).not.toContain("ALREADY EXECUTED");
  });
});

describe("autoContinueIncompleteTurn", () => {
  it("returns the first result untouched when the turn is complete", async () => {
    const runTurn = vi.fn();
    const first = res({ result: "done" });
    const out = await autoContinueIncompleteTurn("t", first, 2, runTurn);
    expect(out).toBe(first);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("does nothing when the limit is 0", async () => {
    const runTurn = vi.fn();
    const first = res({ incomplete: true, result: "partial" });
    const out = await autoContinueIncompleteTurn("t", first, 0, runTurn);
    expect(out).toBe(first);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("continues until the model completes organically", async () => {
    const first = res({
      incomplete: true,
      result: "phase 1 partial",
      cost: 1,
      numTurns: 1,
      executedToolCalls: [{ name: "a", ok: true }],
    });
    const runTurn = vi
      .fn()
      .mockResolvedValueOnce(
        res({ incomplete: true, result: "phase 2 partial", cost: 2, numTurns: 1, executedToolCalls: [{ name: "b", ok: true }] }),
      )
      .mockResolvedValueOnce(res({ result: "all phases done", cost: 3, numTurns: 1 }));
    const intermediates: string[] = [];
    const out = await autoContinueIncompleteTurn("t", first, 3, runTurn, (p) => {
      intermediates.push(p.result);
    });
    expect(runTurn).toHaveBeenCalledTimes(2);
    // 1st continuation prompt carries turn-1's record; 2nd carries turns 1+2.
    expect(runTurn.mock.calls[0][0]).toContain("- a: ok");
    expect(runTurn.mock.calls[1][0]).toContain("- a: ok");
    expect(runTurn.mock.calls[1][0]).toContain("- b: ok");
    // prev result is threaded so the caller can resume the right session.
    expect(runTurn.mock.calls[0][1].result).toBe("phase 1 partial");
    expect(runTurn.mock.calls[1][1].result).toBe("phase 2 partial");
    expect(intermediates).toEqual(["phase 1 partial", "phase 2 partial"]);
    expect(out.result).toBe("all phases done");
    expect(out.incomplete).toBeUndefined();
    // Accounting merged across all three turns.
    expect(out.cost).toBe(6);
    expect(out.numTurns).toBe(3);
    expect(out.executedToolCalls).toEqual([
      { name: "a", ok: true },
      { name: "b", ok: true },
    ]);
  });

  it("stops at the limit and returns the last partial result", async () => {
    const first = res({ incomplete: true, result: "p1" });
    const runTurn = vi
      .fn()
      .mockResolvedValue(res({ incomplete: true, result: "still partial" }));
    const out = await autoContinueIncompleteTurn("t", first, 2, runTurn);
    expect(runTurn).toHaveBeenCalledTimes(2);
    expect(out.result).toBe("still partial");
    expect(out.incomplete).toBe(true);
  });

  it("stops when a continuation turn errors", async () => {
    const first = res({ incomplete: true, result: "p1" });
    const runTurn = vi
      .fn()
      .mockResolvedValue(res({ incomplete: true, error: "HTTP 500", result: "" }));
    const out = await autoContinueIncompleteTurn("t", first, 3, runTurn);
    expect(runTurn).toHaveBeenCalledTimes(1);
    expect(out.error).toBe("HTTP 500");
  });

  it("keeps looping when the intermediate observer throws", async () => {
    const first = res({ incomplete: true, result: "p1" });
    const runTurn = vi.fn().mockResolvedValue(res({ result: "done" }));
    const out = await autoContinueIncompleteTurn("t", first, 2, runTurn, () => {
      throw new Error("observer boom");
    });
    expect(out.result).toBe("done");
  });
});
