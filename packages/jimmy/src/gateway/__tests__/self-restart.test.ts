import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Avoid pulling real logging plumbing.
vi.mock("../../shared/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { armSelfRestart, isRestarting, __resetRestartingForTests } from "../self-restart.js";

describe("armSelfRestart", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetRestartingForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    __resetRestartingForTests();
  });

  it("delivers an injected SIGTERM to the target pid after the delay (never the real process)", () => {
    const kill = vi.fn();
    const res = armSelfRestart({ delayMs: 700, kill, pid: 12345 });
    expect(res).toEqual({ armed: true, already: false });
    expect(isRestarting()).toBe(true);
    // Not yet — the signal is deferred so the HTTP 200 can flush first.
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(700);
    expect(kill).toHaveBeenCalledTimes(1);
    expect(kill).toHaveBeenCalledWith(12345, "SIGTERM");
  });

  it("is single-flight: a second arm while one is in flight is a no-op (409/already)", () => {
    const kill = vi.fn();
    const first = armSelfRestart({ delayMs: 700, kill, pid: 1 });
    const second = armSelfRestart({ delayMs: 700, kill, pid: 1 });
    expect(first).toEqual({ armed: true, already: false });
    expect(second).toEqual({ armed: false, already: true });
    vi.advanceTimersByTime(700);
    // Only the first arming scheduled a kill.
    expect(kill).toHaveBeenCalledTimes(1);
  });

  it("swallows a throwing kill so the timer callback never crashes", () => {
    const kill = vi.fn(() => {
      throw new Error("ESRCH");
    });
    armSelfRestart({ delayMs: 100, kill, pid: 1 });
    expect(() => vi.advanceTimersByTime(100)).not.toThrow();
  });
});
