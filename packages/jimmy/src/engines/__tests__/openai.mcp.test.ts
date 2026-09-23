import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenAiEngine, stripToolCallMarkup } from "../openai.js";
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
      name: "openai-1",
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
    // Organic completion — not flagged for auto-continuation, but the
    // executed-tool record is still attached.
    expect(result.incomplete).toBeUndefined();
    expect(result.executedToolCalls).toEqual([{ name: "weather__get_weather", ok: true }]);
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

  it("requests a tool-less summary round when the loop ends with empty final text", async () => {
    const client = new FakeMcpClient(
      [{ name: "create_thing", inputSchema: { type: "object" } }],
      { create_thing: { content: [{ type: "text", text: "created id=234" }] } },
    );

    // Round 1: tool call. Round 2: EMPTY final content (DeepSeek-after-tool-burst
    // shape). Round 3 (summary round, tool_choice "none"): the real report.
    const responses: Response[] = [
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "call_1", type: "function", function: { name: "srv__create_thing", arguments: "{}" } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "Created thing id=234." } }],
          usage: { prompt_tokens: 50 },
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
      apiKey: "k",
      model: "m",
      bridgeDeps: fakeDeps(client),
    });
    const result = await engine.run({
      prompt: "create the thing",
      cwd: "/tmp",
      sessionId: "t-summary",
      mcpConfigPath: writeConfig({ srv: { command: "srv" } }),
    });

    // The summary round disables tool use and ends with a `user` nudge —
    // a trailing `system` message makes some models return empty content again.
    expect(sentBodies).toHaveLength(3);
    expect(sentBodies[2].tool_choice).toBe("none");
    const lastMsg = sentBodies[2].messages[sentBodies[2].messages.length - 1];
    expect(lastMsg.role).toBe("user");
    // The turn never ends with an empty success once tools have run.
    expect(result.error).toBeUndefined();
    expect(result.result).toBe("Created thing id=234.");
    // Summary-round closing = the model never completed organically: the turn
    // is mechanically flagged mid-workflow for the gateway's auto-continuation,
    // with the authoritative execution record attached.
    expect(result.incomplete).toBe(true);
    expect(result.executedToolCalls).toEqual([{ name: "srv__create_thing", ok: true }]);
  });

  it("returns a non-empty fallback when even the summary round yields no text", async () => {
    const client = new FakeMcpClient(
      [{ name: "t", inputSchema: { type: "object" } }],
      { t: { content: [{ type: "text", text: "x" }] } },
    );
    // Round 1: tool call. Round 2: empty. Round 3 (summary): empty again.
    const empty = () =>
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }), { status: 200 });
    const responses: Response[] = [
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "c1", type: "function", function: { name: "srv__t", arguments: "{}" } }],
              },
            },
          ],
        }),
        { status: 200 },
      ),
      empty(),
      empty(),
    ];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => responses[call++]));

    const engine = new OpenAiEngine({
      baseUrl: "https://x",
      apiKey: "k",
      model: "m",
      bridgeDeps: fakeDeps(client),
    });
    const result = await engine.run({
      prompt: "do it",
      cwd: "/tmp",
      sessionId: "t-fallback",
      mcpConfigPath: writeConfig({ srv: { command: "srv" } }),
    });
    expect(result.error).toBeUndefined();
    expect(result.result.length).toBeGreaterThan(0);
  });

  it("fails the turn honestly when no tools ran and no final text came back (no fabricated summary)", async () => {
    const client = new FakeMcpClient(
      [{ name: "t", inputSchema: { type: "object" } }],
      { t: { content: [{ type: "text", text: "x" }] } },
    );
    // Round 1: no tool_calls AND empty content → loop breaks with nothing done.
    const responses: Response[] = [
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }), { status: 200 }),
    ];
    let call = 0;
    const fetchMock = vi.fn(async () => responses[call++]);
    vi.stubGlobal("fetch", fetchMock);

    const engine = new OpenAiEngine({
      baseUrl: "https://x",
      apiKey: "k",
      model: "m",
      bridgeDeps: fakeDeps(client),
    });
    const result = await engine.run({
      prompt: "do the workflow",
      cwd: "/tmp",
      sessionId: "t-notools",
      mcpConfigPath: writeConfig({ srv: { command: "srv" } }),
    });

    // No summary round is issued — the model has nothing real to summarize and
    // would only fabricate a success report.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.error).toBeDefined();
    expect(result.result.length).toBeGreaterThan(0);
    expect(client.callLog).toHaveLength(0);
    // Error turns are never flagged for auto-continuation — repeating a turn
    // where nothing ran would loop uselessly.
    expect(result.incomplete).toBeUndefined();
  });

  it("anchors the summary round to the execution record and errors when every call failed", async () => {
    const client = new FakeMcpClient(
      [{ name: "upload", inputSchema: { type: "object" } }],
      { upload: { content: [{ type: "text", text: "boom" }], isError: true } },
    );
    // Round 1: tool call (fails). Round 2: empty content → summary round.
    const responses: Response[] = [
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "c1", type: "function", function: { name: "srv__upload", arguments: "{}" } }],
              },
            },
          ],
        }),
        { status: 200 },
      ),
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }), { status: 200 }),
      new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "アップロードは失敗しました。" } }] }),
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
      apiKey: "k",
      model: "m",
      bridgeDeps: fakeDeps(client),
    });
    const result = await engine.run({
      prompt: "upload the file",
      cwd: "/tmp",
      sessionId: "t-allfailed",
      mcpConfigPath: writeConfig({ srv: { command: "srv" } }),
    });

    // Summary nudge carries the authoritative execution record with the failure.
    const lastMsg = sentBodies[2].messages[sentBodies[2].messages.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(lastMsg.content).toContain("AUTHORITATIVE");
    expect(lastMsg.content).toContain("srv__upload: FAILED");
    // A turn where every tool call failed never surfaces as a success.
    expect(result.error).toBe("all 1 tool call(s) failed");
    expect(result.result).toBe("アップロードは失敗しました。");
  });

  it("strips raw DSML tool-call markup from the summary round and falls back to the execution report", async () => {
    const client = new FakeMcpClient(
      [{ name: "create_folder", inputSchema: { type: "object" } }],
      { create_folder: { content: [{ type: "text", text: "created" }] } },
    );
    // Round 1: tool call (ok). Round 2: empty content → summary round.
    // Summary round: the model tries to CONTINUE the work — pure DSML markup.
    const dsml =
      '\n\n<｜DSML｜tool_calls>\n<｜DSML｜invoke name="srv__create_folder">\n' +
      '<｜DSML｜parameter name="path" string="true">NetBox/manuals/X</｜DSML｜parameter>\n' +
      "</｜DSML｜invoke>\n</｜DSML｜tool_calls>";
    const responses: Response[] = [
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [{ id: "c1", type: "function", function: { name: "srv__create_folder", arguments: "{}" } }],
              },
            },
          ],
        }),
        { status: 200 },
      ),
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "" } }] }), { status: 200 }),
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: dsml } }] }), { status: 200 }),
    ];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => responses[call++]));

    const engine = new OpenAiEngine({
      baseUrl: "https://x",
      apiKey: "k",
      model: "m",
      bridgeDeps: fakeDeps(client),
    });
    const result = await engine.run({
      prompt: "make the folder",
      cwd: "/tmp",
      sessionId: "t-dsml",
      mcpConfigPath: writeConfig({ srv: { command: "srv" } }),
    });

    // Raw markup never reaches the caller; the deterministic execution report does.
    expect(result.result).not.toContain("DSML");
    expect(result.result).toContain("srv__create_folder: 成功");
    expect(result.result.length).toBeGreaterThan(0);
    expect(result.error).toBeUndefined();
  });

  it("stripToolCallMarkup keeps the prose prefix and drops everything from the first special token", () => {
    expect(stripToolCallMarkup("フォルダを作成しました。<｜DSML｜tool_calls>...")).toBe("フォルダを作成しました。");
    expect(stripToolCallMarkup("<｜DSML｜tool_calls>...")).toBe("");
    expect(stripToolCallMarkup("plain answer with no markup")).toBe("plain answer with no markup");
    expect(stripToolCallMarkup("ascii variant <|DSML|tool_calls>x")).toBe("ascii variant");
    expect(stripToolCallMarkup("")).toBe("");
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

  it("recovers a tool call emitted as fenced-JSON text (DeepSeek), executes it, and returns final text", async () => {
    const client = new FakeMcpClient(
      [{ name: "get_weather", description: "Get weather", inputSchema: { type: "object", properties: { city: { type: "string" } } } }],
      { get_weather: { content: [{ type: "text", text: "sunny, 25C" }] } },
    );
    // Round 1: NO native tool_calls — the model prints a fenced ```json block
    // with a BARE tool name (the exact failure mode seen with some DeepSeek gateways).
    // Round 2: final answer.
    const responses: Response[] = [
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: 'get_weather を実行します。\n\n```json\n{\n  "tool": "get_weather",\n  "parameters": { "city": "Tokyo" }\n}\n```',
                tool_calls: null,
              },
            },
          ],
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({ choices: [{ message: { role: "assistant", content: "It is sunny, 25C in Tokyo." } }], usage: { prompt_tokens: 42 } }),
        { status: 200 },
      ),
    ];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responses[call++]),
    );
    const engine = new OpenAiEngine({ baseUrl: "https://x", apiKey: "k", model: "m", name: "openai-tf", bridgeDeps: fakeDeps(client) });
    const deltas: StreamDelta[] = [];
    const result = await engine.run({
      prompt: "weather in Tokyo?",
      cwd: "/tmp",
      sessionId: "t-textcall",
      mcpConfigPath: writeConfig({ weather: { command: "srv", args: [] } }),
      onStream: (d) => deltas.push(d),
    });
    // The bare text-form call was resolved to the namespaced tool and dispatched.
    expect(client.callLog).toEqual([{ name: "get_weather", arguments: { city: "Tokyo" } }]);
    // The raw fenced-JSON did NOT leak as the final answer.
    expect(result.result).toBe("It is sunny, 25C in Tokyo.");
    expect(result.error).toBeUndefined();
    expect(deltas.some((d) => d.type === "tool_use" && d.toolName === "weather__get_weather")).toBe(true);
    expect(deltas.some((d) => d.type === "tool_result")).toBe(true);
    expect(deltas.filter((d) => d.type === "text").map((d) => d.content)).toEqual(["It is sunny, 25C in Tokyo."]);
  });

  it("does not misfire on a legitimate JSON answer that has no tool-name key", async () => {
    const client = new FakeMcpClient([{ name: "get_weather", description: "Get weather", inputSchema: { type: "object", properties: {} } }], {});
    const responses: Response[] = [
      new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: '結果です:\n\n```json\n{ "status": "ok", "count": 3 }\n```', tool_calls: null } }],
          usage: { prompt_tokens: 10 },
        }),
        { status: 200 },
      ),
    ];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responses[call++]),
    );
    const engine = new OpenAiEngine({ baseUrl: "https://x", apiKey: "k", model: "m", name: "openai-tf2", bridgeDeps: fakeDeps(client) });
    const result = await engine.run({
      prompt: "give me json",
      cwd: "/tmp",
      sessionId: "t-jsonanswer",
      mcpConfigPath: writeConfig({ weather: { command: "srv", args: [] } }),
    });
    // No tool executed; the JSON answer is returned verbatim.
    expect(client.callLog).toEqual([]);
    expect(result.result).toContain('"status": "ok"');
  });
});
