import { describe, it, expect, vi, afterEach } from "vitest";
import { OpenAiEngine, parseSse } from "../openai.js";
import type { StreamDelta } from "../../shared/types.js";

/** Build a ReadableStream<Uint8Array> from a list of string chunks (as the
 *  network would deliver them — frame boundaries may fall mid-event). */
function streamFromChunks(chunks: string[]): ReadableStream<Uint8Array> {
  const enc = new TextEncoder();
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) {
        controller.enqueue(enc.encode(chunks[i++]));
      } else {
        controller.close();
      }
    },
  });
}

function sseData(obj: unknown): string {
  return `data: ${JSON.stringify(obj)}\n\n`;
}

describe("parseSse", () => {
  it("parses complete data frames and stops at [DONE]", async () => {
    const stream = streamFromChunks([
      sseData({ choices: [{ delta: { content: "Hello" } }] }),
      sseData({ choices: [{ delta: { content: " world" } }] }),
      "data: [DONE]\n\n",
      sseData({ choices: [{ delta: { content: "AFTER" } }] }), // must not be yielded
    ]);
    const out: unknown[] = [];
    for await (const c of parseSse(stream)) out.push(c);
    expect(out).toHaveLength(2);
    expect((out[0] as any).choices[0].delta.content).toBe("Hello");
    expect((out[1] as any).choices[0].delta.content).toBe(" world");
  });

  it("reassembles frames split across reads", async () => {
    const full = sseData({ choices: [{ delta: { content: "chunked" } }] });
    const mid = Math.floor(full.length / 2);
    const stream = streamFromChunks([full.slice(0, mid), full.slice(mid), "data: [DONE]\n\n"]);
    const out: any[] = [];
    for await (const c of parseSse(stream)) out.push(c);
    expect(out).toHaveLength(1);
    expect(out[0].choices[0].delta.content).toBe("chunked");
  });

  it("skips non-JSON payloads and keeps going", async () => {
    const stream = streamFromChunks([
      "data: not-json\n\n",
      sseData({ choices: [{ delta: { content: "ok" } }] }),
      "data: [DONE]\n\n",
    ]);
    const out: any[] = [];
    for await (const c of parseSse(stream)) out.push(c);
    expect(out).toHaveLength(1);
    expect(out[0].choices[0].delta.content).toBe("ok");
  });
});

describe("OpenAiEngine.run", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streams deltas, aggregates the final text, and maps usage", async () => {
    const body = streamFromChunks([
      sseData({ choices: [{ delta: { content: "Hel" } }] }),
      sseData({ choices: [{ delta: { content: "lo" } }] }),
      sseData({ choices: [{ delta: {} }], usage: { prompt_tokens: 42, completion_tokens: 3 } }),
      "data: [DONE]\n\n",
    ]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status: 200 })),
    );

    const engine = new OpenAiEngine({ baseUrl: "https://x/", apiKey: "secret", model: "m", name: "openai-1" });
    const deltas: StreamDelta[] = [];
    const result = await engine.run({
      prompt: "hi",
      cwd: "/tmp",
      sessionId: "s1",
      onStream: (d) => deltas.push(d),
    });

    expect(result.result).toBe("Hello");
    expect(result.error).toBeUndefined();
    expect(result.contextTokens).toBe(42);
    // text deltas forwarded (plus an initial status)
    expect(deltas.filter((d) => d.type === "text").map((d) => d.content)).toEqual(["Hel", "lo"]);
    expect(engine.isAlive("s1")).toBe(false);
  });

  it("does not leak the apiKey into the result on an HTTP error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("upstream boom", { status: 502, statusText: "Bad Gateway" })),
    );
    const engine = new OpenAiEngine({ baseUrl: "https://x", apiKey: "super-secret-key", model: "m" });
    const result = await engine.run({ prompt: "hi", cwd: "/tmp", sessionId: "s2" });
    expect(result.result).toBe("");
    expect(result.error).toContain("502");
    expect(JSON.stringify(result)).not.toContain("super-secret-key");
  });

  it("returns error='interrupted' when aborted mid-stream", async () => {
    const engine = new OpenAiEngine({ baseUrl: "https://x", apiKey: "k", model: "m" });
    // A never-ending stream so the request is still in flight when we abort.
    const body = new ReadableStream<Uint8Array>({
      start() {
        /* never enqueue, never close */
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        // Reject with an AbortError once the signal fires, mimicking fetch.
        return await new Promise<Response>((resolve, reject) => {
          const signal = init.signal!;
          if (signal.aborted) return reject(makeAbortError());
          signal.addEventListener("abort", () => reject(makeAbortError()));
          // Also resolve with the hanging body so, absent an abort, it would wait.
          void body;
        });
      }),
    );

    const p = engine.run({ prompt: "hi", cwd: "/tmp", sessionId: "s3" });
    // Give the microtask a tick to register, then abort.
    await Promise.resolve();
    engine.kill("s3");
    const result = await p;
    expect(result.error).toBe("interrupted");
    expect(engine.isAlive("s3")).toBe(false);
  });

  it("killAll aborts every in-flight session", async () => {
    const engine = new OpenAiEngine({ baseUrl: "https://x", apiKey: "k", model: "m" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        return await new Promise<Response>((_resolve, reject) => {
          init.signal!.addEventListener("abort", () => reject(makeAbortError()));
        });
      }),
    );
    const p1 = engine.run({ prompt: "a", cwd: "/tmp", sessionId: "k1" });
    const p2 = engine.run({ prompt: "b", cwd: "/tmp", sessionId: "k2" });
    await Promise.resolve();
    engine.killAll();
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.error).toBe("interrupted");
    expect(r2.error).toBe("interrupted");
  });
});

function makeAbortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}
