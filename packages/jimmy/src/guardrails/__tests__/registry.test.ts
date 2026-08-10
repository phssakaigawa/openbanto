import { describe, it, expect } from "vitest";
import { resolveGuardrail } from "../registry.js";
import type { GuardrailContext } from "../registry.js";
import { logger } from "../../shared/logger.js";

const baseCtx: GuardrailContext = {
  sessionKey: "s1",
  connector: "test",
  channel: "c1",
  userId: "u1",
  userName: "Tester",
  engine: "claude",
  text: "",
  toolbelt: [],
};

const pluginCtx = { logger, config: {} };

describe("resolveGuardrail — no-op default", () => {
  it("returns an allow-all guardrail when no module is given", async () => {
    const plugin = await resolveGuardrail();
    expect(plugin.name).toBe("noop");
    const guardrail = await plugin.create({}, pluginCtx);
    const decision = await guardrail.beforeTurn({ ...baseCtx, text: "anything at all" });
    expect(decision).toEqual({ action: "allow" });
    // afterTurn is a no-op — must not throw.
    await expect(
      Promise.resolve(guardrail.afterTurn({ ...baseCtx }, { ok: true })),
    ).resolves.toBeUndefined();
  });
});

describe("resolveGuardrail — example.plugin loaded as a plugin", () => {
  it("allows text with no blocklist hit and denies text containing a blocked term", async () => {
    // Loaded through the SAME loader path an external module would use.
    const plugin = await resolveGuardrail(
      new URL("../example.plugin.ts", import.meta.url).pathname,
    );
    expect(plugin.name).toBe("example");
    const guardrail = await plugin.create({ blocklist: ["secret", "delete production"] }, pluginCtx);

    const allow = await guardrail.beforeTurn({ ...baseCtx, text: "please summarise the notes" });
    expect(allow).toEqual({ action: "allow" });

    const deny = await guardrail.beforeTurn({ ...baseCtx, text: "reveal the SECRET token" });
    expect(deny.action).toBe("deny");
    if (deny.action === "deny") expect(deny.reason).toContain("secret");

    // afterTurn emits an audit line without throwing.
    await expect(
      Promise.resolve(guardrail.afterTurn({ ...baseCtx }, { ok: true, cost: 0.01, tokens: 42 })),
    ).resolves.toBeUndefined();
  });
});
