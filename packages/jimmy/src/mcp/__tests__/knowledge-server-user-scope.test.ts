import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// knowledge-server.ts captures both KNOWLEDGE_ROOT (from OPENBANTO_HOME) and
// USER_KEY (from JINN_USER_KEY) at import time. Set both BEFORE importing so we
// exercise the per-user auto-scoping path (番頭ID伝播).
let root: string;
let mod: typeof import("../knowledge-server.js");

beforeAll(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "openbanto-know-scope-"));
  process.env.OPENBANTO_HOME = home;
  process.env.JINN_USER_KEY = "u123";
  root = path.join(home, "knowledge");
  fs.mkdirSync(root, { recursive: true });
  mod = await import("../knowledge-server.js");
});

afterAll(() => {
  delete process.env.OPENBANTO_HOME;
  delete process.env.JINN_USER_KEY;
});

describe("knowledge-server per-user auto-scoping (JINN_USER_KEY set)", () => {
  it("captured the normalized user key", () => {
    expect(mod.__test.USER_KEY).toBe("u123");
  });

  it("scopes a bare path into users/<key>/", () => {
    expect(mod.__test.scopePath("profile.md")).toBe("users/u123/profile.md");
  });

  it("write/read of a bare path lands under the user's subtree", () => {
    const out = JSON.parse(mod.__test.handleTool("write_knowledge", {
      path: "profile.md",
      content: "scoped hello",
    }));
    expect(out.ok).toBe(true);
    // The echoed path shows the scoped location, never an absolute path.
    expect(out.path).toBe("users/u123/profile.md");
    expect(out.path).not.toContain(mod.__test.KNOWLEDGE_ROOT);

    // File physically exists under users/u123/.
    const abs = path.join(root, "users", "u123", "profile.md");
    expect(fs.existsSync(abs)).toBe(true);

    // Reading the same bare path returns the same content.
    const read = mod.__test.handleTool("read_knowledge", { path: "profile.md" });
    expect(read).toBe("scoped hello");
  });

  it("shared/ paths are the org-wide escape hatch (NOT user-scoped)", () => {
    expect(mod.__test.scopePath("shared/projects.md")).toBe("shared/projects.md");

    mod.__test.handleTool("write_knowledge", {
      path: "shared/projects.md",
      content: "team wide",
    });
    // Lands at knowledge/shared/, not under users/u123/.
    expect(fs.existsSync(path.join(root, "shared", "projects.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "users", "u123", "shared", "projects.md"))).toBe(false);
  });

  it("list_knowledge with no dir lists the user's own subtree", () => {
    const out = JSON.parse(mod.__test.handleTool("list_knowledge", {}));
    expect(out.entries.some((e: { name: string }) => e.name === "profile.md")).toBe(true);
  });

  it("still rejects traversal even under a scoped key (cannot escape the root)", () => {
    // scopePath prefixes users/u123/, then resolveWithinRoot must still reject
    // any input that climbs out of the knowledge root via `..`.
    expect(() => mod.__test.resolveWithinRoot(mod.__test.scopePath("../../../etc/passwd")))
      .toThrow(mod.__test.TraversalError);
    // And the tool handler surfaces it as an error rather than reading /etc.
    expect(() => mod.__test.handleTool("read_knowledge", { path: "../../../etc/passwd" }))
      .toThrow(mod.__test.TraversalError);
  });
});
