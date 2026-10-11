import { describe, expect, it } from "vitest";
import { buildContext } from "../context.js";

describe("context: current date section (#654)", () => {
  it("always includes the gateway-clock date block", () => {
    const ctx = buildContext({ source: "slack", channel: "C1", user: "u", connectors: [], speakerTz: "Asia/Tokyo" } as never);
    expect(ctx).toContain("## 現在日時（ゲートウェイの時計。これが唯一の正）");
    expect(ctx).toMatch(/現在: \d{4}-\d{2}-\d{2}（.）/);
    expect(ctx).toContain("- 明日: ");
  });
});
