# Design: guardrail hooks — approval / permission / audit log

Status: **landed (core hook + plugin loader).** Guardrails are a **core** concern
(they must wrap every turn and every tool write), so the hook *interface* is owned
by the core side; the extension side supplies the *policies* that run in the hooks.
This keeps guardrails un-forkable and consistent across engines/connectors.

## Landed shape (as implemented)

Implemented as a third **plugin mechanism**, mirroring connectors and engines:

- **SDK** `packages/guardrail-sdk` (`@openbanto/guardrail-sdk`) — the dependency-0,
  type-only contract external policy packs implement (`Guardrail`,
  `GuardrailContext`, `GuardrailDecision`, `GuardrailTurnResult`,
  `GuardrailPlugin`, `defineGuardrailPlugin`). Structurally identical to the core's
  own copy so a plugin is assignable at the loader boundary.
- **Core registry** `packages/jimmy/src/guardrails/registry.ts` — type copy +
  `resolveGuardrail(blockOrModule?)` with three resolution paths, in order:
  `module` → dynamic `import` (with an "Install it: npm i <module>" hint on
  failure); `impl: "sample"` → a **built-in in-tree policy pack** (`IMPL_PLUGINS`,
  mirroring the engines' `impl:"openai"`); neither → built-in no-op
  **"allow-all"**. Plus `defineGuardrailPlugin` / `guardrailImplOf` /
  `GUARDRAIL_IMPL_NAMES`.
- **Reference plugins**
  - `packages/jimmy/src/guardrails/example.plugin.ts` — a `defineGuardrailPlugin`
    blocklist policy proving the mechanism end-to-end (loaded as a `module`).
  - `packages/jimmy/src/guardrails/sample.plugin.ts` — the **config-driven sample
    policy pack** resolved by `impl:"sample"` (see below).
- **Config** `shared/types.ts` → `JinnConfig.guardrails?: { module?; impl?; config? }`.
- **Boot wiring** `gateway/server.ts` builds the guardrail once
  (`await (await resolveGuardrail(config.guardrails)).create(config.guardrails?.config ?? {}, { logger, config })`)
  and injects it into `SessionManager` (same pattern as the engines Map). Passing
  the whole block lets the registry pick `module` → `impl` → no-op.
- **Hook points** `sessions/manager.ts` `runSession()`:
  - `beforeTurn` beside the budget check, before `engine.run()` — `allow` continues;
    `deny` replies the reason + ends the turn (audit still runs); `require_approval`
    parks the turn (`parkForApproval` → `queue.pauseQueue` + a decision gate) and
    exposes `SessionManager.resolveApproval(sessionKey, approved, opts?)`.
  - `afterTurn` on the main path after `engine.run()` returns — fire-and-forget
    audit (`ok / cost / tokens`), wrapped so it never throws into the turn.

Opt-in: with no `guardrails` block the no-op guardrail keeps behaviour identical
to "no guardrail". The approval **UX** (Slack buttons, etc.) is the
connector/extension's responsibility — the core exposes `resolveApproval()` only.

## Where hooks sit (turn lifecycle)

`sessions/manager.ts` already runs a pre-flight check before every turn:

```
route(msg) → queue.enqueue(sessionKey, task)          // manager.ts:257
  task:
    … budget enforcement — check BEFORE engine.run()  // manager.ts:506  ← guardrail sibling
    result = await engine.run({...})                   // manager.ts:550/622/675
```

Two hook points:

- **`beforeTurn`** — right beside the budget check (manager.ts ~506). Can allow,
  deny (with a user-facing reason), or require **approval** (park the turn until a
  human approves). This is where per-user permission + rate/scope policy live.
- **`afterTurn`** — after `engine.run()` returns. Structured **audit log** of the
  turn (who / where / engine / tokens / cost / tool writes / decision).

Tool-call-level guardrails (e.g. "calendar writes need approval") ride on the
MCP boundary: either the MCP server enforces, or `beforeTurn` inspects the
declared toolbelt. Per-tool interception inside a turn is a later phase.

## Proposed interface

```ts
export interface GuardrailContext {
  sessionKey: string;
  connector: string;      // "slack" | "lineworks" | "chatwork" | ...
  channel: string;
  userId: string;         // stable sender id (per-user permission key)
  userName: string;
  employee?: string;      // which assistant persona
  engine: string;         // resolved engine name
  text: string;           // inbound prompt
  toolbelt: string[];     // MCP servers this turn may use
}

export type GuardrailDecision =
  | { action: "allow" }
  | { action: "deny"; reason: string }               // reason is shown to the user
  | { action: "require_approval"; approvers?: string[]; reason?: string };

export interface GuardrailHook {
  /** Runs before engine.run(). Deny/approval short-circuit the turn. */
  beforeTurn(ctx: GuardrailContext): Promise<GuardrailDecision> | GuardrailDecision;
  /** Runs after the turn; structured audit sink. Never throws into the turn. */
  afterTurn(ctx: GuardrailContext, result: {
    ok: boolean; cost?: number; tokens?: number; error?: string; toolWrites?: string[];
  }): void | Promise<void>;
}
```

Registration mirrors the plugin pattern (config-declared, dynamic-imported):

```yaml
guardrails:
  module: "@your-org/banto-guardrails"   # extension-side policy pack
  config:
    permissions:                         # per-user / per-role capabilities
      "*": { tools: ["calendar", "minutes", "ledger"], approvalOver: null }
      "U0..MANAGER": { approvalOver: "calendar" }   # manager must approve calendar writes
    audit: { sink: "otel", endpoint: "..." }
```

## Built-in sample policy pack (`impl: "sample"`) + Web form

`guardrails/sample.plugin.ts` is a **config-driven, built-in** policy pack —
operators turn on a real permission/approval/audit policy from the Web form
**without `pnpm add`** (the guardrail counterpart of the `impl:"openai"` engine).

Config shape (`guardrails.config`):

```yaml
guardrails:
  impl: "sample"
  config:
    allowUsers: ["U012ADMIN"]          # this userId always allowed (skip remaining rules)
    deny:
      - contains: ["rm -rf /", "drop database"]   # substring in text → deny
        reason: "危険な操作をブロックしました"
    requireApproval:
      - tools: ["calendar", "ledger"]   # toolbelt ∩ tools → require_approval
        approvers: ["U012ADMIN"]
        reason: "書き込み操作には承認が必要です"
    audit:
      sink: "log"                       # "log" | "http"
      endpoint: ""                      # http: POST target (external audit service), auth headers optional
```

**`beforeTurn` decision order** (fixed):
1. `allowUsers` contains `ctx.userId` → **allow** (bypass every remaining rule).
2. any `deny[].contains` substring is in `ctx.text.toLowerCase()` → **deny** (reason).
3. any `requireApproval[].tools` intersects `ctx.toolbelt` → **require_approval**
   (approvers + reason).
4. otherwise → **allow**. With no config, everything is allowed (safe default).

**Identity note:** `GuardrailContext` carries **no Keycloak groups** on a Slack
turn — only `userId`/`userName`/`toolbelt`/`text`/`channel`/`engine`. Every rule
keys off `userId`; a production pack that wants role/group policy must resolve the
identity itself. The sample is a **template to extend**, not a finished model.

**`afterTurn` audit** emits one record
`{ts, who, connector, channel, engine, ok, cost, tokens, error?}` to the sink:
- `log` → `logger.info("[guardrail-audit] " + json)` (one line);
- `http` → best-effort `fetch(endpoint, {method:"POST", body:json})`. Failures are
  **swallowed (never thrown into the turn)**; the endpoint/auth headers and the
  turn's raw `text` are **never** logged or sent in the record.

### Applying it from the Web form

`packages/web/src/app/plugins/page.tsx` → **ガードレール** tab → `GuardrailSection`
(shown when `plugins.manageUi:true`). Policy-kind select **None / Sample / External
module**; Sample exposes flat inputs (`allowUsers`, `denyKeywords`,
`approvalTools`+`approvers`, `auditSink`+`auditEndpoint`) that the API composes
into the block above. The form posts `POST /api/plugins/guardrail`
(`setGuardrail` in `gateway/plugins-api.ts`, `requirePluginAdmin`-gated, audited),
which writes the `guardrails` block (no `pnpm add` for `sample`/`none`) and returns
`needsRestart:true`. `GET /api/plugins` surfaces the current policy kind and a
**masked** view (`sample.hasAuditEndpoint`, never the endpoint value). A trust
banner warns that a guardrail can stop turn execution.

## Approval flow (require_approval)

1. `beforeTurn` returns `require_approval` → manager parks the queued task
   (reuses the existing `pauseQueue`/`resumeQueue` in `sessions/queue.ts`).
2. Number the request; post an approval prompt to the configured approvers
   (via the connector — Slack/LINE WORKS/Chatwork buttons; enable `interactivity`
   in the app).
3. Approve → `resumeQueue`; deny → cancel the task with the reason.

## Division

- **Core side:** add the two hook points in `manager.ts`, the `GuardrailHook`
  interface + a `resolveGuardrail(module)` loader (registry pattern), the
  park/approve plumbing on `queue.ts`, and the audit event shape. Land as a small
  core PR (with a BANTO-PORT-PLAN entry).
- **Extension side:** implement the policy pack (`beforeTurn`/`afterTurn`) —
  permission model, approval routing, audit sink. It depends only on the published
  `GuardrailHook` type, never on core internals.

## Open questions (for co-design)

- Permission identity: connector `userId` vs an org-wide identity (SSO)?
- Approval UX per connector (Slack buttons; LINE WORKS / Chatwork equivalents).
- Audit sink: OTel / ClickHouse vs. a simple file. An external LLM-audit gateway
  may be the natural home for the audit stream.
