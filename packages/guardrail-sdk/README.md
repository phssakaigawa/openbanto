# @openbanto/guardrail-sdk

The stable **contract** an [OpenBanto](https://github.com/phssakaigawa/openbanto)
guardrail plugin implements. A **guardrail** wraps every turn: **before** the
engine runs it can allow, deny (with a user-facing reason), or require human
**approval**; **after** the engine runs it receives a structured **audit**
record (who / where / engine / tokens / cost / outcome). This is where per-user
permission, rate/scope policy, approval routing and audit sinks live.

Guardrails are a **core** concern — they must sit on the turn path for every
engine and connector — so the OpenBanto core owns the two hook points and the
loader; your plugin supplies the *policy*. External guardrail plugins depend on
**this package only** — never on the OpenBanto core — so a policy pack can live
in its own repo and be published as its own npm package. The core resolves a
plugin by dynamic `import(module)` and calls its `create(cfg, ctx)` once at boot.

## Install

```bash
npm i @openbanto/guardrail-sdk
```

## Write a plugin

```ts
import {
  defineGuardrailPlugin,
  type Guardrail,
  type GuardrailContext,
  type GuardrailDecision,
  type GuardrailTurnResult,
} from "@openbanto/guardrail-sdk";

export default defineGuardrailPlugin({
  name: "my-guardrail",
  async create(cfg, ctx) {
    // Import heavy deps (audit client, policy DB driver, …) LAZILY here, so this
    // plugin's dependency is only required when the guardrail is configured.
    // const client = await import("some-audit-client");

    const blocklist = ((cfg.blocklist as string[]) ?? []).map((w) => w.toLowerCase());

    const guardrail: Guardrail = {
      beforeTurn(c: GuardrailContext): GuardrailDecision {
        const text = c.text.toLowerCase();
        const hit = blocklist.find((w) => text.includes(w));
        if (hit) return { action: "deny", reason: `Blocked term: "${hit}"` };
        // Or gate on identity / toolbelt:
        // if (c.toolbelt.includes("ledger") && !isManager(c.userId))
        //   return { action: "require_approval", reason: "Ledger write needs approval" };
        return { action: "allow" };
      },
      afterTurn(c: GuardrailContext, r: GuardrailTurnResult) {
        ctx.logger.info(
          `[audit] ${c.connector}/${c.channel} user=${c.userId} engine=${c.engine} ` +
            `ok=${r.ok} cost=${r.cost ?? 0} tokens=${r.tokens ?? 0}`,
        );
      },
    };
    return guardrail;
  },
});
```

## Wire it into OpenBanto

```yaml
# ~/.openbanto/config.yaml
guardrails:
  module: "@your-org/banto-guardrails"   # omit → built-in no-op "allow-all"
  config:
    blocklist: ["wire transfer", "delete production"]
    # …your policy-specific keys
```

Omit `guardrails` (or `guardrails.module`) entirely and the core installs a
built-in **no-op "allow-all"** guardrail: `beforeTurn` always allows and
`afterTurn` does nothing. Guardrails are opt-in.

## The two hook points

- **`beforeTurn(ctx)`** runs right beside the budget check, before `engine.run()`.
  Return `allow`, `deny` (reason shown to the user), or `require_approval` (the
  turn is parked; the core exposes `resolveApproval()` for an approve/reject
  decision — the approval **UX** itself, e.g. Slack buttons, is the connector /
  extension's responsibility).
- **`afterTurn(ctx, result)`** runs after `engine.run()` returns on the main
  path. Treat it as a fire-and-forget audit sink; do not throw into the turn.

## Security

Plugins run **in-process with the daemon's privileges**. Only install guardrail
plugins you trust.

## License

MIT
