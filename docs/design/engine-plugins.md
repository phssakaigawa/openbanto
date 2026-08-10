# Design: Pluggable Engines

Status: **Phase 1+2 landed** (OpenBanto-original feature — see
`../upstream-port/BANTO-PORT-PLAN.md`). Phase 3 (HTTP/aidea engine) not started.

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
3. **Reference HTTP engine (aidea)** — TODO. See the申し送り in BANTO-PORT-PLAN.

## Non-goals
- Sandboxing plugin code (engines run in-process with the daemon's privileges).
