# Handoff: HTTP (OpenAI-compatible) engine skeleton — for the AiDEA engine

Status: **handoff reference** for the AiDEA-side member (Phase 3). The AiDEA
engine is an **external `@openbanto/engine-sdk` plugin** — it does NOT edit the
OpenBanto core. Copy this into your own package (e.g. `@openbanto/engine-aidea`)
and fill in the `TODO`s. The core resolves it via
`engines.<name>.module: "@openbanto/engine-aidea"` and calls `create()`.

See `engine-plugins.md` for the contract and `../upstream-port/BANTO-PORT-PLAN.md`
§G for the merge discipline.

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
// src/index.ts  (package @openbanto/engine-aidea)
import {
  defineEnginePlugin,
  type InterruptibleEngine,
  type EngineRunOpts,
  type EngineResult,
  type EngineContext,
} from "@openbanto/engine-sdk";

class AideaEngine implements InterruptibleEngine {
  name = "aidea";
  // one AbortController per Jinn sessionId → interrupt / shutdown
  private live = new Map<string, AbortController>();

  constructor(private cfg: { baseUrl: string; apiKey: string; model?: string }) {}

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    const sid = opts.sessionId ?? opts.resumeSessionId ?? cryptoRandom();
    const ac = new AbortController();
    this.live.set(sid, ac);
    const startedAt = Date.now();
    try {
      // TODO(aidea): call the AiDEA gateway (OpenAI-compatible).
      // - resume: AiDEA/OpenAI is 1 request = 1 turn, so "resume" = replay the
      //   transcript you keep keyed by sid, or pass a server-side conversation id.
      // - tool-call: advertise the tools from opts.mcpConfigPath (see
      //   tools-mcp-wiring.md) as OpenAI "tools", loop on tool_calls, and run
      //   the tool via your MCP client, feeding results back until final.
      const res = await fetch(`${this.cfg.baseUrl}/v1/chat/completions`, {
        method: "POST",
        signal: ac.signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.cfg.apiKey}`, // TODO: per-plugin key issuance on the AiDEA side
        },
        body: JSON.stringify({
          model: opts.model ?? this.cfg.model,
          stream: true,
          messages: [
            ...(opts.systemPrompt ? [{ role: "system", content: opts.systemPrompt }] : []),
            { role: "user", content: opts.prompt },
          ],
          // TODO(aidea): tools: mcpToolsToOpenAI(opts.mcpConfigPath)
        }),
      });

      // Stream SSE → forward as StreamDelta, accumulate final text.
      let text = "";
      for await (const chunk of sse(res.body!, ac.signal)) {
        const delta = chunk.choices?.[0]?.delta?.content ?? "";
        if (delta) { text += delta; opts.onStream?.({ type: "text", content: delta }); }
        // TODO(aidea): handle chunk.choices[0].delta.tool_calls → run tool → continue
      }

      return {
        sessionId: sid,
        result: text,
        durationMs: Date.now() - startedAt,
        // cost / contextTokens: fill from the AiDEA usage payload if present
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
  name: "aidea",
  capabilities: {
    transport: "http",
    interactive: false,   // each turn is a fresh request (no PTY)
    supportsFork: false,  // no live process to fork
    syncResume: false,    // set true only if you implement transcript replay + handback
    usableAsFallback: false, // ★ do NOT set true — Claude is the metered primary; a
                             //   fallback engine must not itself trigger a fallback
    usableAsOneShot: false,  // one-shot (triage/goal/migrate) is CLI-only today;
                             //   wiring HTTP one-shot is a separate change (see below)
    models: [/* TODO: model ids AiDEA exposes */],
    effort: "model",      // effort baked into model id, or "none"
  },
  // no defaultBin — HTTP engine has no binary
  create(cfg, _ctx: EngineContext) {
    const c = cfg as { baseUrl?: string; apiKey?: string; model?: string };
    if (!c.baseUrl || !c.apiKey) throw new Error("aidea engine needs baseUrl + apiKey");
    return new AideaEngine({ baseUrl: c.baseUrl, apiKey: c.apiKey, model: c.model });
  },
});
```

## Config (host side — no core edit)

```yaml
engines:
  default: aidea
  aidea:
    module: "@openbanto/engine-aidea"   # dynamic-imported by the registry
    baseUrl: "https://<aidea-gateway>/"
    apiKey: "<issued key>"
    model: "deepseek-..."
```

## Gotchas (from the Phase-3 申し送り, BANTO-PORT-PLAN §G)

- **Do not set `usableAsFallback: true`.** Rate-limit *primary* detection is
  Claude-specific by design; a fallback engine firing its own fallback loops.
- **One-shot (triage / `/goal` / migrate) is CLI-only today.** `oneShotCli.ts`
  `buildArgs` is a per-CLI switch. Running triage/goal on an HTTP engine needs a
  transport branch there (or an engine-level one-shot method) — coordinate with
  the 番頭本体 (sakaigawa) side before touching core.
- **`bin` is undefined for HTTP engines.** `resolveEngineConfig` returns your
  `engines.aidea` block; `bin` handling already tolerates absence (same as bob).
- **Model picker / effort:** built-in model catalog is registry-driven for
  built-ins only. To surface AiDEA models in the picker, `models.ts` must read
  `capabilities.models` for external engines — a small core wiring on the 番頭
  side; flag it.
```
