import { describe, it, expect, vi, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// setInteractiveSetting edits the file at CONFIG_PATH. Point that constant at a
// per-test temp file by mocking the paths module before importing the unit.
let TEST_CONFIG = "";
vi.mock("../../shared/paths.js", () => ({
  get CONFIG_PATH() { return TEST_CONFIG; },
}));
// loadConfig reads CONFIG_PATH + yaml.load; the real impl is fine here.
vi.mock("../../shared/config.js", async () => {
  const yaml = (await import("js-yaml")).default;
  return {
    loadConfig: () => yaml.load(fs.readFileSync(TEST_CONFIG, "utf-8")),
  };
});

import { getInteractiveSetting, setInteractiveSetting } from "../interactive-config.js";

function writeConfig(body: string): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "icfg-"));
  TEST_CONFIG = path.join(dir, "config.yaml");
  fs.writeFileSync(TEST_CONFIG, body, "utf-8");
}

const BASE = `engines:
  default: claude
  claude:
    bin: claude
    model: opus
    effortLevel: medium
  codex:
    bin: codex
    model: gpt-5.5
    effortLevel: high
`;

describe("interactive-config", () => {
  beforeEach(() => { TEST_CONFIG = ""; });

  it("inserts interactive under claude when absent, and reads it back", () => {
    writeConfig(BASE);
    expect(getInteractiveSetting()).toBeUndefined();
    expect(setInteractiveSetting(true)).toBe(true);
    const out = fs.readFileSync(TEST_CONFIG, "utf-8");
    expect(out).toMatch(/^ {2}claude:\n {4}interactive: true$/m);
    // codex block untouched
    expect(out).toContain("model: gpt-5.5");
    expect(getInteractiveSetting()).toBe(true);
  });

  it("flips an existing live value in place", () => {
    writeConfig(BASE.replace("    model: opus\n", "    model: opus\n    interactive: true\n"));
    expect(getInteractiveSetting()).toBe(true);
    expect(setInteractiveSetting(false)).toBe(true);
    expect(getInteractiveSetting()).toBe(false);
    // no duplicate key introduced
    const occurrences = fs.readFileSync(TEST_CONFIG, "utf-8").match(/interactive:/g) || [];
    expect(occurrences.length).toBe(1);
  });

  it("uncomments + sets a commented template hint, preserving indent", () => {
    writeConfig(BASE.replace("    effortLevel: medium\n", "    effortLevel: medium\n    # interactive: false\n"));
    expect(getInteractiveSetting()).toBeUndefined();
    expect(setInteractiveSetting(true)).toBe(true);
    const out = fs.readFileSync(TEST_CONFIG, "utf-8");
    expect(out).toMatch(/^ {4}interactive: true$/m);
    expect(out).not.toMatch(/#\s*interactive/);
    expect(getInteractiveSetting()).toBe(true);
  });

  it("returns false when the value is already the desired one", () => {
    writeConfig(BASE.replace("    model: opus\n", "    model: opus\n    interactive: true\n"));
    expect(setInteractiveSetting(true)).toBe(false);
  });

  it("preserves surrounding comments on a flip", () => {
    const withComments = `engines:
  default: claude
  # Claude engine
  claude:
    bin: claude
    interactive: false   # toggle me
  codex:
    bin: codex
`;
    writeConfig(withComments);
    expect(setInteractiveSetting(true)).toBe(true);
    const out = fs.readFileSync(TEST_CONFIG, "utf-8");
    expect(out).toContain("# Claude engine");
    expect(out).toContain("# toggle me"); // trailing comment preserved
    expect(out).toMatch(/interactive: true/);
    // a live line with a trailing comment must be flipped in place, not duplicated
    const occurrences = out.match(/^\s*interactive:/gm) || [];
    expect(occurrences.length).toBe(1);
    expect(getInteractiveSetting()).toBe(true);
  });

  it("scopes to engines.claude — a stray interactive: elsewhere is untouched", () => {
    const stray = `engines:
  default: claude
  claude:
    bin: claude
    model: opus
  codex:
    bin: codex
    interactive: true
`;
    writeConfig(stray);
    expect(setInteractiveSetting(true)).toBe(true);
    const out = fs.readFileSync(TEST_CONFIG, "utf-8");
    // claude got its own key inserted; the codex stray line is left as-is.
    expect(out).toMatch(/^ {2}claude:\n {4}interactive: true$/m);
    const codexBlock = out.slice(out.indexOf("  codex:"));
    expect(codexBlock).toContain("interactive: true"); // unchanged
    expect((out.match(/^\s*interactive:/gm) || []).length).toBe(2);
  });

  it("handles a claude: line with a trailing comment for insertion", () => {
    writeConfig(BASE.replace("  claude:\n", "  claude: # the main engine\n"));
    expect(setInteractiveSetting(true)).toBe(true);
    const out = fs.readFileSync(TEST_CONFIG, "utf-8");
    expect(out).toMatch(/^ {2}claude: # the main engine\n {4}interactive: true$/m);
  });

  it("flips a non-true/false YAML boolean value form", () => {
    writeConfig(BASE.replace("    model: opus\n", "    model: opus\n    interactive: off\n"));
    expect(setInteractiveSetting(true)).toBe(true);
    const out = fs.readFileSync(TEST_CONFIG, "utf-8");
    expect(out).toMatch(/^ {4}interactive: true$/m);
    expect((out.match(/^\s*interactive:/gm) || []).length).toBe(1);
  });
});
