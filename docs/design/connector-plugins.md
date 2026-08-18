# Design: Pluggable Connectors

Status: **Proposed** (OpenBanto-original feature — see `../upstream-port/BANTO-PORT-PLAN.md`)

## Motivation
- Add connectors (LINE WORKS, Mattermost, …) **without editing the core** (`gateway/server.ts`).
- Keep each connector's heavy dependency **out of the core** so the distributable
  image/package stays light and MIT-clean. Generalises what we already did for
  WhatsApp/baileys (optional peer dep + dynamic import) to **every** connector.

## Problem (today)
- Connector registration is duplicated in 8+ places: legacy top-level blocks
  (`connectors.slack`/`discord`/`telegram`/`whatsapp`) **and** a `switch (type)`
  over `connectors.instances[]`, each repeating the same
  `new XConnector(cfg) → onMessage → sessionManager.route → start` wiring.
- Heavy deps are **statically imported and bundled**: `discord.js`,
  `@slack/bolt`, `node-telegram-bot-api`. Only `baileys` (WhatsApp) is optional.
- Adding a connector means editing core in several spots.

## Proposal

### 1. Connector interface — unchanged
The existing `Connector` interface (`start/stop/onMessage/sendMessage/replyMessage/
reconstructTarget/getCapabilities/getHealth/…`) stays as the contract a connector
implements.

### 2. `ConnectorPlugin` contract
```ts
export interface ConnectorPlugin {
  type: string; // "slack" | "discord" | "lineworks" | ...
  // Heavy deps are imported lazily INSIDE create(), so a plugin's dependency is
  // only required when that connector is actually configured.
  create(cfg: ConnectorInstanceConfig, ctx: ConnectorContext): Promise<Connector> | Connector;
}

export interface ConnectorContext {
  logger: Logger;
  config: JinnConfig;
  /** For inbound/callback connectors (LINE WORKS, Messenger, …): register an
   *  HTTP route on the gateway to receive webhook events. Outbound connectors
   *  (Slack Socket Mode, Discord GW) don't need this. */
  mountWebhook(path: string, handler: WebhookHandler): void;
}
```

### 3. Registry (built-ins lazy, externals dynamic)
```ts
// Built-ins register through the SAME registry; each entry is lazy so its heavy
// dependency loads only when configured.
const BUILTINS: Record<string, () => Promise<ConnectorPlugin>> = {
  slack:    () => import("./slack/plugin.js").then(m => m.default),
  discord:  () => import("./discord/plugin.js").then(m => m.default),
  telegram: () => import("./telegram/plugin.js").then(m => m.default),
  whatsapp: () => import("./whatsapp/plugin.js").then(m => m.default),
};

async function resolvePlugin(type: string, module?: string): Promise<ConnectorPlugin> {
  if (BUILTINS[type]) return BUILTINS[type]();
  if (module) {                            // external plugin
    const mod = await import(module).catch(() => {
      throw new Error(`Connector "${type}" needs the plugin package "${module}". Install it: npm i ${module}`);
    });
    return (mod.default ?? mod) as ConnectorPlugin;
  }
  throw new Error(`Unknown connector type "${type}" and no "module" given.`);
}
```

### 4. One wiring path (replaces all duplication)
```ts
for (const inst of resolveConnectorConfigs(config)) {   // merges legacy + instances[]
  const plugin = await resolvePlugin(inst.type, inst.module);
  const conn = await plugin.create(inst, ctx);
  conn.onMessage(msg => sessionManager.route(msg, conn, routeOptsFor(inst)));
  await conn.start();
  connectorMap.set(inst.id ?? inst.type, conn);
}
```
`resolveConnectorConfigs` flattens `connectors.slack` (legacy) **and**
`connectors.instances[]` into a uniform list of
`{ type, id?, employee?, module?, ...connectorConfig }`, so both stay supported.
Reload uses the same loop (stop old → run loop again).

### 5. Config shape
```yaml
connectors:
  # legacy single-instance forms still work (slack:, discord:, …)
  instances:
    - type: lineworks
      module: "@openbanto/connector-lineworks"   # omit for built-ins
      id: lw-support
      employee: support-banto                    # → connector → employee → engine routing
      # ...connector-specific keys (botId, apiKeys, webhookPath, ...)
```

### 6. Inbound (webhook) connectors
Slack (Socket Mode) and Discord are **outbound** — no public port needed.
LINE WORKS / Messenger / generic webhook bots are **inbound** — they POST events
to a callback URL. `ctx.mountWebhook(path, handler)` lets such a plugin register a
route on the gateway HTTP server (with signature verification in the plugin). This
endpoint must be exposed safely (TLS + auth/verification), separate from the
no-auth dashboard.

### 7. Security
Plugins run **in-process with the daemon's privileges** (a connector plugin can do
anything the daemon can). This matches the single-tenant / trusted-boundary model
(see README security section). Only install connector plugins you trust.

### 8. Reliability checkpoints (engine responses)
A connector **bridges** a chat surface to the engine — it never calls the engine
itself. So the retry for a missing engine response lives in the **core**
(`SessionManager`), not in any connector, and applies uniformly to every
connector (Slack, Discord, LINE WORKS, …):

- **Empty / timeout retry (core-owned).** When a turn returns nothing usable —
  no result text *and* no error (the `(No response from engine)` case), or a
  non-interrupt timeout — the core resends the **same** prompt on the **same**
  engine session up to `sessions.emptyResponseRetries` times (default 2 → 3
  total attempts), waiting `sessions.emptyResponseRetryDelayMs` (default 1500ms)
  before each resend, then delivers. This composes with, and runs before, the
  existing dead-session / poisoned-transcript / transient-5xx / rate-limit
  recovery paths, which each own their distinct error signatures. The
  interactive engine's hard-turn timeout is excluded by default (it's a
  deliberate long-occupancy stop); `sessions.retryInteractiveTimeout` opts it in
  and then retries with a **continuation** prompt, not a verbatim resend, so
  completed work isn't repeated. All four knobs are editable from the Settings
  UI (セッション → 信頼性・リトライ) as well as `~/.openbanto/config.yaml`.

Checklist for a connector author — do **not** re-implement engine retry; instead
make the connector's own I/O reliable so the core's retries actually reach users:

- [ ] **No duplicate engine retry.** Deliver whatever text the core hands you
      exactly once. A connector cannot re-invoke the engine and must not try —
      re-sending the inbound message would double-charge and duplicate tool
      side effects.
- [ ] **Idempotent delivery.** `sendMessage` / `replyMessage` should not post the
      same reply twice if called again after a transient outbound failure.
- [ ] **Resilient outbound.** Wrap provider send/reply/reaction calls so a
      provider hiccup is retried or logged, never thrown into the router.
- [ ] **Graceful empty result.** If the core still delivers an error/empty
      sentinel after its retries, render it as a normal message — don't crash
      the connector loop.
- [ ] **Surface missing scopes.** When a provider call fails for a permission
      reason (e.g. Slack `missing_scope` on `reactions:write`), log an
      actionable hint (which scope, how to re-grant) rather than a bare error.

## Phasing
1. **Registry + wiring dedup + lazy built-in deps** (no behaviour change): add the
   registry and one wiring helper; move each built-in connector to a `plugin.ts`
   that dynamic-imports its heavy dep. Result: `discord.js` / `@slack/bolt` /
   `node-telegram-bot-api` drop out of the core bundle → lighter, MIT-cleaner core.
   This is the foundation and ships value on its own.
2. **External plugin loading**: `module` resolution + dynamic import + clear errors.
3. **Reference plugin**: publish `@openbanto/connector-lineworks` as a separate
   package to validate the API (and exercise `mountWebhook`).

## Non-goals (for now)
- Sandboxing plugin code (they run in-process).
- A plugin marketplace / auto-discovery by naming convention.
