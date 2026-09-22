// Generic OpenAI-compatible HTTP engine.
//
// The FIRST built-in `transport: "http"` engine. Where the CLI engines
// (claude/codex/gemini/bob) spawn a process per turn, this one keeps an
// in-flight `fetch` per Jinn sessionId instead: `kill()` aborts that request,
// `isAlive()` checks the in-flight map, `killAll()` aborts all.
//
// It talks to any OpenAI-compatible `/v1/chat/completions` endpoint (`stream:
// true`), parses the SSE token stream, forwards each delta via
// `opts.onStream({ type: "text", … })`, and accumulates the final text into
// `EngineResult.result`. `usage` (when the gateway emits it) is mapped to
// `contextTokens`/`cost`.
//
// One implementation, many named instances: config declares
// `engines.<name> = { impl: "openai", baseUrl, apiKey, model, … }` and the
// registry resolves every such block through the same `openai.plugin.ts`. See
// docs/design/http-engine-skeleton.md and engine-plugins.md.
//
// This is the direct realisation of the http-engine-skeleton handoff, brought
// in-tree as a built-in (rather than an external `module` package) so operators
// can point OpenBanto at a hosted model with a config edit / Web form and no
// `pnpm add`.
//
// MCP tool-calls: when `opts.mcpConfigPath` points at a resolved MCP config
// (the JSON `writeMcpConfigFile` emits), this engine connects an MCP client to
// each server (stdio or URL/SSE/HTTP), advertises every server's tools to the
// model as OpenAI `tools` namespaced `"<server>__<tool>"`, and runs a bounded
// NON-streaming tool-call loop (POST → run tool_calls via MCP → feed results
// back) until the model returns a final answer, which is streamed out. Without
// tools (no config / no servers) it uses the original streaming chat path
// unchanged. See ../mcp/tool-bridge.ts and docs/design/tools-mcp-wiring.md.
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import type { McpServerConfig } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { McpToolBridge, type BridgeDeps } from "../mcp/tool-bridge.js";

export interface OpenAiEngineConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Extra request headers merged onto Authorization/content-type. */
  headers?: Record<string, string>;
  /** Sampling temperature (omitted from the request when undefined). */
  temperature?: number;
  /** Engine name (defaults to "openai"); set to the config key by the plugin so
   *  multiple named instances report their own name. */
  name?: string;
  /** Test seam: override the MCP bridge (and its SDK deps). Production leaves
   *  this undefined so the real `@modelcontextprotocol/sdk` is used. */
  bridgeFactory?: (deps?: Partial<BridgeDeps>) => McpToolBridge;
  /** Test seam: partial deps forwarded to the default bridge factory. */
  bridgeDeps?: Partial<BridgeDeps>;
}

/** Upper bound on tool-call rounds so a model that keeps requesting tools can't
 *  loop forever. Each round is one chat.completions call + its tool executions. */
const MAX_TOOL_ROUNDS = 8;

/**
 * Strip raw tool-call markup from a summary-round answer. The summary round
 * sends NO tools, so the serving stack's tool-call parser is inactive — when
 * the model decides mid-task work should continue anyway, its native tool-call
 * markup (DeepSeek DSML: `<｜DSML｜tool_calls>…`, or other `<｜…｜>` special-token
 * families) arrives as plain TEXT and would leak verbatim to the user. Cut the
 * answer at the first such marker and keep only the prose prefix; the caller
 * falls back to a mechanical execution report when nothing readable remains.
 */
export function stripToolCallMarkup(content: string): string {
  if (!content) return "";
  // Fullwidth-bar (U+FF5C) special tokens and the ASCII-bar DSML variant.
  const m = content.search(/<[｜|]|<\/[｜|]/);
  const cut = m >= 0 ? content.slice(0, m) : content;
  return cut.trim();
}

/** Deterministic, model-free closing report built from the per-turn tool
 *  execution record — the fallback when the model cannot produce usable prose. */
function buildExecReport(execLog: Array<{ name: string; ok: boolean; ms: number }>): string {
  const ok = execLog.filter((c) => c.ok).length;
  const failed = execLog.length - ok;
  const lines = execLog.slice(-30).map((c) => `- ${c.name}: ${c.ok ? "成功" : "失敗"}`);
  return (
    "（モデルから最終まとめの応答を取得できなかったため、実行記録から機械生成した報告です）\n" +
    `このターンで実行したツール呼び出し: ${ok}件成功 / ${failed}件失敗\n` +
    lines.join("\n") +
    "\n※ 上記に無い作業は実行されていません。作業が途中の場合は続きを依頼してください。"
  );
}

/** One tool_call as returned by a non-streaming chat.completions response. */
interface ToolCall {
  id: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

/** Non-streaming chat.completions response (only the fields we read). */
interface ChatCompletion {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
      tool_calls?: ToolCall[];
    };
    finish_reason?: string | null;
  }>;
  usage?: ChatChunk["usage"];
}

/** A chat message we build for the tool-call loop. */
type ChatMessage =
  | { role: "system" | "user" | "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "assistant"; content: string | null; tool_calls: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** A single OpenAI chat.completion streaming chunk (only the fields we read). */
interface ChatChunk {
  choices?: Array<{
    delta?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    // Some gateways surface a cost figure; keep it best-effort.
    cost?: number;
  } | null;
}

export class OpenAiEngine implements InterruptibleEngine {
  name: string;
  private live = new Map<string, AbortController>();
  private baseUrl: string;
  private apiKey: string;
  private model: string;
  private headers: Record<string, string>;
  private temperature?: number;
  private bridgeFactory: (deps?: Partial<BridgeDeps>) => McpToolBridge;
  private bridgeDeps?: Partial<BridgeDeps>;
  /** Live MCP bridges keyed by sessionId, so kill()/killAll() can close them. */
  private liveBridges = new Map<string, McpToolBridge>();

  // MVP: OpenAI is 1 request = 1 turn, so "resume" has no server-side session to
  // rejoin. We keep a per-sessionId transcript so a resumed turn replays prior
  // context; this stays small and purely in-memory (lost on restart). Full
  // syncResume (transcript hand-back after a fallback) is out of scope — the
  // plugin advertises syncResume:false.
  private transcripts = new Map<string, Array<{ role: "user" | "assistant"; content: string }>>();

  constructor(cfg: OpenAiEngineConfig) {
    this.name = cfg.name ?? "openai";
    // Normalise trailing slash so `${baseUrl}/v1/...` never doubles up.
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
    this.apiKey = cfg.apiKey;
    this.model = cfg.model;
    this.headers = cfg.headers ?? {};
    this.temperature = cfg.temperature;
    this.bridgeFactory = cfg.bridgeFactory ?? ((deps) => new McpToolBridge(deps));
    this.bridgeDeps = cfg.bridgeDeps;
  }

  kill(sessionId: string): void {
    const ac = this.live.get(sessionId);
    if (ac) {
      ac.abort();
      this.live.delete(sessionId);
    }
    // Also tear down any MCP clients for this session (fire-and-forget).
    const bridge = this.liveBridges.get(sessionId);
    if (bridge) {
      this.liveBridges.delete(sessionId);
      void bridge.close();
    }
  }

  isAlive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  killAll(): void {
    for (const ac of this.live.values()) ac.abort();
    this.live.clear();
    for (const bridge of this.liveBridges.values()) void bridge.close();
    this.liveBridges.clear();
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const sid = opts.sessionId || opts.resumeSessionId || `openai-${randomUUID()}`;
    const ac = new AbortController();
    this.live.set(sid, ac);
    const startedAt = Date.now();

    const history = this.transcripts.get(sid) ?? [];
    const userContent = opts.attachments?.length
      ? `${opts.prompt}\n\nAttached files:\n${opts.attachments.map((a) => `- ${a}`).join("\n")}`
      : opts.prompt;

    const onStream = opts.onStream;

    // MCP tool-call path: if a config file is supplied and yields tools, run the
    // non-streaming tool-call loop. Any setup failure falls back to plain chat.
    let bridge: McpToolBridge | undefined;
    try {
      const servers = readMcpServers(opts.mcpConfigPath);
      if (servers && Object.keys(servers).length > 0) {
        bridge = this.bridgeFactory(this.bridgeDeps);
        this.liveBridges.set(sid, bridge);
        const n = await bridge.connect(servers);
        if (ac.signal.aborted) return { sessionId: sid, result: "", error: "interrupted" };
        if (n === 0) {
          // No usable tools came up — drop the bridge and use the plain path.
          await bridge.close();
          this.liveBridges.delete(sid);
          bridge = undefined;
        }
      }
    } catch (e: unknown) {
      // Never fail the turn on MCP setup problems; log (secret-free) and proceed.
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn(`[${this.name}] MCP setup failed, continuing without tools: ${msg.slice(0, 200)}`);
      if (bridge) {
        await bridge.close();
        this.liveBridges.delete(sid);
        bridge = undefined;
      }
    }

    if (onStream) onStream({ type: "status", content: `${this.name} is thinking…` });

    try {
      if (bridge && bridge.hasTools()) {
        return await this.runToolLoop(opts, sid, ac, startedAt, history, userContent, bridge);
      }
      return await this.runStreaming(opts, sid, ac, startedAt, history, userContent);
    } catch (e: unknown) {
      if (ac.signal.aborted) {
        return { sessionId: sid, result: "", error: "interrupted" };
      }
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`[${this.name}] request failed: ${msg}`);
      return { sessionId: sid, result: "", error: msg };
    } finally {
      this.live.delete(sid);
      // Always close MCP clients so no process/socket leaks past the turn.
      const b = this.liveBridges.get(sid);
      if (b) {
        this.liveBridges.delete(sid);
        await b.close();
      }
    }
  }

  /** The original streaming chat path (no tools). Unchanged behaviour. */
  private async runStreaming(
    opts: EngineRunOpts,
    sid: string,
    ac: AbortController,
    startedAt: number,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    userContent: string,
  ): Promise<EngineResult> {
    const onStream = opts.onStream;
    const messages = [
      ...(opts.systemPrompt ? [{ role: "system" as const, content: opts.systemPrompt }] : []),
      ...history,
      { role: "user" as const, content: userContent },
    ];

    const body: Record<string, unknown> = {
      model: opts.model || this.model,
      stream: true,
      // Opt into usage on the terminating SSE chunk where the gateway supports it.
      stream_options: { include_usage: true },
      messages,
    };
    if (typeof this.temperature === "number") body.temperature = this.temperature;

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      signal: ac.signal,
      headers: this.requestHeaders(),
      body: JSON.stringify(body),
    });

    if (!res.ok || !res.body) {
      const errText = await this.safeReadError(res);
      logger.error(`[${this.name}] HTTP ${res.status}${errText ? `: ${errText.slice(0, 500)}` : ""}`);
      const msg = this.friendlyError(res.status, errText);
      return { sessionId: sid, result: "", error: msg };
    }

    let text = "";
    let usage: ChatChunk["usage"] | undefined;
    for await (const chunk of parseSse(res.body, ac.signal)) {
      const delta = chunk.choices?.[0]?.delta?.content ?? "";
      if (delta) {
        text += delta;
        onStream?.({ type: "text", content: delta } satisfies StreamDelta);
      }
      if (chunk.usage) usage = chunk.usage;
    }

    history.push({ role: "user", content: userContent });
    history.push({ role: "assistant", content: text });
    this.transcripts.set(sid, history);

    const contextTokens = usage?.prompt_tokens;
    const cost = typeof usage?.cost === "number" ? usage.cost : undefined;
    return {
      sessionId: sid,
      result: text,
      durationMs: Date.now() - startedAt,
      ...(typeof contextTokens === "number" ? { contextTokens } : {}),
      ...(typeof cost === "number" ? { cost } : {}),
    };
  }

  /**
   * Non-streaming tool-call loop. While the model returns `tool_calls`, run each
   * via the MCP bridge, append the results as `{role:"tool"}` messages, and ask
   * again. Bounded by MAX_TOOL_ROUNDS. The final assistant text (the round with
   * no tool_calls) is streamed out via onStream and returned as `result`.
   */
  private async runToolLoop(
    opts: EngineRunOpts,
    sid: string,
    ac: AbortController,
    startedAt: number,
    history: Array<{ role: "user" | "assistant"; content: string }>,
    userContent: string,
    bridge: McpToolBridge,
  ): Promise<EngineResult> {
    const onStream = opts.onStream;
    const messages: ChatMessage[] = [
      ...(opts.systemPrompt ? [{ role: "system" as const, content: opts.systemPrompt }] : []),
      ...history.map((h) => ({ role: h.role, content: h.content }) as ChatMessage),
      { role: "user", content: userContent },
    ];
    const tools = bridge.getOpenAiTools();
    let usage: ChatChunk["usage"] | undefined;
    let finalText = "";
    // Authoritative per-turn tool execution record: drives the per-call INFO
    // logs, anchors the summary round to what actually ran (so the model can't
    // report planned-but-unexecuted work as done), and lets this turn fail
    // honestly when nothing ran at all. A call is "ok" only when the bridge
    // neither threw nor returned its `Error:`-prefixed failure string.
    const execLog: Array<{ name: string; ok: boolean; ms: number }> = [];

    for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
      if (ac.signal.aborted) return { sessionId: sid, result: "", error: "interrupted" };

      const body: Record<string, unknown> = {
        model: opts.model || this.model,
        stream: false,
        messages,
        tools,
        tool_choice: "auto",
      };
      if (typeof this.temperature === "number") body.temperature = this.temperature;

      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        signal: ac.signal,
        headers: this.requestHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await this.safeReadError(res);
        logger.error(`[${this.name}] HTTP ${res.status}${errText ? `: ${errText.slice(0, 500)}` : ""}`);
        const msg = this.friendlyError(res.status, errText);
        return { sessionId: sid, result: "", error: msg };
      }
      const completion = (await res.json()) as ChatCompletion;
      if (completion.usage) usage = completion.usage;
      const message = completion.choices?.[0]?.message;
      const toolCalls = message?.tool_calls ?? [];

      if (toolCalls.length === 0) {
        // Final answer: stream it out and finish.
        finalText = message?.content ?? "";
        if (finalText) onStream?.({ type: "text", content: finalText } satisfies StreamDelta);
        break;
      }

      // Record the assistant's tool-call turn, then execute each call.
      messages.push({ role: "assistant", content: message?.content ?? null, tool_calls: toolCalls });

      for (const call of toolCalls) {
        if (ac.signal.aborted) return { sessionId: sid, result: "", error: "interrupted" };
        const name = call.function?.name ?? "";
        onStream?.({ type: "status", content: `calling ${name}…` } satisfies StreamDelta);
        onStream?.({ type: "tool_use", content: name, toolName: name, toolId: call.id } satisfies StreamDelta);

        let args: Record<string, unknown> = {};
        const rawArgs = call.function?.arguments;
        if (rawArgs) {
          try {
            args = JSON.parse(rawArgs) as Record<string, unknown>;
          } catch {
            // Malformed arguments — feed the error back so the model can retry.
            messages.push({
              role: "tool",
              tool_call_id: call.id,
              content: `Error: could not parse tool arguments as JSON`,
            });
            execLog.push({ name, ok: false, ms: 0 });
            logger.info(`[${this.name}] tool ${name} FAILED in 0ms (malformed arguments) (session ${sid})`);
            continue;
          }
        }

        let toolResult: string;
        const calledAt = Date.now();
        let callThrew = false;
        try {
          toolResult = await bridge.callTool(name, args);
        } catch (e: unknown) {
          const m = e instanceof Error ? e.message : String(e);
          toolResult = `Error: tool "${name}" failed: ${m.slice(0, 300)}`;
          callThrew = true;
        }
        const callMs = Date.now() - calledAt;
        // The bridge reports unknown tools / disconnected servers / MCP isError
        // results as an `Error:`-prefixed string instead of throwing.
        const callOk = !callThrew && !toolResult.startsWith("Error:");
        execLog.push({ name, ok: callOk, ms: callMs });
        // Include a one-line result preview: an MCP call can be transport-"ok"
        // while its payload is really a failure message, and the preview is how
        // that shows up in the log without replaying the turn.
        const preview = toolResult.replace(/\s+/g, " ").slice(0, 120);
        logger.info(`[${this.name}] tool ${name} ${callOk ? "ok" : "FAILED"} in ${callMs}ms (${toolResult.length} chars) preview="${preview}" (session ${sid})`);
        onStream?.({ type: "tool_result", content: toolResult, toolName: name, toolId: call.id } satisfies StreamDelta);
        messages.push({ role: "tool", tool_call_id: call.id, content: toolResult });
      }
      // Loop again with the tool results appended.
    }

    let turnError: string | undefined;
    if (!finalText && !ac.signal.aborted) {
      // The tool loop ended without a final prose answer — either
      // MAX_TOOL_ROUNDS was exhausted mid-workflow or the model returned empty
      // content on its last turn (observed with DeepSeek-V4 on vLLM after a
      // burst of tool calls). An empty result propagates to the caller as
      // "(no output)" and reads as "nothing happened" even though the tools
      // may have run with side effects — so ask once more, with tool use
      // disabled, to force a closing report. The nudge is a `user` turn on
      // purpose: the same models return empty content again when the
      // transcript ends with a `system` message.
      const okCalls = execLog.filter((c) => c.ok).length;
      const failedCalls = execLog.length - okCalls;
      logger.warn(`[${this.name}] tool loop ended without final text (tool calls: ${okCalls} ok / ${failedCalls} failed) — requesting a tool-less summary round`);
      if (execLog.length === 0) {
        // Nothing ran at all. Asking the model to "summarize" an empty turn is
        // how fabricated success reports are born — it writes up the work it
        // INTENDED to do as if it had happened. Skip the model and fail the
        // turn honestly instead.
        finalText =
          "（このターンではツールを一度も実行できず、モデルからの最終応答もありませんでした。作業は行われていません。依頼を分割するか、もう一度お試しください。）";
        turnError = "tool loop produced no output and executed no tool calls";
      } else {
        // Anchor the summary to the authoritative execution record so the
        // model cannot pass off unexecuted work as done.
        const digest = execLog
          .slice(-30)
          .map((c) => `- ${c.name}: ${c.ok ? "ok" : "FAILED"}`)
          .join("\n");
        messages.push({
          role: "user",
          content:
            "(system note) Tools are no longer available for this turn. This is the AUTHORITATIVE record of the tool calls that actually executed in this turn:\n" +
            digest +
            "\nWrite the final report for the requester STRICTLY from this record and the tool results above. " +
            "Only actions marked ok actually happened. Anything not in this record — including work you planned or intended — " +
            "was NOT executed and must be reported as not done. Do not invent file names, IDs, or results. " +
            "Reply in the same language as the original request. Do not print tool-call JSON.",
        });
        try {
          const body: Record<string, unknown> = {
            model: opts.model || this.model,
            stream: false,
            messages,
            tools,
            tool_choice: "none",
          };
          if (typeof this.temperature === "number") body.temperature = this.temperature;
          const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
            method: "POST",
            signal: ac.signal,
            headers: this.requestHeaders(),
            body: JSON.stringify(body),
          });
          if (res.ok) {
            const completion = (await res.json()) as ChatCompletion;
            if (completion.usage) usage = completion.usage;
            const rawSummary = completion.choices?.[0]?.message?.content ?? "";
            finalText = stripToolCallMarkup(rawSummary);
            if (rawSummary && finalText.length < rawSummary.trim().length) {
              // The model tried to CONTINUE the work instead of summarizing —
              // with no tools in the request its native tool-call markup came
              // back as plain text and must never reach the user.
              logger.warn(`[${this.name}] summary round emitted raw tool-call markup — stripped ${rawSummary.length - finalText.length} chars`);
            }
            if (finalText) onStream?.({ type: "text", content: finalText } satisfies StreamDelta);
          } else {
            const errText = await this.safeReadError(res);
            logger.error(`[${this.name}] summary round HTTP ${res.status}${errText ? `: ${errText.slice(0, 300)}` : ""}`);
          }
        } catch (e: unknown) {
          if (ac.signal.aborted) return { sessionId: sid, result: "", error: "interrupted" };
          logger.warn(`[${this.name}] summary round failed: ${e instanceof Error ? e.message : e}`);
        }
        if (!finalText) {
          // Last resort: never end a tool-running turn with an empty success —
          // downstream treats "" as "no work happened" and drops the message.
          // Model-free by design: at this point the model has already failed
          // twice to produce prose, so report the execution record verbatim.
          finalText = buildExecReport(execLog);
          onStream?.({ type: "text", content: finalText } satisfies StreamDelta);
        }
        if (okCalls === 0) {
          // Every call failed and the model produced no organic final answer —
          // never let this surface as a successful completion.
          turnError = `all ${execLog.length} tool call(s) failed`;
        }
      }
    }

    // Persist the user turn + final assistant text for a later resume.
    history.push({ role: "user", content: userContent });
    history.push({ role: "assistant", content: finalText });
    this.transcripts.set(sid, history);

    const contextTokens = usage?.prompt_tokens;
    const cost = typeof usage?.cost === "number" ? usage.cost : undefined;
    return {
      sessionId: sid,
      result: finalText,
      ...(turnError ? { error: turnError } : {}),
      durationMs: Date.now() - startedAt,
      ...(typeof contextTokens === "number" ? { contextTokens } : {}),
      ...(typeof cost === "number" ? { cost } : {}),
    };
  }

  /** Common request headers (auth + content-type + configured extras). */
  private requestHeaders(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
      ...this.headers,
    };
  }

  /** Read an error body defensively (never throws, bounded). */
  private async safeReadError(res: Response): Promise<string> {
    try {
      return (await res.text()) || res.statusText || "";
    } catch {
      return res.statusText || "";
    }
  }

  /**
   * Turn an upstream error into an actionable message. Context-length 400s
   * (input exceeds the model's window) become a user-friendly note instead of
   * a raw provider error (#509). Other errors keep the raw "<name> HTTP <status>: …".
   */
  private friendlyError(status: number, errText: string): string {
    const t = errText || "";
    const isCtx =
      status === 400 &&
      /context length|context window|maximum context|input_tokens|too many tokens|reduce the length/i.test(
        t,
      );
    if (isCtx) {
      const maxM = t.match(/maximum context length is\s+(\d+)/i);
      const gotM =
        t.match(/contains at least\s+(\d+)/i) || t.match(/(\d+)\s+input tokens/i);
      const max = maxM ? maxM[1] : null;
      const got = gotM ? gotM[1] : null;
      let m = "⚠️ 入力が長すぎます。";
      if (max && got)
        m += `このモデルのコンテキスト上限 ${max} トークンに対し、入力が約 ${got} トークンあります。`;
      else if (max) m += `このモデルのコンテキスト上限は ${max} トークンです。`;
      m += "依頼や対象データを小さく分割するか、範囲を絞って再度お試しください。";
      return m;
    }
    return `${this.name} HTTP ${status}${errText ? `: ${errText.slice(0, 500)}` : ""}`;
  }
}

/**
 * Read an MCP config file and return its `mcpServers` map, or undefined when
 * there is no path, the file is missing, or it can't be parsed. Never throws.
 */
function readMcpServers(mcpConfigPath?: string): Record<string, McpServerConfig> | undefined {
  if (!mcpConfigPath) return undefined;
  try {
    if (!fs.existsSync(mcpConfigPath)) return undefined;
    const raw = fs.readFileSync(mcpConfigPath, "utf8");
    const parsed = JSON.parse(raw) as { mcpServers?: Record<string, McpServerConfig> };
    return parsed.mcpServers ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Parse an OpenAI-style SSE stream into decoded JSON chunks. Handles
 * multi-line `data:` frames, the `[DONE]` sentinel, and partial frames split
 * across network reads. Yields one parsed object per complete `data:` payload;
 * non-JSON payloads are skipped. Exported for unit testing.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<ChatChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by a blank line. Process each complete event.
      let sep: number;
      while ((sep = indexOfEventBoundary(buffer)) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^(\r?\n){1,2}/, "");
        const payload = extractData(rawEvent);
        if (payload === null) continue;
        if (payload === "[DONE]") return;
        const parsed = tryParse(payload);
        if (parsed) yield parsed;
      }
    }
    // Flush any trailing event without a terminating blank line.
    const tail = extractData(buffer);
    if (tail && tail !== "[DONE]") {
      const parsed = tryParse(tail);
      if (parsed) yield parsed;
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/** Index of the end of the first complete SSE event (the blank-line boundary),
 *  or -1 if no complete event is buffered yet. */
function indexOfEventBoundary(buf: string): number {
  const lf = buf.indexOf("\n\n");
  const crlf = buf.indexOf("\r\n\r\n");
  if (lf === -1) return crlf;
  if (crlf === -1) return lf;
  return Math.min(lf, crlf);
}

/** Join all `data:` lines of one SSE event into a single payload string, or
 *  null if the event carries no data line. */
function extractData(rawEvent: string): string | null {
  const lines = rawEvent.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }
  if (dataLines.length === 0) return null;
  return dataLines.join("\n").trim();
}

function tryParse(payload: string): ChatChunk | null {
  try {
    return JSON.parse(payload) as ChatChunk;
  } catch {
    return null;
  }
}
