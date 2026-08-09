import { describe, it, expect, vi } from "vitest";
import { InteractiveClaudeEngine } from "../claude-interactive.js";
import { PtyLifecycleManager } from "../pty-lifecycle.js";
import { HookRegistry } from "../../gateway/hook-registry.js";
import type { EngineRunOpts, EngineResult, InterruptibleEngine } from "../../shared/types.js";

/**
 * OpenRyoko-specific: the interactive PTY engine runs Claude LOCALLY (for the Max
 * subsidy), so it cannot drive a remote engine over SSH. When opts.sshHost is set
 * it must delegate to the headless `claude -p` fallback, and route kill/isAlive/
 * killAll there too. These cover that adaptation (not present upstream).
 */
function makeFakeFallback() {
  const calls: { run: EngineRunOpts[]; kill: string[]; killAll: number; isAlive: string[] } = {
    run: [], kill: [], killAll: 0, isAlive: [],
  };
  const engine: InterruptibleEngine = {
    name: "claude",
    run: async (opts: EngineRunOpts): Promise<EngineResult> => {
      calls.run.push(opts);
      return { sessionId: "remote-sess", result: "from remote" };
    },
    kill: (sessionId: string) => { calls.kill.push(sessionId); },
    isAlive: (sessionId: string) => { calls.isAlive.push(sessionId); return true; },
    killAll: () => { calls.killAll += 1; },
  };
  return { engine, calls };
}

function makeEngine(fallback?: InterruptibleEngine) {
  const lifecycle = new PtyLifecycleManager({ maxLivePtys: 4 });
  const registry = new HookRegistry();
  const engine = new InteractiveClaudeEngine(lifecycle, registry, fallback);
  return { engine, lifecycle, registry };
}

describe("InteractiveClaudeEngine SSH remote fallback", () => {
  it("delegates run() to the fallback when sshHost is set", async () => {
    const { engine: fallback, calls } = makeFakeFallback();
    const { engine, registry } = makeEngine(fallback);

    const result = await engine.run({
      prompt: "hi",
      cwd: "/tmp",
      sshHost: "my-host",
      sessionId: "s1",
    } as EngineRunOpts);

    expect(result.result).toBe("from remote");
    expect(calls.run).toHaveLength(1);
    expect(calls.run[0].sshHost).toBe("my-host");
    registry.dispose();
  });

  it("does NOT delegate run() when sshHost is absent (would use local PTY)", async () => {
    const { engine: fallback, calls } = makeFakeFallback();
    const { engine, registry } = makeEngine(fallback);

    // No sshHost → must NOT hit the fallback. We don't actually spawn a PTY here;
    // just assert the fallback's run was never called for a local turn. Guard the
    // local path by giving it a session already "active" so run() returns early.
    (engine as unknown as { active: Map<string, unknown> }).active.set("s2", {});
    await engine.run({ prompt: "hi", cwd: "/tmp", sessionId: "s2" } as EngineRunOpts);

    expect(calls.run).toHaveLength(0);
    registry.dispose();
  });

  it("routes kill/isAlive/killAll to the fallback too", () => {
    const { engine: fallback, calls } = makeFakeFallback();
    const { engine, registry } = makeEngine(fallback);

    engine.kill("s3", "Interrupted: test");
    expect(calls.kill).toContain("s3");

    expect(engine.isAlive("s4")).toBe(true);
    expect(calls.isAlive).toContain("s4");

    engine.killAll();
    expect(calls.killAll).toBe(1);
    registry.dispose();
  });

  it("works without a fallback (local-only) — kill/isAlive/killAll are safe no-ops", () => {
    const { engine, registry } = makeEngine(undefined);
    expect(() => engine.kill("x")).not.toThrow();
    expect(engine.isAlive("x")).toBe(false);
    expect(() => engine.killAll()).not.toThrow();
    registry.dispose();
  });
});
