import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenAiEngine } from "../openai.js";
import type { StreamDelta } from "../../shared/types.js";
import type { McpClientLike, BridgeDeps, McpToolDef, McpCallToolResult } from "../../mcp/tool-bridge.js";

// ---- Fakes ---------------------------------------------------------------

/** A fake MCP client: returns a fixed tool list and records callTool calls. */
class FakeMcpClient implements McpClientLike {
  connected = false;
  closed = false;
  callLog: Array<{ name: string; arguments?: Record<string, unknown> }> = [];
  constructor(
    private tools: McpToolDef[],
    private results: Record<string, McpCallToolResult>,
  ) {}
  async connect(): Promise<void> {
    this.connected = true;
  }
  async listTools(): Promise<{ tools: McpToolDef[] }> {
    return { tools: this.tools };
  }
  async callTool(params: { name: string; arguments?: Record<string, unknown> }): Promise<McpCallToolResult> {
    this.callLog.push(params);
    return this.results[params.name] ?? { content: [{ type: "text", text: "(no result)" }] };
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

/** Build injectable BridgeDeps around a single fake client. */
function fakeDeps(client: FakeMcpClient): Partial<BridgeDeps> {
  return {
    createClient: () => client,
    createStdioTransport: () => ({ kind: "stdio" }),
    createUrlTransport: () => ({ kind: "url" }),
  };
}

/** Write a temp MCP config file with the given mcpServers and return its path. */
function writeConfig(mcpServers: Record<string, unknown>): string {
  const p = path.join(os.tmpdir(), `mcp-test-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ mcpServers }));
  tmpFiles.push(p);
  return p;
}

const tmpFiles: string[] = [];

function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(enc.encode(chunks[i++]));
      else controller.close();
    },
  });
}
function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}
function makeAbortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

describe("OpenAiEngine + MCP tool-calls", () => {
  beforeEach(() => {
    tmpFiles.length = 0;
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const f of tmpFiles) {
      try {
        fs.unlinkSync(f);
      } catch {
        /* ignore */
      }
    }
  });

  it("converts MCP tools to namespaced OpenAI tools, runs a tool_call, and returns final text", async () => {
    const client = new FakeMcpClient(
      [
        {
          name: "get_weather",
          description: "Get weather",
          inputSchema: { type: "object", properties: { city: { type: "string" } } },
        },
      ],
      { get_weather: { content: [{ type: "text", text: "sunny, 25C" }] } },
    );

    // Round 1: model asks for the tool. Round 2: final answer.
    const responses: Response[] = [
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: "weather__get_weather", arguments: '{"city":"Tokyo"}' } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "It is sunny, 25C in Tokyo." } }],
          usage: { prompt_tokens: 100 },
        }),
        { status: 200 },
      ),
    ];
    const sentBodies: any[] = [];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBodies.push(JSON.parse(init.body as string));
        return responses[call++];
      }),
    );

    const engine = new OpenAiEngine({
      baseUrl: "https://x",
      apiKey: "secret-key",
      model: "m",
      name: "aidea",
      bridgeDeps: fakeDeps(client),
    });

    const deltas: StreamDelta[] = [];
    const result = await engine.run({
      prompt: "weather in Tokyo?",
      cwd: "/tmp",
      sessionId: "t1",
      mcpConfigPath: writeConfig({ weather: { command: "srv", args: [] } }),
      onStream: (d) => deltas.push(d),
    });

    // (1) namespaced tool advertised to the model
    expect(sentBodies[0].tools).toHaveLength(1);
    expect(sentBodies[0].tools[0]).toMatchObject({
      type: "function",
      function: { name: "weather__get_weather", description: "Get weather" },
    });
    expect(sentBodies[0].tool_choice).toBe("auto");
    expect(sentBodies[0].stream).toBe(false);

    // (2) engine dispatched the call to MCP with the un-namespaced tool name + parsed args
    expect(client.callLog).toEqual([{ name: "get_weather", arguments: { city: "Tokyo" } }]);

    // (3) tool result was appended as a role:"tool" message in round 2
    const round2Messages = sentBodies[1].messages;
    const toolMsg = round2Messages.find((m: any) => m.role === "tool");
    expect(toolMsg).toMatchObject({ role: "tool", tool_call_id: "call_1", content: "sunny, 25C" });

    // (4) final text returned + streamed
    expect(result.result).toBe("It is sunny, 25C in Tokyo.");
    expect(result.error).toBeUndefined();
    expect(result.contextTokens).toBe(100);
    expect(deltas.filter((d) => d.type === "text").map((d) => d.content)).toEqual(["It is sunny, 25C in Tokyo."]);
    expect(deltas.some((d) => d.type === "tool_use" && d.toolName === "weather__get_weather")).toBe(true);
    expect(deltas.some((d) => d.type === "tool_result")).toBe(true);

    // no secret leak
    expect(JSON.stringify({ result, deltas })).not.toContain("secret-key");

    // MCP client closed after the turn
    expect(client.closed).toBe(true);
    expect(engine.isAlive("t1")).toBe(false);
  });

  it("falls back to the plain streaming path when there are no MCP tools", async () => {
    const client = new FakeMcpClient([], {}); // server connects but exposes 0 tools
    const body = streamFromChunks([
      sseData({ choices: [{ delta: { content: "plain " } }] }),
      sseData({ choices: [{ delta: { content: "answer" } }] }),
      "data: [DONE]\n\n",
    ]);
    const sent: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(init.body as string));
        return new Response(body, { status: 200 });
      }),
    );

    const engine = new OpenAiEngine({
      baseUrl: "https://x",
      apiKey: "k",
      model: "m",
      bridgeDeps: fakeDeps(client),
    });
    const result = await engine.run({
      prompt: "hi",
      cwd: "/tmp",
      sessionId: "t2",
      mcpConfigPath: writeConfig({ empty: { command: "srv" } }),
    });

    // streaming request (no tools field) was used
    expect(sent[0].stream).toBe(true);
    expect(sent[0].tools).toBeUndefined();
    expect(result.result).toBe("plain answer");
    // bridge with 0 tools was closed during setup
    expect(client.closed).toBe(true);
  });

  it("uses the plain streaming path when no mcpConfigPath is given (unchanged behaviour)", async () => {
    const body = streamFromChunks([sseData({ choices: [{ delta: { content: "hello" } }] }), "data: [DONE]\n\n"]);
    const sent: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(init.body as string));
        return new Response(body, { status: 200 });
      }),
    );
    const engine = new OpenAiEngine({ baseUrl: "https://x", apiKey: "k", model: "m" });
    const result = await engine.run({ prompt: "hi", cwd: "/tmp", sessionId: "t3" });
    expect(sent[0].stream).toBe(true);
    expect(sent[0].tools).toBeUndefined();
    expect(result.result).toBe("hello");
  });

  it("kill() aborts the in-flight request AND closes the MCP client", async () => {
    const client = new FakeMcpClient(
      [{ name: "t", inputSchema: { type: "object" } }],
      { t: { content: [{ type: "text", text: "x" }] } },
    );
    // fetch that hangs until aborted (so the tool loop is mid-flight)
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
          const signal = init.signal!;
          if (signal.aborted) return reject(makeAbortError());
          signal.addEventListener("abort", () => reject(makeAbortError()));
        });
      }),
    );
    const engine = new OpenAiEngine({
      baseUrl: "https://x",
      apiKey: "k",
      model: "m",
      bridgeDeps: fakeDeps(client),
    });
    const p = engine.run({
      prompt: "hi",
      cwd: "/tmp",
      sessionId: "t4",
      mcpConfigPath: writeConfig({ s: { command: "srv" } }),
    });
    // let connect() + first fetch register
    await new Promise((r) => setTimeout(r, 10));
    engine.kill("t4");
    const result = await p;
    expect(result.error).toBe("interrupted");
    expect(engine.isAlive("t4")).toBe(false);
    expect(client.closed).toBe(true);
  });
});
