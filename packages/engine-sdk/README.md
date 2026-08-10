# @openbanto/engine-sdk

The stable **contract** an [OpenBanto](https://github.com/phssakaigawa/openbanto)
engine plugin implements. An **engine** runs a turn: given a prompt (plus a
resumable session id, model, effort level, attachments, …) it produces a reply,
optionally streaming deltas. Built-in engines spawn a CLI (`claude`, `codex`,
`gemini`, IBM `bob`) or drive a PTY; an engine can equally speak HTTP to a hosted
model — the core only calls `run()`.

External engine plugins depend on **this package only** — never on the OpenBanto
core — so an engine can live in its own repo and be published as its own npm
package. The core resolves a plugin by dynamic `import(module)` and calls its
`create(cfg, ctx)`.

> **IBM Bob is the first engine written against this SDK.** In the OpenBanto
> core, `packages/jimmy/src/engines/bob.plugin.ts` is a thin `defineEnginePlugin`
> wrapper that declares Bob's capabilities and constructs the `BobEngine`. It is
> the reference for what a real plugin looks like, and the first engine the
> engine registry resolves through the SDK contract.

## Install

```bash
npm i @openbanto/engine-sdk
```

## Write a plugin

```ts
import {
  defineEnginePlugin,
  type EngineContext,
  type EngineRunOpts,
  type EngineResult,
  type InterruptibleEngine,
} from "@openbanto/engine-sdk";

class MyHttpEngine implements InterruptibleEngine {
  name = "my-model";
  async run(opts: EngineRunOpts): Promise<EngineResult> {
    // ...call your model, stream via opts.onStream, return the final text
    return { sessionId: opts.resumeSessionId ?? crypto.randomUUID(), result: "hi" };
  }
  kill() { /* abort in-flight request */ }
  isAlive() { return false; }
  killAll() { /* abort all */ }
}

export default defineEnginePlugin({
  name: "my-model",
  capabilities: {
    transport: "http",
    interactive: false,
    supportsFork: false,
    syncResume: false,
    usableAsFallback: true,
    usableAsOneShot: true,
    models: ["my-model-large", "my-model-mini"],
    effort: "model",
  },
  create(cfg, ctx: EngineContext) {
    // heavy deps go here, imported lazily
    return new MyHttpEngine();
  },
});
```

Configure it in `config.yaml`:

```yaml
engines:
  default: my-model
  my-model:
    module: "@openbanto/engine-my-model"   # omit for built-ins
    model: my-model-large
```

## Capabilities

The core reads `capabilities` **instead of** hard-coding `engine === "claude"`
checks:

| field             | meaning                                                        |
|-------------------|----------------------------------------------------------------|
| `transport`       | `'cli'` spawns a binary/PTY; `'http'` talks to a model endpoint |
| `interactive`     | process survives across turns (PTY) vs. one-shot per turn       |
| `supportsFork`    | the core can fork a live session (`sessions/fork.ts`)           |
| `syncResume`      | can resume + be handed a context-sync transcript after fallback |
| `usableAsFallback`| safe to switch TO on a rate limit                              |
| `usableAsOneShot` | usable for Slack triage / `/goal` extraction / migrate         |
| `models`          | model ids exposed to the picker (empty = bound to key/account) |
| `effort`          | `'none'` \| `'flag'` \| `'model'`                              |

## License

MIT. This SDK is dependency-free.
