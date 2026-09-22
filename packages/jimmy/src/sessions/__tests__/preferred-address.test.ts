import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// context.ts resolves JINN_HOME (→ knowledge dir) at module load, so we point
// OPENBANTO_HOME at a temp dir BEFORE importing it, then seed per-user files.
let tmpHome: string;
let buildContext: typeof import("../context.js").buildContext;
let readPreferredAddress: typeof import("../context.js").readPreferredAddress;

const WITH_ADDRESS = "U-ADDR";
const NO_ADDRESS = "U-NOADDR";

const baseOpts = {
  source: "slack",
  channel: "C123",
  user: "U123",
};

function seedProfile(slackId: string, content: string): void {
  const dir = path.join(tmpHome, "knowledge", "users", slackId.toLowerCase());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "profile.md"), content);
}

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "openbanto-address-"));
  process.env.OPENBANTO_HOME = tmpHome;
  seedProfile(
    WITH_ADDRESS,
    [
      "# 御宿帳 — 山田 太郎（yamada）",
      "",
      "- お名前: 山田 太郎（やまだ たろう）",
      "- 呼び方: 「山田さん」",
      "- 役割: インフラエンジニア",
      "",
      "Long enough profile body so the speaker counts as a known guest.",
    ].join("\n"),
  );
  seedProfile(
    NO_ADDRESS,
    [
      "# 御宿帳 — 鈴木 花子",
      "",
      "- お名前: 鈴木 花子",
      "- 役割: プロダクトマネージャー",
      "",
      "Long enough profile body so the speaker counts as a known guest.",
    ].join("\n"),
  );
  ({ buildContext, readPreferredAddress } = await import("../context.js"));
});

afterAll(() => {
  delete process.env.OPENBANTO_HOME;
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("readPreferredAddress", () => {
  it("extracts the 呼び方 field and strips quote brackets", () => {
    expect(readPreferredAddress({ speakerSlackId: WITH_ADDRESS })).toBe("山田さん");
  });

  it("returns undefined when the profile has no 呼び方 field", () => {
    expect(readPreferredAddress({ speakerSlackId: NO_ADDRESS })).toBeUndefined();
  });

  it("returns undefined for a speaker with no profile at all", () => {
    expect(readPreferredAddress({ speakerSlackId: "U-NOBODY" })).toBeUndefined();
  });

  it("returns undefined for an empty scope", () => {
    expect(readPreferredAddress(undefined)).toBeUndefined();
    expect(readPreferredAddress({})).toBeUndefined();
  });

  it("accepts 呼び名/呼称 labels and unbulleted lines", () => {
    seedProfile("U-ALT1", "呼び名: 『鈴木部長』\n\npadding padding padding padding padding padding\n");
    expect(readPreferredAddress({ speakerSlackId: "U-ALT1" })).toBe("鈴木部長");
    seedProfile("U-ALT2", "* 呼称: たなかさん\n\npadding padding padding padding padding padding\n");
    expect(readPreferredAddress({ speakerSlackId: "U-ALT2" })).toBe("たなかさん");
  });
});

describe("buildContext 呼び方 injection", () => {
  it("injects the registered form of address as a hard rule", () => {
    const ctx = buildContext({ ...baseOpts, speakerName: "yamada", speakerSlackId: WITH_ADDRESS });
    expect(ctx).toContain("「山田さん」");
    expect(ctx).toContain("guest register");
    expect(ctx).toContain("Never invent a different reading");
  });

  it("falls back to handle-as-is with a no-guessing rule when 呼び方 is absent", () => {
    const ctx = buildContext({ ...baseOpts, speakerName: "suzuki", speakerSlackId: NO_ADDRESS });
    expect(ctx).toContain("No preferred form of address is on file");
    expect(ctx).toContain("Never guess the reading of a kanji name");
  });

  it("uses the registered address in the NOT-the-operator warning", () => {
    const ctx = buildContext({
      ...baseOpts,
      speakerName: "yamada",
      speakerSlackId: WITH_ADDRESS,
      operatorName: "someone-else",
    });
    expect(ctx).toContain('Address this person as "山田さん", not "someone-else"');
  });
});
