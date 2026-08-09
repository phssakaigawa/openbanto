import { describe, it, expect, afterEach } from "vitest";
import { handleHookPost } from "../hook-endpoint.js";
import { HookRegistry } from "../hook-registry.js";

describe("handleHookPost", () => {
  // Track every registry created in this suite so the sweep timer is always
  // disposed — otherwise vitest holds the event loop open between runs.
  const registries: HookRegistry[] = [];
  const makeReg = (): HookRegistry => {
    const r = new HookRegistry();
    registries.push(r);
    return r;
  };
  afterEach(() => {
    while (registries.length > 0) registries.pop()!.dispose();
  });

  it("rejects a wrong secret with 403", () => {
    const reg = makeReg();
    const res = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" },
      "nope", { jinnSessionId: "s1", hook: { hook_event_name: "Stop" } });
    expect(res.status).toBe(403);
  });

  it("rejects a non-loopback remote with 403", () => {
    const reg = makeReg();
    const res = handleHookPost({ reg, secret: "sek", remoteAddress: "10.0.0.5" },
      "sek", { jinnSessionId: "s1", hook: { hook_event_name: "Stop" } });
    expect(res.status).toBe(403);
  });

  it("delivers a valid hook to the registry and returns 200", () => {
    const reg = makeReg();
    const seen: string[] = [];
    reg.register("s1", (h) => seen.push(h.hook_event_name));
    const res = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" },
      "sek", { jinnSessionId: "s1", hook: { hook_event_name: "Stop", last_assistant_message: "hi" } });
    expect(res.status).toBe(200);
    expect(seen).toEqual(["Stop"]);
  });

  it("returns 400 for a malformed body", () => {
    const reg = makeReg();
    const res = handleHookPost({ reg, secret: "sek", remoteAddress: "127.0.0.1" }, "sek", {});
    expect(res.status).toBe(400);
  });

  it("returns 401 when the server secret is empty (defense-in-depth)", () => {
    const reg = makeReg();
    const res = handleHookPost({ reg, secret: "", remoteAddress: "127.0.0.1" },
      "", { jinnSessionId: "s1", hook: { hook_event_name: "Stop" } });
    expect(res.status).toBe(401);
  });
});
