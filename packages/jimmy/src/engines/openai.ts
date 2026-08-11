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
import { randomUUID } from "node:crypto";
import type { InterruptibleEngine, EngineRunOpts, EngineResult, StreamDelta } from "../shared/types.js";
import { logger } from "../shared/logger.js";

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
}

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
  }

  kill(sessionId: string): void {
    const ac = this.live.get(sessionId);
    if (ac) {
      ac.abort();
      this.live.delete(sessionId);
    }
  }

  isAlive(sessionId: string): boolean {
    return this.live.has(sessionId);
  }

  killAll(): void {
    for (const ac of this.live.values()) ac.abort();
    this.live.clear();
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const sid = opts.sessionId || opts.resumeSessionId || `openai-${randomUUID()}`;
    const ac = new AbortController();
    this.live.set(sid, ac);
    const startedAt = Date.now();

    // TODO(tool-call/MCP): advertise the tools from opts.mcpConfigPath as OpenAI
    // "tools", loop on delta.tool_calls, run each via an MCP client, and feed
    // results back until final. Out of scope for this PR — mcpConfigPath is
    // intentionally ignored here so we ship a reliable "conversation" engine first.

    const history = this.transcripts.get(sid) ?? [];
    const userContent = opts.attachments?.length
      ? `${opts.prompt}\n\nAttached files:\n${opts.attachments.map((a) => `- ${a}`).join("\n")}`
      : opts.prompt;

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

    const onStream = opts.onStream;
    if (onStream) onStream({ type: "status", content: `${this.name} is thinking…` });

    try {
      const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: "POST",
        signal: ac.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.apiKey}`,
          ...this.headers,
        },
        body: JSON.stringify(body),
      });

      if (!res.ok || !res.body) {
        const errText = await this.safeReadError(res);
        // NEVER echo the request (it carries no key, but be conservative anyway).
        const msg = `${this.name} HTTP ${res.status}${errText ? `: ${errText.slice(0, 500)}` : ""}`;
        logger.error(`[${this.name}] ${msg}`);
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

      // Persist the turn so a later resume of this sessionId keeps context.
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
    } catch (e: unknown) {
      if (ac.signal.aborted) {
        return { sessionId: sid, result: "", error: "interrupted" };
      }
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`[${this.name}] request failed: ${msg}`);
      return { sessionId: sid, result: "", error: msg };
    } finally {
      this.live.delete(sid);
    }
  }

  /** Read an error body defensively (never throws, bounded). */
  private async safeReadError(res: Response): Promise<string> {
    try {
      return (await res.text()) || res.statusText || "";
    } catch {
      return res.statusText || "";
    }
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
