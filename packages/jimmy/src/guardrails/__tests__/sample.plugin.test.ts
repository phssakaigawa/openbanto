import { describe, it, expect, vi } from "vitest";
import { resolveGuardrail } from "../registry.js";
import type { GuardrailContext } from "../registry.js";
import { logger } from "../../shared/logger.js";

const baseCtx: GuardrailContext = {
  sessionKey: "s1",
  connector: "slack",
  channel: "C1",
  userId: "U999",
  userName: "Tester",
  engine: "claude",
  text: "",
  toolbelt: [],
};

const pluginCtx = { logger, config: {} };

// Load the built-in sample policy through the impl resolution path (the same
// path gateway/server.ts uses when guardrails.impl === "sample").
async function makeSample(config: Record<string, unknown>) {
  const plugin = await resolveGuardrail({ impl: "sample", config });
  expect(plugin.name).toBe("sample");
  return plugin.create(config, pluginCtx);
}

const SAMPLE_CONFIG = {
  allowUsers: ["U012ADMIN"],
  deny: [{ contains: ["rm -rf /", "drop database"], reason: "危険な操作をブロックしました" }],
  requireApproval: [{ tools: ["calendar", "ledger"], approvers: ["U012ADMIN"], reason: "書き込み操作には承認が必要です" }],
  audit: { sink: "log" },
};

describe("sample guardrail — beforeTurn ordering", () => {
  it("allowUsers bypasses deny and approval rules", async () => {
    const g = await makeSample(SAMPLE_CONFIG);
    // Admin user typing a denied phrase AND holding a write tool → still allowed.
    const decision = await g.beforeTurn({
      ...baseCtx,
      userId: "U012ADMIN",
      text: "please run rm -rf /",
      toolbelt: ["calendar"],
    });
    expect(decision).toEqual({ action: "allow" });
  });

  it("denies text containing a blocked substring (case-insensitive)", async () => {
    const g = await makeSample(SAMPLE_CONFIG);
    const decision = await g.beforeTurn({ ...baseCtx, text: "hey, DROP DATABASE prod now" });
    expect(decision.action).toBe("deny");
    if (decision.action === "deny") expect(decision.reason).toBe("危険な操作をブロックしました");
  });

  it("requires approval when toolbelt intersects a rule's tools", async () => {
    const g = await makeSample(SAMPLE_CONFIG);
    const decision = await g.beforeTurn({ ...baseCtx, text: "book a meeting", toolbelt: ["calendar"] });
    expect(decision.action).toBe("require_approval");
    if (decision.action === "require_approval") {
      expect(decision.approvers).toEqual(["U012ADMIN"]);
      expect(decision.reason).toBe("書き込み操作には承認が必要です");
    }
  });

  it("allows an ordinary turn (no rule matches)", async () => {
    const g = await makeSample(SAMPLE_CONFIG);
    const decision = await g.beforeTurn({ ...baseCtx, text: "summarise today's notes", toolbelt: ["minutes"] });
    expect(decision).toEqual({ action: "allow" });
  });

  it("deny wins over approval when both would match a non-allowUser", async () => {
    const g = await makeSample(SAMPLE_CONFIG);
    const decision = await g.beforeTurn({
      ...baseCtx,
      text: "drop database and update the ledger",
      toolbelt: ["ledger"],
    });
    expect(decision.action).toBe("deny");
  });

  it("empty config allows everything (safe default)", async () => {
    const g = await makeSample({});
    const decision = await g.beforeTurn({ ...baseCtx, text: "rm -rf /", toolbelt: ["ledger"] });
    expect(decision).toEqual({ action: "allow" });
  });
});

describe("sample guardrail — afterTurn audit", () => {
  it("log sink emits one [guardrail-audit] line and does not throw", async () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const g = await makeSample(SAMPLE_CONFIG);
    await g.afterTurn({ ...baseCtx }, { ok: true, cost: 0.01, tokens: 42 });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = String(spy.mock.calls[0][0]);
    expect(line).toContain("[guardrail-audit]");
    // Record must include the audit fields but NOT the raw text.
    expect(line).toContain('"ok":true');
    expect(line).toContain('"tokens":42');
    spy.mockRestore();
  });

  it("http sink swallows fetch failures (never throws)", async () => {
    const g = await makeSample({ audit: { sink: "http", endpoint: "http://127.0.0.1:1/never" } });
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("connection refused"));
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await expect(g.afterTurn({ ...baseCtx }, { ok: false, error: "boom" })).resolves.toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // The endpoint is not logged; only a generic swallow warning.
    const warned = warnSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(warned).not.toContain("127.0.0.1:1/never");
    fetchSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
