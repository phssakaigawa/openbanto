# Handoff: HTTP (OpenAI-compatible) engine skeleton

> **UPDATE (`feat/openai-engine`):** a **built-in** OpenAI-compatible HTTP engine
> now ships in-tree — `packages/jimmy/src/engines/openai.ts` +
> `openai.plugin.ts`, resolved for any config block with `impl: "openai"` (no
> `pnpm add`, no external package). Multiple named instances share it
> (`engines.aidea`, `engines.kannon`, …), each with its own baseUrl/apiKey/model,
> and a Web form on the Plugins page (engine tab) creates/edits them. See
> `engine-plugins.md` → "Built-in `impl:"openai"` engine". This document remains
> the reference for building an HTTP engine as an **external SDK package** when you
> want it out-of-tree; the in-tree engine was written directly from this skeleton.
>
> **UPDATE (`feat/openai-mcp-tools`):** the in-tree OpenAI engine now implements
> the tool-call / MCP path below. When `opts.mcpConfigPath` yields MCP servers it
> connects an MCP client per server (stdio or URL/SSE/HTTP via
> `@modelcontextprotocol/sdk`), advertises their tools as OpenAI `tools`
> namespaced `"<server>__<tool>"`, and runs a bounded **non-streaming** tool-call
> loop (feed `tool_calls` results back until final). Without tools it keeps the
> streaming chat path shown here. See `engines/openai.ts` + `mcp/tool-bridge.ts`
> and `tools-mcp-wiring.md`.

Status: **handoff reference** for an engine-plugin developer building an HTTP
engine (an OpenAI-compatible model gateway). The engine is an **external
`@openbanto/engine-sdk` plugin** — it does NOT edit the OpenBanto core. Copy this
into your own package (e.g. `@your-org/engine-myllm`) and fill in the `TODO`s. The
core resolves it via `engines.<name>.module: "@your-org/engine-myllm"` and calls
`create()`.

See `engine-plugins.md` for the contract and `../upstream-port/BANTO-PORT-PLAN.md`
for the merge discipline.

## What you implement

Exactly the `@openbanto/engine-sdk` `EnginePlugin` contract — same shape bob uses
(`engines/bob.plugin.ts`). Two surfaces:

1. `EnginePlugin` (the module `default`): `name`, `capabilities`, `create()`.
2. an `InterruptibleEngine` your `create()` returns: `run()` + `kill()` /
   `isAlive()` / `killAll()`.

`run()` receives an `EngineRunOpts` (prompt, `resumeSessionId`, `systemPrompt`,
`model`, `effortLevel`, `attachments`, `mcpConfigPath`, `onStream`, `sessionId`)
and returns an `EngineResult` (`sessionId`, `result`, `cost?`, `durationMs?`,
`contextTokens?`, `error?`, `turns?`). Stream deltas via `opts.onStream(delta)`.

**CLI vs HTTP:** built-ins spawn a process; you keep an in-flight HTTP request
per `sessionId` instead. `kill()` aborts that request; `isAlive()` checks the
in-flight map; `killAll()` aborts all.

## Skeleton

```ts
// src/index.ts  (package @your-org/engine-myllm)
import {
  defineEnginePlugin,
  type InterruptibleEngine,
  type EngineRunOpts,
  type EngineResult,
  type EngineContext,
} from "@openbanto/engine-sdk";

class MyLlmEngine implements InterruptibleEngine {
  name = "myllm";
  // one AbortController per Jinn sessionId → interrupt / shutdown
  private live = new Map<string, AbortController>();

  constructor(private cfg: { baseUrl: string; apiKey: string; model?: string }) {}

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const sid = opts.sessionId ?? opts.resumeSessionId ?? cryptoRandom();
    const ac = new AbortController();
    this.live.set(sid, ac);
    const startedAt = Date.now();
    try {
      // TODO: call your OpenAI-compatible gateway.
      // - resume: OpenAI is 1 request = 1 turn, so "resume" = replay the
      //   transcript you keep keyed by sid, or pass a server-side conversation id.
      // - tool-call: advertise the tools from opts.mcpConfigPath (see
      //   tools-mcp-wiring.md) as OpenAI "tools", loop on tool_calls, and run
      //   the tool via your MCP client, feeding results back until final.
      //   (Implemented in-tree: see engines/openai.ts runToolLoop + mcp/tool-bridge.ts.)
      const res = await fetch(`${this.cfg.baseUrl}/v1/chat/completions`, {
        method: "POST",
        signal: ac.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.cfg.apiKey}`, // key issuance lives on your gateway side
        },
        body: JSON.stringify({
          model: opts.model ?? this.cfg.model,
          stream: true,
          messages: [
            ...(opts.systemPrompt ? [{ role: "system", content: opts.systemPrompt }] : []),
            { role: "user", content: opts.prompt },
          ],
          // TODO: tools: mcpToolsToOpenAI(opts.mcpConfigPath)
        }),
      });

      // Stream SSE → forward as StreamDelta, accumulate final text.
      let text = "";
      for await (const chunk of sse(res.body!, ac.signal)) {
        const delta = chunk.choices?.[0]?.delta?.content ?? "";
        if (delta) { text += delta; opts.onStream?.({ type: "text", content: delta }); }
        // TODO: handle chunk.choices[0].delta.tool_calls → run tool → continue
      }

      return {
        sessionId: sid,
        result: text,
        durationMs: Date.now() - startedAt,
        // cost / contextTokens: fill from the gateway usage payload if present
      };
    } catch (e: any) {
      if (ac.signal.aborted) return { sessionId: sid, result: "", error: "interrupted" };
      return { sessionId: sid, result: "", error: String(e?.message ?? e) };
    } finally {
      this.live.delete(sid);
    }
  }

  kill(sessionId: string) { this.live.get(sessionId)?.abort(); this.live.delete(sessionId); }
  isAlive(sessionId: string) { return this.live.has(sessionId); }
  killAll() { for (const ac of this.live.values()) ac.abort(); this.live.clear(); }
}

export default defineEnginePlugin({
  name: "myllm",
  capabilities: {
    transport: "http",
    interactive: false,   // each turn is a fresh request (no PTY)
    supportsFork: false,  // no live process to fork
    syncResume: false,    // set true only if you implement transcript replay + handback
    usableAsFallback: false, // ★ do NOT set true — the metered primary (Claude) owns
                             //   rate-limit fallback; a fallback engine must not itself
                             //   trigger a fallback
    usableAsOneShot: false,  // one-shot (triage/goal/migrate) is CLI-only today;
                             //   wiring HTTP one-shot is a separate change (see below)
    models: [/* TODO: model ids your gateway exposes */],
    effort: "model",      // effort baked into model id, or "none"
  },
  // no defaultBin — HTTP engine has no binary
  create(cfg, _ctx: EngineContext) {
    const c = cfg as { baseUrl?: string; apiKey?: string; model?: string };
    if (!c.baseUrl || !c.apiKey) throw new Error("myllm engine needs baseUrl + apiKey");
    return new MyLlmEngine({ baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model });
  },
});
```

## Config (host side — no core edit)

```yaml
engines:
  default: myllm
  myllm:
    module: "@your-org/engine-myllm"   # dynamic-imported by the registry
    baseUrl: "https://<your-gateway>/"
    apiKey: "<issued key>"
    model: "<model-id>"
```

## Gotchas (from the HTTP-engine notes in BANTO-PORT-PLAN)

- **Do not set `usableAsFallback: true`.** Rate-limit *primary* detection is
  metered-primary-specific by design; a fallback engine firing its own fallback
  loops.
- **One-shot (triage / `/goal` / migrate) is CLI-only today.** `oneShotCli.ts`
  `buildArgs` is a per-CLI switch. Running triage/goal on an HTTP engine needs a
  transport branch there (or an engine-level one-shot method) — coordinate with
  the core side before touching core.
- **`bin` is undefined for HTTP engines.** `resolveEngineConfig` returns your
  `engines.<name>` block; `bin` handling already tolerates absence (same as bob).
- **Model picker / effort:** the built-in model catalog is registry-driven for
  built-ins only. To surface your models in the picker, `models.ts` must read
  `capabilities.models` for external engines — a small core wiring; flag it to
  the core side.
```
