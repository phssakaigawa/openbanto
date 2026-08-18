# Design: Pluggable Engines

Status: **Phase 1+2 landed** (OpenBanto-original feature — see
`../upstream-port/BANTO-PORT-PLAN.md`). Phase 3 (HTTP/openai engine) not started.

## Motivation
Generalise **LLM/agent engines** the same way connectors were generalised
(`connector-plugins.md`): add an engine (a hosted HTTP model, a new CLI, …)
**without editing the core**, and read engine *capabilities* from a declared
table instead of hard-coding `engine === "claude"` checks all over the codebase.

## Problem (before)
- Engine construction was hard-coded in `gateway/server.ts`
  (`new ClaudeEngine()` / `new CodexEngine()` / `new GeminiEngine()` /
  `new BobEngine()`), then `engines.set(name, …)`.
- Behavioural branches keyed on the engine *name* string in many places:
  - the **engine-config selection ternary** duplicated 4× (`sessions/manager.ts`,
    `gateway/api.ts`, `sessions/context.ts`, `cli/migrate.ts`) — the
    **bob-critical** one (BANTO-PORT-PLAN §A): if bob's block is dropped from the
    fallback, `bin` reverts to claude and Bob fails to start;
  - `engine === "claude"` gating interactive PTY (`processLifetime`),
    session fork (`sessions/fork.ts`), and resume/sync-after-fallback.
- `shared/models.ts` re-declared the engine-name list as its own literal.

## Solution

### 1. `@openbanto/engine-sdk`
A dependency-free package (`packages/engine-sdk`) defining the **stable contract**
an external engine plugin implements: `Engine` / `InterruptibleEngine` /
`EngineRunOpts` / `EngineResult` / `StreamDelta` (structurally identical to the
core's `shared/types.ts`, so a plugin is assignable at the loader boundary), plus
the OpenBanto-original plugin surface:

```ts
interface EngineCapabilities {
  transport: "cli" | "http";
  interactive: boolean;      // process survives across turns (PTY)
  supportsFork: boolean;     // sessions/fork.ts can fork it
  syncResume: boolean;       // resume + accept a context-sync transcript
  usableAsFallback: boolean; // safe to switch TO on a rate limit
  usableAsOneShot: boolean;  // Slack triage / /goal / migrate
  models: string[];
  effort: "none" | "flag" | "model";
}
interface EnginePlugin {
  name: string;
  capabilities: EngineCapabilities;
  defaultBin?: string;
  create(cfg, ctx): Promise<InterruptibleEngine> | InterruptibleEngine;
}
function defineEnginePlugin(p: EnginePlugin): EnginePlugin;
```

### 2. Registry — `packages/jimmy/src/engines/registry.ts`
Mirrors `connectors/registry.ts`. Built-ins are **lazy factories**; each declares
its capabilities. `resolveEngine(name, module?)` returns a built-in or
dynamic-imports an external `module` (clear "Install it: npm i <module>" error).
`engineCapabilities(name)` + the `engineIsInteractive/SupportsFork/SupportsSyncResume`
predicates give the core **synchronous** capability lookups without constructing
the engine. `resolveEngineConfig(config, name)` is the ONE place the 4-way
config-selection ternary now lives (bob-critical — keeps each engine resolving to
its own block).

### 3. IBM Bob = the first SDK engine
`engines/bob.plugin.ts` is a thin `defineEnginePlugin({ name:"bob", capabilities,
create })` wrapper that lazily constructs `BobEngine`. It is the reference for
what a real engine plugin looks like and the first engine the registry resolves.

### 4. Gateway wiring
`gateway/server.ts` builds the engine map by looping over the configured engine
set and calling `resolveEngine().create()` — same engine group as before, plus
any external engine declared with `engines.<name>.module`. Interactive Claude
still REPLACES the "claude" entry when `engines.claude.interactive === true`
(capabilities.interactive on "claude" is already true, so downstream logic is
unchanged).

### 5. Capability-driven branches
`engine === "claude"` was replaced by capability lookups where the check is about
a *capability*: `processLifetime` (interactive), `sessions/fork.ts` (supportsFork),
and resume/sync-after-fallback (syncResume) in `sessions/manager.ts` /
`gateway/api.ts`. `shared/models.ts` now sources its engine-name list from the
registry's `BUILTIN_ENGINE_NAMES`.

## Deliberately NOT converted
- **Rate-limit *primary* checks** (`session.engine === "claude" && strategy ===
  "fallback"`, near-usage-limit pre-check): Claude is the only metered primary
  whose usage limit triggers a fallback. This is Claude-specific behaviour, not a
  general capability — converting it would let a fallback engine trigger its own
  fallback. Left as `=== "claude"`, documented.
- **`oneShotCli.ts` `buildArgs`**: the per-engine `switch` encodes each CLI's
  exact flags (`bob run --format json`, `codex exec --json …`, `claude -p …`).
  The `OneShotEngine` union stays the closed set of one-shot-capable CLI engines
  (== `usableAsOneShot && transport==='cli'`); a generic HTTP one-shot is Phase 3.

## Built-in `impl:"openai"` engine (many named instances of one implementation)

Beyond built-in names and external `module` plugins, a config engine block may
select a **shared in-tree implementation** with `impl`. Today the only impl is
`openai` — a generic OpenAI-compatible HTTP engine
(`packages/jimmy/src/engines/openai.ts` + `openai.plugin.ts`). This lets an
operator declare **any number of named engines** that all share that one
implementation, each with its own `baseUrl`/`apiKey`/`model`:

```yaml
engines:
  default: bob
  openai-1:  { impl: "openai", baseUrl: "https://llm.example.internal", apiKey: "…", model: "…" }
  openai-2: { impl: "openai", baseUrl: "https://llm.example.internal",      apiKey: "…", model: "…" }
```

Resolution (`resolveEngine(name, block)`), in order:
1. **built-in name** (bob/claude/codex/gemini) → lazy factory;
2. **`impl:"openai"` in the block** → the shared `openai` plugin (`IMPL_PLUGINS`
   in the registry). The engine's `name` is the config key (`openai-1`/`openai-2`);
3. **external `module`** → dynamic import.

`gateway/server.ts` enumerates the engine map from the built-ins **plus** any
config block carrying a `module` or an `impl`, injecting the config key as
`cfg.name` so each instance reports its own name. Capabilities for an impl engine
come from `IMPL_CAPABILITIES[impl]` (openai = `transport:"http"`,
`interactive/supportsFork/syncResume/usableAsFallback/usableAsOneShot: false`,
`effort:"none"`); `engineCapabilities(name, config)` resolves through it.

The engine:
- POSTs `${baseUrl}/v1/chat/completions` with `stream:true`, parses the SSE token
  stream, forwards each `delta.content` as `onStream({type:"text",…})`, and
  aggregates the final text into `EngineResult.result`;
- keeps one `AbortController` per Jinn `sessionId` (`kill`=abort, `isAlive`,
  `killAll`); an abort yields `error:"interrupted"`;
- maps `usage.prompt_tokens` → `contextTokens` and `usage.cost` → `cost` when the
  gateway emits them;
- keeps a small per-`sessionId` in-memory transcript so a resumed turn replays
  prior context (MVP; lost on restart — `syncResume:false`);
- **does tool-calls / MCP** (`feat/openai-mcp-tools`): when `mcpConfigPath` yields
  MCP servers it connects an MCP client per server (stdio or URL/SSE/HTTP via
  `@modelcontextprotocol/sdk`), advertises their tools as OpenAI `tools` namespaced
  `"<server>__<tool>"`, and runs a bounded **non-streaming** tool-call loop
  (POST → run `tool_calls` via MCP → append `{role:"tool"}` results → repeat, cap
  8 rounds) until a final answer, which it streams out. With no tools it uses the
  streaming chat path above. `kill`/`killAll` also close the MCP clients, and the
  turn always closes them in `finally`. Capabilities are unchanged (transport
  stays `http`). See `engines/openai.ts` + `mcp/tool-bridge.ts`.

The `/model` picker surfaces each impl engine's `engines.<name>.model`
(`shared/models.ts` `addImplEngineEntries`), so `/model` can switch to it.

`apiKey` is a secret: it is never returned by `GET /api/plugins` (the summary
carries only `openai.hasApiKey`), and the engine never logs or echoes it.

## Config
```yaml
engines:
  default: my-model            # any string; known built-ins autocomplete
  my-model:
    module: "@openbanto/engine-my-model"   # omit for built-ins
    model: my-model-large
```

## Phasing
1. **Registry + capability table + wiring dedup** (no behaviour change) — done.
2. **External plugin loading** (`module` → dynamic import) — done.
3. **Built-in `impl:"openai"` HTTP engine + Web form** — done (this change).
4. **HTTP one-shot + tool-call/MCP** — TODO. See the申し送り in BANTO-PORT-PLAN.

## Non-goals
- Sandboxing plugin code (engines run in-process with the daemon's privileges).
