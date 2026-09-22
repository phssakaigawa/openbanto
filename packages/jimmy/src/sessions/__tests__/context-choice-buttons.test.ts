import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// context.ts resolves JINN_HOME at module load — point OPENBANTO_HOME at a
// temp dir BEFORE importing (same pattern as the other context tests).
let tmpHome: string;
let buildContext: typeof import("../context.js").buildContext;

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "openbanto-choices-"));
  process.env.OPENBANTO_HOME = tmpHome;
  ({ buildContext } = await import("../context.js"));
});

afterAll(() => {
  delete process.env.OPENBANTO_HOME;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("confirmation-choice buttons prompt section", () => {
  it("instructs Slack-source sessions to use the [[choices: …]] marker", () => {
    const ctx = buildContext({ source: "slack", channel: "C1", user: "U1" });
    expect(ctx).toContain("[[choices:");
    expect(ctx).toContain("Confirmation-choice buttons");
  });

  it("does not leak the marker contract to non-Slack sessions", () => {
    const ctx = buildContext({ source: "web", channel: "web:1", user: "web-user" });
    expect(ctx).not.toContain("[[choices:");
  });
});
