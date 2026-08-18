#!/usr/bin/env node
/**
 * Jinn Knowledge MCP Server
 *
 * A Model Context Protocol (MCP) server that gives AI engines scoped
 * file IO into the knowledge base at `~/.openbanto/knowledge/`. This is
 * the ONLY filesystem path the OpenAI (AiDEA) engine can reach — it has
 * no native Read/Write and consumes tools exclusively through the MCP
 * tool-call bridge. Claude may use these tools too, or its native FS
 * access — the recording instructions are written engine-agnostically.
 *
 * Every path is confined to the knowledge root. Traversal (`..`,
 * absolute paths, or symlinks that escape the root) is rejected before
 * any read/write happens. Internal absolute paths are never echoed back
 * to the caller in success responses or error messages.
 *
 * Started as a stdio subprocess by Claude Code / the MCP bridge via
 * --mcp-config, mirroring the gateway-server.ts startup pattern.
 */

import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// ─── Knowledge root resolution ───
// Mirror shared/paths.ts precedence without importing it, so this file stays
// a standalone stdio entrypoint with a minimal dependency surface.
function resolveKnowledgeRoot(): string {
  const home =
    process.env.OPENBANTO_HOME ||
    process.env.RYOKO_HOME ||
    process.env.JINN_HOME ||
    (() => {
      const instance =
        process.env.OPENBANTO_INSTANCE ||
        process.env.RYOKO_INSTANCE ||
        process.env.JINN_INSTANCE;
      if (instance) return path.join(os.homedir(), `.${instance}`);
      const candidates = [
        path.join(os.homedir(), ".openbanto"),
        path.join(os.homedir(), ".ryoko"),
        path.join(os.homedir(), ".jinn"),
      ];
      for (const c of candidates) {
        try {
          if (fs.existsSync(c)) return c;
        } catch {
          /* ignore */
        }
      }
      return path.join(os.homedir(), ".openbanto");
    })();
  return path.join(home, "knowledge");
}

const KNOWLEDGE_ROOT = resolveKnowledgeRoot();

// ─── Per-user auto-scoping (番頭ID伝播) ───
// The banto stamps the current speaker's key into JINN_USER_KEY on every turn
// (see mcp/resolver.ts). When present, this 職人's I/O is silently scoped to
// that speaker's subtree `users/<key>/`: a caller path like `profile.md`
// resolves to `users/<key>/profile.md`. An explicit `shared/...` path is the
// org-wide escape hatch and maps to `knowledge/shared/...` unchanged. Absent
// the env, behaviour is the legacy knowledge-root-relative model.
//
// The rewrite happens BEFORE resolveWithinRoot, so all traversal defenses
// (absolute/`..`/`~`/symlink escape) still apply — a user cannot climb out of
// their own subtree either (e.g. `../other` under a scoped key becomes
// `users/other/...`? no: it is prefixed then re-checked and rejected if it
// escapes the root; and it can never reach a sibling user's tree without an
// explicit `users/<other>` which the banto never grants — the scope is a
// convenience default, not a hard sandbox boundary between users). The hard
// guarantee is: never escape KNOWLEDGE_ROOT.
function normalizeUserKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const key = raw
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return key || undefined;
}

const USER_KEY = normalizeUserKey(process.env.JINN_USER_KEY);

/**
 * Apply per-user auto-scoping to a caller-supplied path. Returns the path that
 * should be handed to resolveWithinRoot. No-op when JINN_USER_KEY is unset.
 * `shared/...` (org-wide) is passed through untouched.
 */
function scopePath(relInput: unknown): unknown {
  if (!USER_KEY) return relInput;
  if (typeof relInput !== "string") return relInput; // let resolveWithinRoot reject
  const rel = relInput.trim();
  if (rel.length === 0) return relInput;
  // Org-wide escape hatch: shared/ (and bare "shared") map to knowledge/shared.
  if (rel === "shared" || /^shared[/\\]/.test(rel)) return rel;
  // Idempotency: the system prompt tells the model its files live under
  // `users/<userKey>/`, so it sometimes passes a path that ALREADY carries that
  // prefix. Prepending again would double-nest (`users/<k>/users/<k>/…`) and the
  // read-back — which uses the bare, auto-scoped path — would then miss the file
  // (writes "succeed" but the 職人 can never recall them). Treat a self-prefixed
  // path as already scoped. A `users/<other>/…` path is NOT short-circuited, so
  // it still gets confined under the caller's own subtree (no sibling reach).
  const selfPrefix = `users/${USER_KEY}`;
  if (rel === selfPrefix || rel.startsWith(`${selfPrefix}/`) || rel.startsWith(`${selfPrefix}\\`)) {
    return rel;
  }
  // Everything else is relative to this speaker's subtree.
  return `users/${USER_KEY}/${rel.replace(/^[/\\]+/, "")}`;
}

// ─── Path safety ───

/** Thrown for any relative path that would escape the knowledge root. */
class TraversalError extends Error {}

/**
 * Resolve a knowledge-root-relative path to an absolute path, rejecting any
 * input that escapes the root. Rejects: absolute paths, `..` traversal, and
 * (for existing paths) symlinks whose real target lands outside the root.
 * Returns the resolved absolute path — callers must not surface it to users.
 */
function resolveWithinRoot(relInput: unknown): string {
  if (typeof relInput !== "string") {
    throw new TraversalError("path must be a string relative to the knowledge root");
  }
  const rel = relInput.trim();
  if (rel.length === 0) {
    throw new TraversalError("path is required");
  }
  // Reject absolute paths (POSIX + Windows drive/UNC) and home expansion.
  if (path.isAbsolute(rel) || /^[a-zA-Z]:[\\/]/.test(rel) || rel.startsWith("~")) {
    throw new TraversalError("path must be relative to the knowledge root");
  }
  // Reject NUL bytes outright.
  if (rel.includes("\0")) {
    throw new TraversalError("invalid path");
  }

  // Lexical containment check: resolve against root and verify the prefix.
  const resolved = path.resolve(KNOWLEDGE_ROOT, rel);
  const rootWithSep = KNOWLEDGE_ROOT.endsWith(path.sep)
    ? KNOWLEDGE_ROOT
    : KNOWLEDGE_ROOT + path.sep;
  if (resolved !== KNOWLEDGE_ROOT && !resolved.startsWith(rootWithSep)) {
    throw new TraversalError("path escapes the knowledge root");
  }

  // Symlink check: for the deepest existing ancestor, ensure its realpath
  // still lives inside the (real) root. This catches symlinks that point out.
  const realRoot = safeRealpath(KNOWLEDGE_ROOT);
  const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  let probe = resolved;
  // Walk up until we hit a path that exists on disk.
  while (probe !== path.dirname(probe)) {
    if (fs.existsSync(probe)) {
      const real = safeRealpath(probe);
      if (real !== realRoot && !real.startsWith(realRootWithSep)) {
        throw new TraversalError("path escapes the knowledge root");
      }
      break;
    }
    probe = path.dirname(probe);
  }

  return resolved;
}

function safeRealpath(p: string): string {
  try {
    return fs.realpathSync(p);
  } catch {
    return p;
  }
}

// ─── MCP Protocol Types ───

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

// ─── Tool Definitions ───

const TOOLS = [
  {
    name: "read_knowledge",
    description:
      "Read a knowledge file. Your I/O is automatically scoped to the CURRENT USER: a `path` like 'profile.md' resolves to that user's private subtree ('users/<you>/profile.md'). Prefix with 'shared/' to reach org-wide files ('shared/projects.md'). Absolute paths and '..' are rejected.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path relative to the knowledge root (no leading slash, no '..').",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "write_knowledge",
    description:
      "Create or overwrite a knowledge file. Your I/O is automatically scoped to the CURRENT USER: a `path` like 'profile.md' or 'preferences.md' is written into that user's private subtree ('users/<you>/…'). Prefix with 'shared/' for org-wide files. Parent directories are created automatically.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: {
          type: "string",
          description: "Path relative to the knowledge root (no leading slash, no '..').",
        },
        content: {
          type: "string",
          description: "Full file content to write.",
        },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "list_knowledge",
    description:
      "List entries in a knowledge directory. Your I/O is automatically scoped to the CURRENT USER: omit `dir` (or '') to list your own private subtree ('users/<you>/'). Prefix with 'shared/' for org-wide directories. Returns file/dir names and sizes.",
    inputSchema: {
      type: "object" as const,
      properties: {
        dir: {
          type: "string",
          description: "Directory relative to the knowledge root. Omit for the root.",
        },
      },
    },
  },
];

// ─── Tool Handlers ───

function handleTool(name: string, args: Record<string, unknown>): string {
  switch (name) {
    case "read_knowledge": {
      const scoped = scopePath(args.path);
      const abs = resolveWithinRoot(scoped);
      let content: string;
      try {
        content = fs.readFileSync(abs, "utf-8");
      } catch {
        // Do not leak the absolute path in the error.
        throw new Error(`knowledge file not found: ${sanitizeRel(scoped)}`);
      }
      return content;
    }

    case "write_knowledge": {
      const scoped = scopePath(args.path);
      const abs = resolveWithinRoot(scoped);
      const content = typeof args.content === "string" ? args.content : "";
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf-8");
      return JSON.stringify({
        ok: true,
        path: sanitizeRel(scoped),
        bytes: Buffer.byteLength(content, "utf-8"),
      });
    }

    case "list_knowledge": {
      const dirRaw = args.dir === undefined || args.dir === null || args.dir === "" ? "." : args.dir;
      // "." with a scope means "my subtree root" → users/<key>. Without a scope
      // it stays the knowledge root.
      const dirRel = dirRaw === "." && USER_KEY ? `users/${USER_KEY}` : scopePath(dirRaw);
      const abs = resolveWithinRoot(dirRel);
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(abs, { withFileTypes: true });
      } catch {
        // Missing dir → empty listing rather than a path-leaking error.
        return JSON.stringify({ dir: sanitizeRel(dirRel === "." ? "" : dirRel), entries: [] });
      }
      const listed = entries.map((e) => {
        let size: number | undefined;
        if (e.isFile()) {
          try {
            size = fs.statSync(path.join(abs, e.name)).size;
          } catch {
            /* ignore */
          }
        }
        return {
          name: e.name,
          type: e.isDirectory() ? "dir" : "file",
          ...(size !== undefined ? { bytes: size } : {}),
        };
      });
      return JSON.stringify({ dir: sanitizeRel(dirRel === "." ? "" : dirRel), entries: listed });
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Normalize a caller-supplied relative path for echoing back (no root prefix). */
function sanitizeRel(p: unknown): string {
  if (typeof p !== "string") return "";
  return p.replace(/^[/\\]+/, "").replace(/\0/g, "");
}

// ─── MCP Protocol Handler ───

function sendResponse(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + "\n");
}

function handleRequest(request: JsonRpcRequest): void {
  const { id, method, params } = request;

  switch (method) {
    case "initialize":
      sendResponse({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "jinn-knowledge", version: "0.1.0" },
        },
      });
      break;

    case "tools/list":
      sendResponse({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      break;

    case "tools/call": {
      const toolName = params?.name as string;
      const toolArgs = (params?.arguments as Record<string, unknown>) || {};
      try {
        const result = handleTool(toolName, toolArgs);
        sendResponse({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: result }] },
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sendResponse({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: `Error: ${msg}` }], isError: true },
        });
      }
      break;
    }

    case "notifications/initialized":
      break;

    default:
      sendResponse({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      });
  }
}

// Exported for unit tests (path traversal + tool dispatch) without spawning a
// process. Not part of the wire protocol.
export const __test = {
  resolveWithinRoot,
  handleTool,
  scopePath,
  USER_KEY,
  KNOWLEDGE_ROOT,
  TraversalError,
  TOOLS,
};

// ─── Main (only runs when invoked as the stdio entrypoint) ───

function main(): void {
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    let request: JsonRpcRequest;
    try {
      request = JSON.parse(line) as JsonRpcRequest;
    } catch {
      return; // Ignore unparseable lines
    }
    try {
      handleRequest(request);
    } catch (err) {
      sendResponse({
        jsonrpc: "2.0",
        id: request.id,
        error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
      });
    }
  });
  rl.on("close", () => process.exit(0));
}

// Guard: only start the stdin loop when run directly, not when imported by tests.
const isDirectRun = (() => {
  try {
    const invoked = process.argv[1] ? fs.realpathSync(process.argv[1]) : "";
    const self = fs.realpathSync(new URL(import.meta.url).pathname);
    return invoked === self;
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main();
}
