import { describe, it, expect } from "vitest";
import { SsePtyProxy, type StreamCtx } from "../sse-pty-proxy.js";

// Locks the main-vs-sub-agent classifier. The live bug: Claude Code fires
// AUXILIARY requests (haiku topic/title detection, quota checks) through the same
// per-PTY proxy. Those have no `tools`. If one set the main fingerprint (or simply
// differed from it), every real turn's request was tagged as a "sub-agent" → a
// card spawned per message/tool call. The fix gates classification on a non-empty
// `tools` array.

/** classifyRequest is private; reach it directly for a focused unit test. */
function classify(proxy: SsePtyProxy, body: unknown): StreamCtx {
  return (proxy as unknown as { classifyRequest(b: Buffer): StreamCtx })
    .classifyRequest(Buffer.from(JSON.stringify(body)));
}

const TOOLS = [{ name: "Bash", description: "run", input_schema: { type: "object" } }];

function newProxy(): SsePtyProxy {
  return new SsePtyProxy("test", () => {});
}

describe("SsePtyProxy.classifyRequest", () => {
  it("never tags an auxiliary (no-tools) request, even with a novel system", () => {
    const proxy = newProxy();
    const aux = { system: "Detect if this is a new topic.", messages: [{ role: "user", content: "hi" }] };
    expect(classify(proxy, aux)).toEqual({});
  });

  it("an auxiliary request does NOT poison the main fingerprint", () => {
    const proxy = newProxy();
    // Aux lands first (the poisoning scenario) — must be ignored...
    classify(proxy, { system: "topic-detector", messages: [], tools: [] });
    // ...so the first TOOL-BEARING request becomes main (untagged), and the next
    // identical main turn stays main (no spurious card).
    const main = { system: "MAIN", messages: [{ role: "user", content: "do x" }], tools: TOOLS };
    expect(classify(proxy, main)).toEqual({});
    expect(classify(proxy, main)).toEqual({});
  });

  it("tags a tool-bearing request whose system differs from main as a sub-agent", () => {
    const proxy = newProxy();
    classify(proxy, { system: "MAIN", messages: [{ role: "user", content: "main task" }], tools: TOOLS });
    const sub = { system: "SUBAGENT", messages: [{ role: "user", content: "find all bugs" }], tools: TOOLS };
    const ctx = classify(proxy, sub);
    expect(ctx.subAgent).toBeTruthy();
    expect(ctx.subAgent?.label).toBe("find all bugs");
    // Stable id across the sub-agent's turns.
    expect(classify(proxy, sub).subAgent?.id).toBe(ctx.subAgent?.id);
  });

  it("does not tag main-agent tool rounds (stable system) as sub-agents", () => {
    const proxy = newProxy();
    const main = { system: "MAIN", messages: [{ role: "user", content: "x" }], tools: TOOLS };
    classify(proxy, main); // sets main fp
    for (let i = 0; i < 5; i++) expect(classify(proxy, main)).toEqual({});
  });
});
