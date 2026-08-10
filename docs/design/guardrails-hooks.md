# Design (draft): guardrail hooks — approval / permission / audit log

Status: **draft / co-design.** Guardrails are a **core** concern (they must wrap
every turn and every tool write), so the hook *interface* is owned by the 番頭本体
(sakaigawa) side; the AiDEA side supplies the *policies* that run in the hooks.
This keeps guardrails un-forkable and consistent across engines/connectors.

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
  employee?: string;      // which 番頭 persona
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
  module: "@getworks/banto-guardrails"   # AiDEA-side policy pack
  config:
    permissions:                         # per-user / per-role capabilities
      "*": { tools: ["calendar", "minutes", "ledger"], approvalOver: null }
      "U0..MANAGER": { approvalOver: "calendar" }   # manager must approve calendar writes
    audit: { sink: "otel", endpoint: "..." }
```

## Approval flow (require_approval)

1. `beforeTurn` returns `require_approval` → manager parks the queued task
   (reuses the existing `pauseQueue`/`resumeQueue` in `sessions/queue.ts`).
2. Number the request; post an approval prompt to the configured approvers
   (via the connector — Slack/LINE WORKS/Chatwork buttons; our Slack manifest
   already enables `interactivity`).
3. Approve → `resumeQueue`; deny → cancel the task with the reason.

## Division

- **番頭本体 (sakaigawa):** add the two hook points in `manager.ts`, the
  `GuardrailHook` interface + a `resolveGuardrail(module)` loader (registry
  pattern), the park/approve plumbing on `queue.ts`, and the audit event shape.
  Land as a small core PR (BANTO-PORT-PLAN gets a §H entry).
- **AiDEA side:** implement the policy pack (`beforeTurn`/`afterTurn`) — permission
  model, approval routing, audit sink (承認・権限・ログ). It depends only on the
  published `GuardrailHook` type, never on core internals.

## Open questions (for co-design)

- Permission identity: Slack `userId` vs a Getworks-wide identity (SSO)?
- Approval UX per connector (Slack ✅ buttons; LINE WORKS / Chatwork equivalents).
- Audit sink: OTel / ClickHouse (kannon overlap — LLM audit gateway) vs. simple
  file. `kannon` may be the natural home for the audit stream.
