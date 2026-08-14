// MCP → OpenAI tool-call bridge.
//
// Reads a standard MCP config file (the JSON that `writeMcpConfigFile` emits:
// `{ "mcpServers": { "<name>": {command,args,env} | {type:"sse",url,headers} } }`),
// connects an MCP client to each server (stdio OR URL/SSE/HTTP transport),
// lists every server's tools, and exposes them as OpenAI `tools` (function
// definitions) with a `"<server>__<tool>"` namespace so names never collide.
//
// A single `McpToolBridge` instance owns all the live clients for one engine
// turn: `connect()` opens them, `callTool()` dispatches a namespaced call back
// to the right client, and `close()` tears them all down (finally / abort).
//
// The MCP `Client` and the transports are injectable (`BridgeDeps`) so unit
// tests can drive the bridge with fakes and never touch a real process or
// socket. In production the deps default to the official
// `@modelcontextprotocol/sdk`.
//
// SECURITY: server env/headers may carry secrets. This module NEVER logs their
// values — only server names, tool names, and (bounded) error messages.
import { logger } from "../shared/logger.js";
import type { McpServerConfig, McpServerUrlConfig, McpServerStdioConfig } from "../shared/types.js";

/** Minimal shape of the MCP SDK Client we depend on (for injection/testing). */
export interface McpClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: McpToolDef[] }>;
  callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<McpCallToolResult>;
  close(): Promise<void>;
}

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

/** MCP callTool result — content blocks and/or structured content. */
export interface McpCallToolResult {
  content?: Array<{ type: string; text?: string; [k: string]: unknown }>;
  structuredContent?: unknown;
  isError?: boolean;
}

/** OpenAI function-tool definition (the subset we emit). */
export interface OpenAiToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

/** Factory hooks so tests can inject fakes instead of the real SDK. */
export interface BridgeDeps {
  /** Build an MCP client (defaults to the SDK's `Client`). */
  createClient: (info: { name: string; version: string }) => McpClientLike;
  /** Build a stdio transport for a `{command,args,env}` server. */
  createStdioTransport: (cfg: McpServerStdioConfig) => unknown;
  /** Build a URL transport (SSE or streamable-HTTP) for a `{url,headers}` server. */
  createUrlTransport: (cfg: McpServerUrlConfig) => unknown;
}

interface Connected {
  server: string;
  client: McpClientLike;
}

/** The separator between server name and tool name in the namespaced id. */
const NS = "__";

export class McpToolBridge {
  private connected: Connected[] = [];
  /** namespaced tool name → { server, tool } for reverse lookup on call. */
  private toolMap = new Map<string, { server: string; tool: string }>();
  private tools: OpenAiToolDef[] = [];
  private deps: BridgeDeps;

  /** When no deps are injected, `connect()` lazily loads the real SDK once. */
  private depsProvided: boolean;

  constructor(deps?: Partial<BridgeDeps>) {
    this.depsProvided = !!(deps?.createClient && deps?.createStdioTransport && deps?.createUrlTransport);
    // Placeholder deps; real SDK-backed deps are loaded in connect() when none
    // were injected (the SDK is ESM-only, so it must be dynamically imported).
    this.deps = {
      createClient: deps?.createClient ?? notLoaded,
      createStdioTransport: deps?.createStdioTransport ?? notLoaded,
      createUrlTransport: deps?.createUrlTransport ?? notLoaded,
    };
  }

  /** OpenAI `tools` array (empty until connect()). */
  getOpenAiTools(): OpenAiToolDef[] {
    return this.tools;
  }

  hasTools(): boolean {
    return this.tools.length > 0;
  }

  /**
   * Connect to every server in `mcpServers`, list its tools, and build the
   * namespaced OpenAI tool set. A server that fails to connect or list is
   * warned about (name only — never its secrets) and skipped; the rest still
   * come up. Returns the number of tools discovered.
   */
  async connect(mcpServers: Record<string, McpServerConfig>): Promise<number> {
    if (!this.depsProvided) {
      this.deps = await loadSdkDeps();
    }
    for (const [server, cfg] of Object.entries(mcpServers)) {
      try {
        const client = this.deps.createClient({ name: "openbanto-openai-engine", version: "1.0.0" });
        const transport = isUrlConfig(cfg)
          ? this.deps.createUrlTransport(cfg)
          : this.deps.createStdioTransport(cfg);
        await client.connect(transport);

        const listed = await client.listTools();
        this.connected.push({ server, client });

        for (const t of listed.tools ?? []) {
          const nsName = `${server}${NS}${t.name}`;
          if (this.toolMap.has(nsName)) {
            logger.warn(`[openai/mcp] duplicate tool name "${nsName}" — keeping first`);
            continue;
          }
          this.toolMap.set(nsName, { server, tool: t.name });
          this.tools.push({
            type: "function",
            function: {
              name: nsName,
              ...(t.description ? { description: t.description } : {}),
              // JSON Schema straight through; OpenAI wants an object schema.
              parameters: t.inputSchema ?? { type: "object", properties: {} },
            },
          });
        }
      } catch (e: unknown) {
        // Bounded, secret-free: only the server name + a short message.
        const msg = e instanceof Error ? e.message : String(e);
        logger.warn(`[openai/mcp] server "${server}" unavailable, skipping: ${msg.slice(0, 200)}`);
      }
    }
    return this.tools.length;
  }

  /**
   * Dispatch a namespaced OpenAI tool call to the owning MCP client. `args` is
   * the already-parsed arguments object. Returns the MCP result flattened to a
   * string suitable for a `{role:"tool"}` message.
   */
  async callTool(namespacedName: string, args: Record<string, unknown>): Promise<string> {
    const entry = this.toolMap.get(namespacedName);
    if (!entry) {
      return `Error: unknown tool "${namespacedName}"`;
    }
    const conn = this.connected.find((c) => c.server === entry.server);
    if (!conn) {
      return `Error: MCP server "${entry.server}" is not connected`;
    }
    const res = await conn.client.callTool({ name: entry.tool, arguments: args });
    return stringifyToolResult(res);
  }

  /** Close all live clients. Never throws. */
  async close(): Promise<void> {
    const clients = this.connected.splice(0);
    await Promise.all(
      clients.map(async ({ server, client }) => {
        try {
          await client.close();
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          logger.warn(`[openai/mcp] error closing "${server}": ${msg.slice(0, 200)}`);
        }
      }),
    );
    this.toolMap.clear();
    this.tools = [];
  }
}

/** Flatten an MCP callTool result to a string for the chat `tool` message. */
export function stringifyToolResult(res: McpCallToolResult): string {
  const parts: string[] = [];
  for (const block of res.content ?? []) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    } else {
      // Non-text blocks (image/resource/etc): serialize defensively.
      try {
        parts.push(JSON.stringify(block));
      } catch {
        /* skip unserializable block */
      }
    }
  }
  let out = parts.join("\n");
  if (!out && res.structuredContent !== undefined) {
    try {
      out = JSON.stringify(res.structuredContent);
    } catch {
      out = "";
    }
  }
  if (res.isError && out) out = `Error: ${out}`;
  return out || (res.isError ? "Error: tool call failed" : "");
}

export function isUrlConfig(cfg: McpServerConfig): cfg is McpServerUrlConfig {
  return "url" in cfg && typeof (cfg as McpServerUrlConfig).url === "string";
}

// ---- Default (real SDK) dep implementations -------------------------------
// The `@modelcontextprotocol/sdk` is ESM-only, so its classes are pulled in via
// a dynamic import the first time `connect()` runs without injected deps. This
// keeps the SDK out of the module graph until an MCP-enabled turn needs it, and
// lets tests inject fakes without ever loading it.

/** Placeholder used before deps are loaded; never actually invoked. */
function notLoaded(): never {
  throw new Error("MCP bridge deps not loaded — call connect() first");
}

let sdkDepsPromise: Promise<BridgeDeps> | undefined;

/** Load (and memoise) the real SDK-backed dependency factories. */
function loadSdkDeps(): Promise<BridgeDeps> {
  if (!sdkDepsPromise) {
    sdkDepsPromise = (async (): Promise<BridgeDeps> => {
      const [{ Client }, { StdioClientTransport }, { SSEClientTransport }, { StreamableHTTPClientTransport }] =
        await Promise.all([
          import("@modelcontextprotocol/sdk/client/index.js"),
          import("@modelcontextprotocol/sdk/client/stdio.js"),
          import("@modelcontextprotocol/sdk/client/sse.js"),
          import("@modelcontextprotocol/sdk/client/streamableHttp.js"),
        ]);

      return {
        createClient: (info) => new Client(info) as unknown as McpClientLike,
        createStdioTransport: (cfg) => {
          // Merge caller env over the inherited process env so the child keeps
          // PATH etc. Values may be secrets — never logged.
          const env: Record<string, string> = {};
          for (const [k, v] of Object.entries(process.env)) {
            if (typeof v === "string") env[k] = v;
          }
          if (cfg.env) Object.assign(env, cfg.env);
          return new StdioClientTransport({ command: cfg.command, args: cfg.args ?? [], env });
        },
        createUrlTransport: (cfg) => {
          const url = new URL(cfg.url);
          const opts = cfg.headers ? { requestInit: { headers: cfg.headers } } : undefined;
          // `type:"sse"` → SSE transport; otherwise the modern streamable-HTTP
          // transport. Both carry auth headers via requestInit.
          return cfg.type === "sse"
            ? new SSEClientTransport(url, opts)
            : new StreamableHTTPClientTransport(url, opts);
        },
      };
    })();
  }
  return sdkDepsPromise;
}
