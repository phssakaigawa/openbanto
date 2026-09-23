import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { OpenAiEngine, fabricationGuardNote, appendGuardNote } from "../openai.js";
import type { McpClientLike, BridgeDeps, McpToolDef, McpCallToolResult } from "../../mcp/tool-bridge.js";

// Fabrication guard (#594): a DeepSeek-class model answered an onboarding
// request with a fully invented success report — resource-list JSON and all —
// without emitting a single tool call, so every summary-round anchor was
// bypassed and the fiction reached the user verbatim. These tests pin the
// engine-side cross-check of the final text against the authoritative
// per-turn execution record.

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
  const p = path.join(os.tmpdir(), `mcp-test-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify({ mcpServers }));
  tmpFiles.push(p);
  return p;
}

const PROV_TOOLS = [
  "provisioner__plan_provision",
  "provisioner__provision_app",
  "provisioner__check_provision",
];

describe("fabricationGuardNote", () => {
  it("flags a completion claim for an available tool that never executed", () => {
    const text =
      "provision_app の実行に成功しました。作成されたリソース:\n" +
      '{"namespace":"demo-app","serviceAccount":"demo-app-agent"}';
    const note = fabricationGuardNote(text, PROV_TOOLS, []);
    expect(note).toContain("provision_app");
    expect(note).toContain("実行されていません");
    expect(note).toContain("ツールは一度も実行されていません");
  });

  it("lists what actually ran when a different tool executed", () => {
    const text = "provision_app を実行完了しました。namespace は作成済みです。";
    const note = fabricationGuardNote(text, PROV_TOOLS, [
      { name: "provisioner__plan_provision", ok: true },
    ]);
    expect(note).toContain("provision_app はこのターンで実行されていません");
    expect(note).toContain("provisioner__plan_provision: 成功");
  });

  it("stays silent when the mentioned tool really executed (bare-name match)", () => {
    const text = "provision_app の実行が完了しました。KAS 接続も確認済みです。";
    const note = fabricationGuardNote(text, PROV_TOOLS, [
      { name: "provisioner__provision_app", ok: true },
    ]);
    expect(note).toBeNull();
  });

  it("stays silent on a plan→approval turn (intent phrasing, no completion claim nearby)", () => {
    const text =
      "計画は以下のとおりです。承認いただけましたら provision_app を confirm=true で実行します。よろしいですか?";
    const note = fabricationGuardNote(text, PROV_TOOLS, [
      { name: "provisioner__plan_provision", ok: true },
    ]);
    expect(note).toBeNull();
  });

  it("stays silent on plain conversation without completion claims", () => {
    const note = fabricationGuardNote("承知しました。対象のプロジェクトパスを教えてください。", PROV_TOOLS, []);
    expect(note).toBeNull();
  });

  it("flags a no-tool turn that claims completion even without naming a tool", () => {
    const text = "✅ namespace の作成が完了しました。すべてのリソースを作成済みです。";
    const note = fabricationGuardNote(text, PROV_TOOLS, []);
    expect(note).toContain("ツールは一度も実行されていません");
  });

  it("stays silent when tools ran and the text names none it didn't run", () => {
    const text = "計画の作成が完了しました。差分は以下のとおりです。";
    const note = fabricationGuardNote(text, PROV_TOOLS, [
      { name: "provisioner__plan_provision", ok: true },
    ]);
    expect(note).toBeNull();
  });

  it("stays silent with no tools available (plain chat session)", () => {
    expect(fabricationGuardNote("作業が完了しました。", [], [])).toBeNull();
  });
});

describe("appendGuardNote", () => {
  it("appends after the prose when there is no choices marker", () => {
    expect(appendGuardNote("done.", "NOTE")).toBe("done.\n\nNOTE");
  });

  it("keeps a trailing [[choices: …]] marker as the final line", () => {
    const out = appendGuardNote("実行しますか?\n\n[[choices: 続けて|中止]]", "NOTE");
    expect(out).toBe("実行しますか?\n\nNOTE\n[[choices: 続けて|中止]]");
    expect(out.trimEnd().endsWith("[[choices: 続けて|中止]]")).toBe(true);
  });
});

describe("OpenAiEngine fabrication guard integration", () => {
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

  const PROV_TOOL_DEFS: McpToolDef[] = [
    { name: "plan_provision", description: "dry-run", inputSchema: { type: "object" } },
    { name: "provision_app", description: "onboard", inputSchema: { type: "object" } },
    { name: "check_provision", description: "check", inputSchema: { type: "object" } },
  ];

  it("co-reports the execution record when the model fabricates a success report without any tool call", async () => {
    const client = new FakeMcpClient(PROV_TOOL_DEFS, {});
    // Single round: no tool_calls, just an invented completion report. The
    // resource JSON carries no tool/name/function key, so the text-form
    // tool-call recovery must not fire either.
    const responses: Response[] = [
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content:
                  "provision_app の実行に成功しました。作成されたリソース:\n" +
                  '{"namespace":"demo-app","role":"demo-app-agent"}',
              },
            },
          ],
          usage: { prompt_tokens: 50 },
        }),
        { status: 200 },
      ),
    ];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => responses[call++]));

    const engine = new OpenAiEngine({
      baseUrl: "https://x",
      apiKey: "k",
      model: "m",
      name: "openai-guard",
      bridgeDeps: fakeDeps(client),
    });
    const result = await engine.run({
      prompt: "demo-app を受け入れて",
      cwd: "/tmp",
      sessionId: "g1",
      mcpConfigPath: writeConfig({ "provisioner": { url: "https://mcp" } }),
    });

    expect(client.callLog).toEqual([]);
    expect(result.result).toContain("provision_app の実行に成功しました");
    expect(result.result).toContain("実行記録(システム自動付記)");
    expect(result.result).toContain("provision_app はこのターンで実行されていません");
    expect(result.executedToolCalls).toBeUndefined();
  });

  it("does not annotate an honest turn where the reported tool actually ran", async () => {
    const client = new FakeMcpClient(PROV_TOOL_DEFS, {
      check_provision: { content: [{ type: "text", text: "namespace demo-app: なし" }] },
    });
    const responses: Response[] = [
      new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  { id: "c1", type: "function", function: { name: "provisioner__check_provision", arguments: '{"namespace":"demo-app"}' } },
                ],
              },
            },
          ],
        }),
        { status: 200 },
      ),
      new Response(
        JSON.stringify({
          choices: [
            { message: { role: "assistant", content: "check_provision の確認が完了しました。namespace はまだありません。" } },
          ],
          usage: { prompt_tokens: 80 },
        }),
        { status: 200 },
      ),
    ];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => responses[call++]));

    const engine = new OpenAiEngine({
      baseUrl: "https://x",
      apiKey: "k",
      model: "m",
      name: "openai-guard-2",
      bridgeDeps: fakeDeps(client),
    });
    const result = await engine.run({
      prompt: "demo-app の状態を確認して",
      cwd: "/tmp",
      sessionId: "g2",
      mcpConfigPath: writeConfig({ "provisioner": { url: "https://mcp" } }),
    });

    expect(result.result).toBe("check_provision の確認が完了しました。namespace はまだありません。");
    expect(result.result).not.toContain("実行記録(システム自動付記)");
    expect(result.executedToolCalls).toEqual([{ name: "provisioner__check_provision", ok: true }]);
  });
});

// ---- No-tools fallback guard (#594 follow-up) ------------------------------
// When MCP servers are configured but none connect (e.g. a header the fetch
// ByteString conversion rejects), the turn falls back to plain streaming with
// no tool loop at all — the guard must still mark fabricated "work done" prose.

import { noToolsGuardNote } from "../openai.js";

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

describe("noToolsGuardNote", () => {
  it("flags completion claims", () => {
    expect(noToolsGuardNote("provision_app の実行に成功しました。✅ 完了です。")).toContain(
      "ツールに接続できず",
    );
  });
  it("stays silent without completion claims", () => {
    expect(noToolsGuardNote("承知しました。どのように進めますか?")).toBeNull();
    expect(noToolsGuardNote("")).toBeNull();
  });
});

describe("OpenAiEngine no-tools fallback guard integration", () => {
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

  it("marks a fabricated report when MCP was configured but zero tools connected", async () => {
    const client = new FakeMcpClient([], {}); // server connects but yields no tools
    const fabricated =
      "provision_app を実行しました。✅ 受け入れ完了です。実行レシート: fake-001";
    const responses: Response[] = [
      new Response(
        streamFromChunks([
          sseData({ choices: [{ delta: { content: fabricated } }] }),
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      ),
    ];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => responses[call++]));

    const engine = new OpenAiEngine({
      baseUrl: "https://x",
      apiKey: "k",
      model: "m",
      name: "openai-notools",
      bridgeDeps: fakeDeps(client),
    });
    const result = await engine.run({
      prompt: "demo-app を受け入れて",
      cwd: "/tmp",
      sessionId: "nt1",
      mcpConfigPath: writeConfig({ provisioner: { url: "https://mcp" } }),
    });

    expect(result.result).toContain(fabricated);
    expect(result.result).toContain("ツールに接続できず");
    expect(result.error).toBeUndefined();
  });

  it("does not annotate a plain-chat session without MCP config", async () => {
    const responses: Response[] = [
      new Response(
        streamFromChunks([
          sseData({ choices: [{ delta: { content: "整理が完了しました。以上です。" } }] }),
          "data: [DONE]\n\n",
        ]),
        { status: 200 },
      ),
    ];
    let call = 0;
    vi.stubGlobal("fetch", vi.fn(async () => responses[call++]));

    const engine = new OpenAiEngine({ baseUrl: "https://x", apiKey: "k", model: "m", name: "openai-plain" });
    const result = await engine.run({ prompt: "まとめて", cwd: "/tmp", sessionId: "nt2" });

    expect(result.result).toBe("整理が完了しました。以上です。");
    expect(result.result).not.toContain("システム自動付記");
  });
});
