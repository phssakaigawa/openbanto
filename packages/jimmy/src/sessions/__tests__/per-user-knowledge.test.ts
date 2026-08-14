import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// context.ts resolves JINN_HOME (→ knowledge dir) at module load, so we point
// OPENBANTO_HOME at a temp dir BEFORE importing it, then seed per-user files.
let tmpHome: string;
let buildContext: typeof import("../context.js").buildContext;

const KNOWN = "U-KNOWN";
const NEW = "U-NEW";

const baseOpts = {
  source: "slack",
  channel: "C123",
  user: "U123",
};

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "openbanto-peruser-"));
  process.env.OPENBANTO_HOME = tmpHome;
  // Seed a populated profile for the KNOWN speaker only.
  const knownDir = path.join(tmpHome, "knowledge", "users", "u-known");
  fs.mkdirSync(knownDir, { recursive: true });
  fs.writeFileSync(
    path.join(knownDir, "profile.md"),
    "# Sakaigawa\nInfra engineer at Getworks. Runs the gw-poc cluster. Prefers Japanese.\n",
  );
  ({ buildContext } = await import("../context.js"));
});

afterAll(() => {
  delete process.env.OPENBANTO_HOME;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("per-user isNew (ご記帳) scoping", () => {
  it("treats a brand-new speaker as onboarding", () => {
    const ctx = buildContext({ ...baseOpts, speakerName: "New Person", speakerSlackId: NEW });
    expect(ctx).toContain("ONBOARDING (ご記帳) MODE");
    // The engine-agnostic recording instruction points at the speaker's own path.
    expect(ctx).toContain("users/u-new/profile.md");
    expect(ctx).toContain("write_knowledge");
  });

  it("treats a known speaker (populated profile) as steady-state, not onboarding", () => {
    const ctx = buildContext({ ...baseOpts, speakerName: "Sakaigawa", speakerSlackId: KNOWN });
    expect(ctx).not.toContain("ONBOARDING (ご記帳) MODE");
    expect(ctx).toContain("users/u-known/profile.md");
  });

  it("scopes the knowledge listing to the speaker (no other user's files)", () => {
    const ctx = buildContext({ ...baseOpts, speakerName: "New Person", speakerSlackId: NEW });
    // The NEW speaker must not see the KNOWN speaker's per-user dir listing.
    expect(ctx).not.toContain("users/u-known)");
  });
});
