// Tests for the tool-loop context-budget guard and the sentence-safe summary
// stripping in the OpenAI-compatible HTTP engine:
//  - truncateToolResult / compactOldToolResults / estimateTokensFromChars keep
//    the tool-loop transcript inside the model's context window;
//  - a context-length 400 mid-loop falls back to the summary round instead of
//    killing the turn;
//  - trimToLastCompleteSentence + the mechanical execution digest keep a
//    markup-stripped summary from ending mid-sentence.
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  OpenAiEngine,
  truncateToolResult,
  compactOldToolResults,
  estimateTokensFromChars,
  trimToLastCompleteSentence,
  type ChatMessage,
} from "../openai.js";
import type { StreamDelta } from "../../shared/types.js";
import type { McpClientLike, BridgeDeps, McpToolDef, McpCallToolResult } from "../../mcp/tool-bridge.js";

// ---- Fakes (same shape as openai.mcp.test.ts) ------------------------------

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

function fakeDeps(client: FakeMcpClient): Partial<BridgeDeps> {
  return {
    createClient: () => client,
    createStdioTransport: () => ({ kind: "stdio" }),
    createUrlTransport: () => ({ kind: "url" }),
  };
}

const tmpFiles: string[] = [];
function writeConfig(mcpServers: Record<string, unknown>): string {
  const p = path.join(os.tmpdir(), `mcp-ctx-test-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ mcpServers }));
  tmpFiles.push(p);
  return p;
}

/** A round-1 response asking for one `fetcher__fetch_page` call. */
function toolCallResponse(usage?: Record<string, number>): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_1", type: "function", function: { name: "fetcher__fetch_page", arguments: '{"url":"https://e.x/a"}' } },
            ],
          },
        },
      ],
      ...(usage ? { usage } : {}),
    }),
    { status: 200 },
  );
}

function finalResponse(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
  });
}

// ---- Pure helpers -----------------------------------------------------------

describe("truncateToolResult", () => {
  it("passes short results through untouched", () => {
    expect(truncateToolResult("short", 100)).toBe("short");
  });
  it("caps long results and appends an explicit truncation note", () => {
    const out = truncateToolResult("x".repeat(10_000), 4000);
    expect(out.startsWith("x".repeat(4000))).toBe(true);
    expect(out).toContain("truncated");
    expect(out).toContain("10000");
    expect(out.length).toBeLessThan(4200);
  });
});

describe("compactOldToolResults", () => {
  const tool = (content: string): ChatMessage => ({ role: "tool", tool_call_id: "c", content });
  it("compacts all but the most recent N tool results and reports the count", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "q" },
      tool("A".repeat(1000)),
      tool("B".repeat(1000)),
      tool("C".repeat(1000)),
    ];
    const n = compactOldToolResults(messages, 2, 100);
    expect(n).toBe(1);
    const first = messages[1] as Extract<ChatMessage, { role: "tool" }>;
    expect(first.content.startsWith("A".repeat(100))).toBe(true);
    expect(first.content).toContain("compacted");
    expect(first.content.length).toBeLessThan(200);
    // recent two untouched
    expect((messages[2] as any).content).toBe("B".repeat(1000));
    expect((messages[3] as any).content).toBe("C".repeat(1000));
  });
  it("is idempotent across rounds", () => {
    const messages: ChatMessage[] = [tool("A".repeat(1000)), tool("B".repeat(1000))];
    expect(compactOldToolResults(messages, 1, 100)).toBe(1);
    const once = (messages[0] as any).content;
    expect(compactOldToolResults(messages, 1, 100)).toBe(0);
    expect((messages[0] as any).content).toBe(once);
  });
});

describe("estimateTokensFromChars", () => {
  it("is a conservative chars/2 ceiling", () => {
    expect(estimateTokensFromChars(0)).toBe(0);
    expect(estimateTokensFromChars(3)).toBe(2);
    expect(estimateTokensFromChars(4000)).toBe(2000);
  });
});

describe("trimToLastCompleteSentence", () => {
  it("cuts a Japanese fragment back to the last 。", () => {
    expect(trimToLastCompleteSentence("制約があります。しかし「")).toBe("制約があります。");
  });
  it("keeps closing quotes/brackets attached to the sentence end", () => {
    expect(trimToLastCompleteSentence("「完了しました。」その後に途中の")).toBe("「完了しました。」");
  });
  it("cuts English back to the last period (not decimals)", () => {
    expect(trimToLastCompleteSentence("Version 3.5 is fine. However the")).toBe("Version 3.5 is fine.");
    expect(trimToLastCompleteSentence("uses version 3.5 and then")).toBe("");
  });
  it("treats a newline as a safe boundary (lists without punctuation)", () => {
    expect(trimToLastCompleteSentence("- item one\n- item two partial")).toBe("- item one");
  });
  it("returns empty when no complete sentence survives", () => {
    expect(trimToLastCompleteSentence("しかし「")).toBe("");
    expect(trimToLastCompleteSentence("")).toBe("");
  });
  it("returns the text unchanged when it already ends at a boundary", () => {
    expect(trimToLastCompleteSentence("全て完了しました。")).toBe("全て完了しました。");
    expect(trimToLastCompleteSentence("Done!")).toBe("Done!");
  });
});

// ---- Engine-level behaviour --------------------------------------------------

describe("OpenAiEngine tool-loop context budget", () => {
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

  function makeEngine(client: FakeMcpClient, contextWindowTokens?: number): OpenAiEngine {
    return new OpenAiEngine({
      baseUrl: "https://x",
      apiKey: "k",
      model: "m",
      name: "openai-1",
      bridgeDeps: fakeDeps(client),
      ...(contextWindowTokens ? { contextWindowTokens } : {}),
    });
  }

  const fetchTool: McpToolDef = {
    name: "fetch_page",
    description: "Fetch a page",
    inputSchema: { type: "object", properties: { url: { type: "string" } } },
  };

  it("truncates oversized tool results before they enter the transcript", async () => {
    const huge = "P".repeat(20_000);
    const client = new FakeMcpClient([fetchTool], {
      fetch_page: { content: [{ type: "text", text: huge }] },
    });
    const sentBodies: any[] = [];
    const responses = [toolCallResponse(), finalResponse("done.")];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBodies.push(JSON.parse(init.body as string));
        return responses[call++];
      }),
    );

    const result = await makeEngine(client).run({
      prompt: "collect the page",
      cwd: "/tmp",
      sessionId: "trunc-1",
      mcpConfigPath: writeConfig({ fetcher: { command: "srv", args: [] } }),
    });

    expect(result.error).toBeUndefined();
    const toolMsg = sentBodies[1].messages.find((m: any) => m.role === "tool");
    expect(toolMsg.content.length).toBeLessThan(4200);
    expect(toolMsg.content).toContain("truncated");
    expect(toolMsg.content.startsWith("P".repeat(4000))).toBe(true);
  });

  it("stops the loop on the context budget and closes via a tool-less summary round", async () => {
    const client = new FakeMcpClient([fetchTool], {
      fetch_page: { content: [{ type: "text", text: "page text ".repeat(200) }] },
    });
    const sentBodies: any[] = [];
    const responses = [
      // Round 1: asks for a tool AND reports usage near the (tiny) window.
      toolCallResponse({ prompt_tokens: 900, completion_tokens: 50 }),
      // Next call must already be the summary round (tool_choice "none").
      finalResponse("ここまでの収集結果を報告します。"),
    ];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBodies.push(JSON.parse(init.body as string));
        return responses[call++];
      }),
    );

    const result = await makeEngine(client, 1000).run({
      prompt: "collect pages",
      cwd: "/tmp",
      sessionId: "budget-1",
      mcpConfigPath: writeConfig({ fetcher: { command: "srv", args: [] } }),
    });

    expect(sentBodies).toHaveLength(2);
    expect(sentBodies[0].tool_choice).toBe("auto");
    expect(sentBodies[1].tool_choice).toBe("none");
    expect(result.result).toBe("ここまでの収集結果を報告します。");
    expect(result.error).toBeUndefined();
    expect(client.callLog).toHaveLength(1); // the one executed call, then budget stop
  });

  it("falls back to the summary round on a context-length 400 mid-loop instead of failing the turn", async () => {
    const client = new FakeMcpClient([fetchTool], {
      fetch_page: { content: [{ type: "text", text: "lots of page text" }] },
    });
    const sentBodies: any[] = [];
    const responses = [
      toolCallResponse(),
      new Response(
        "This model's maximum context length is 65536 tokens. However, you requested 0 output tokens and your prompt contains at least 65537 input tokens",
        { status: 400 },
      ),
      finalResponse("途中でコンテキスト上限に達したため、ここまでの結果を報告します。"),
    ];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sentBodies.push(JSON.parse(init.body as string));
        return responses[call++];
      }),
    );

    const deltas: StreamDelta[] = [];
    const result = await makeEngine(client).run({
      prompt: "collect pages",
      cwd: "/tmp",
      sessionId: "ctx400-1",
      mcpConfigPath: writeConfig({ fetcher: { command: "srv", args: [] } }),
      onStream: (d) => deltas.push(d),
    });

    expect(result.error).toBeUndefined();
    expect(result.result).toBe("途中でコンテキスト上限に達したため、ここまでの結果を報告します。");
    expect(sentBodies[2].tool_choice).toBe("none");
    // The summary prompt tells the model the turn was cut short.
    const note = sentBodies[2].messages[sentBodies[2].messages.length - 1];
    expect(note.role).toBe("user");
    expect(note.content).toContain("cut short");
  });

  it("keeps a non-context 400 as a failed turn (unchanged behaviour)", async () => {
    const client = new FakeMcpClient([fetchTool], {
      fetch_page: { content: [{ type: "text", text: "irrelevant" }] },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad request: invalid tool schema", { status: 400 })),
    );
    const result = await makeEngine(client).run({
      prompt: "collect",
      cwd: "/tmp",
      sessionId: "bad400-1",
      mcpConfigPath: writeConfig({ fetcher: { command: "srv", args: [] } }),
    });
    expect(result.error).toBeTruthy();
    expect(result.result).toBe("");
  });

  it("summary round: trims a markup-cut summary to complete sentences and co-reports the execution record", async () => {
    const client = new FakeMcpClient([fetchTool], {
      fetch_page: { content: [{ type: "text", text: "page body" }] },
    });
    const responses = [
      toolCallResponse(),
      // Round 2: model returns EMPTY content (observed DeepSeek behaviour) →
      // engine asks for a tool-less summary.
      finalResponse(""),
      // Summary round: prose that degrades into DSML markup mid-sentence.
      finalResponse("ページの収集は完了しました。しかし「<｜DSML｜>tool_calls begin<｜DSML｜>fetch_page"),
    ];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responses[call++]),
    );

    const result = await makeEngine(client).run({
      prompt: "collect the page",
      cwd: "/tmp",
      sessionId: "dsml-1",
      mcpConfigPath: writeConfig({ fetcher: { command: "srv", args: [] } }),
    });

    // Complete-sentence prefix survives; the dangling fragment does not.
    expect(result.result).toContain("ページの収集は完了しました。");
    expect(result.result).not.toContain("しかし「");
    expect(result.result).not.toContain("<｜");
    // The mechanical record is always co-reported with the truncation notice.
    expect(result.result).toContain("報告が途中で途切れた");
    expect(result.result).toContain("fetcher__fetch_page: 成功");
    expect(result.error).toBeUndefined();
  });

  it("summary round: falls back to the mechanical report when nothing readable remains after stripping", async () => {
    const client = new FakeMcpClient([fetchTool], {
      fetch_page: { content: [{ type: "text", text: "page body" }] },
    });
    const responses = [
      toolCallResponse(),
      finalResponse(""),
      // Summary is pure markup → stripped to "", no complete sentence.
      finalResponse("<｜DSML｜>tool_calls begin<｜DSML｜>fetch_page"),
    ];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => responses[call++]),
    );

    const result = await makeEngine(client).run({
      prompt: "collect the page",
      cwd: "/tmp",
      sessionId: "dsml-2",
      mcpConfigPath: writeConfig({ fetcher: { command: "srv", args: [] } }),
    });

    expect(result.result).not.toContain("<｜");
    expect(result.result).toContain("報告が途中で途切れた");
    expect(result.result).toContain("fetcher__fetch_page: 成功");
    expect(result.error).toBeUndefined();
  });
});
