import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// knowledge-server.ts resolves its root from OPENBANTO_HOME at import time.
let root: string;
let mod: typeof import("../knowledge-server.js");

beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openbanto-know-"));
  process.env.OPENBANTO_HOME = home;
  root = path.join(home, "knowledge");
  fs.mkdirSync(root, { recursive: true });
  mod = await import("../knowledge-server.js");
});

afterAll(() => {
  delete process.env.OPENBANTO_HOME;
});

describe("knowledge-server path traversal defense", () => {
  it("rejects '..' traversal", () => {
    expect(() => mod.__test.resolveWithinRoot("../etc/passwd")).toThrow(mod.__test.TraversalError);
    expect(() => mod.__test.resolveWithinRoot("users/../../etc/passwd")).toThrow(mod.__test.TraversalError);
  });

  it("rejects absolute paths and home expansion", () => {
    expect(() => mod.__test.resolveWithinRoot("/etc/passwd")).toThrow(mod.__test.TraversalError);
    expect(() => mod.__test.resolveWithinRoot("~/secret")).toThrow(mod.__test.TraversalError);
  });

  it("rejects empty / non-string paths", () => {
    expect(() => mod.__test.resolveWithinRoot("")).toThrow(mod.__test.TraversalError);
    expect(() => mod.__test.resolveWithinRoot(42 as unknown as string)).toThrow(mod.__test.TraversalError);
  });

  it("accepts a legitimate relative path inside the root", () => {
    const resolved = mod.__test.resolveWithinRoot("users/u123/profile.md");
    expect(resolved.startsWith(mod.__test.KNOWLEDGE_ROOT + path.sep)).toBe(true);
  });

  it("rejects a symlink that escapes the root", () => {
    // Create a symlink inside the root pointing at /etc, then try to read through it.
    const linkPath = path.join(root, "escape");
    try {
      fs.symlinkSync("/etc", linkPath);
    } catch {
      // Some CI filesystems disallow symlinks; skip the assertion there.
      return;
    }
    expect(() => mod.__test.resolveWithinRoot("escape/passwd")).toThrow(mod.__test.TraversalError);
  });
});

describe("knowledge-server tool IO round-trip", () => {
  it("write_knowledge then read_knowledge returns the same content", () => {
    const out = mod.__test.handleTool("write_knowledge", {
      path: "users/u999/profile.md",
      content: "hello world",
    });
    expect(JSON.parse(out).ok).toBe(true);
    const read = mod.__test.handleTool("read_knowledge", { path: "users/u999/profile.md" });
    expect(read).toBe("hello world");
  });

  it("read_knowledge on a missing file does not leak the absolute path", () => {
    let err: unknown;
    try {
      mod.__test.handleTool("read_knowledge", { path: "users/nope/profile.md" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(mod.__test.KNOWLEDGE_ROOT);
  });

  it("list_knowledge lists a directory relative to the root", () => {
    const out = JSON.parse(mod.__test.handleTool("list_knowledge", { dir: "users/u999" }));
    expect(out.entries.some((e: { name: string }) => e.name === "profile.md")).toBe(true);
  });
});
