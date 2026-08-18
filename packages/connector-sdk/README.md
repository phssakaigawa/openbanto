# @openbanto/connector-sdk

The stable **contract** an [OpenBanto](https://github.com/phssakaigawa/openbanto)
connector plugin implements. A connector bridges an external chat/messaging
surface (Slack, Discord, LINE WORKS, a generic webhook bot, …) to the OpenBanto
gateway: it delivers inbound messages to the daemon and sends the engine's
replies back out.

External connector plugins depend on **this package only** — never on the
OpenBanto core — so a connector can live in its own repo and be published as its
own npm package. The core resolves a plugin by dynamic `import(module)` and calls
its `create(cfg, ctx)`.

## Install

```bash
npm i @openbanto/connector-sdk
```

## Write a plugin

```ts
import {
  defineConnectorPlugin,
  type Connector,
  type ConnectorContext,
  type IncomingMessage,
  type Target,
} from "@openbanto/connector-sdk";

export default defineConnectorPlugin({
  type: "my-connector",
  async create(cfg, ctx) {
    // Import heavy provider SDKs LAZILY here, so this plugin's dependency is
    // only required when the connector is actually configured.
    const provider = await import("some-provider-sdk");

    let onMessage: (m: IncomingMessage) => void = () => {};

    // Inbound: outbound-only connectors skip this; callback bots use it.
    // ctx.mountWebhook("/webhooks/my-connector", (req, res, body) => { ... });

    const connector: Connector = {
      name: (cfg.id as string) ?? "my-connector",
      async start() {/* connect */},
      async stop() {/* disconnect */},
      getCapabilities() {
        return { threading: false, messageEdits: false, reactions: false, attachments: false };
      },
      getHealth() {
        return { status: "running", capabilities: this.getCapabilities() };
      },
      reconstructTarget(replyContext) {
        return { channel: String((replyContext as any).channel ?? ""), replyContext };
      },
      async sendMessage(target: Target, text: string) {/* send */},
      async replyMessage(target: Target, text: string) {/* reply */},
      async addReaction() {},
      async removeReaction() {},
      async editMessage() {},
      onMessage(handler) { onMessage = handler; },
    };
    return connector;
  },
});
```

## Wire it into OpenBanto

```yaml
# ~/.openbanto/config.yaml
connectors:
  instances:
    - type: my-connector
      module: "@openbanto/connector-my-connector"   # omit for built-ins
      id: my-1
      employee: support-banto        # optional → connector → employee → engine routing
      # ...your connector-specific keys
```

## Inbound (webhook) connectors

Callback-style connectors (LINE WORKS, Messenger, …) receive events over HTTP.
Use `ctx.mountWebhook(path, handler)` to register a route on the gateway HTTP
server. **Verify the provider's signature inside your handler** — the host does
not do it for you. The webhook endpoint must be exposed over TLS and reachable
by the provider (separate from the no-auth dashboard).

## Reliability checkpoints

A connector **bridges** a chat surface to the engine — it never calls the engine
itself. The recovery for a missing engine reply lives in the OpenBanto **core**,
not in your plugin, and applies to every connector uniformly:

- **Empty / timeout retry is core-owned.** When a turn returns nothing usable —
  no result text *and* no error (the `(No response from engine)` case), or a
  non-interrupt timeout — the core resends the **same** prompt on the **same**
  engine session up to `sessions.emptyResponseRetries` times (default `2`,
  `sessions.emptyResponseRetryDelayMs` between attempts) before handing you text
  to deliver. **Do not re-implement this**; a connector cannot re-invoke the
  engine, and re-sending the inbound message would double-charge and duplicate
  tool side effects. (These knobs, plus `retryInteractiveTimeout`, are editable
  from the Settings UI.)

When authoring a connector, make your **own** I/O reliable so those retries reach
users:

- [ ] **Deliver once.** Post the core's text exactly once; make `sendMessage` /
      `replyMessage` idempotent under an outbound retry.
- [ ] **Resilient outbound.** Wrap provider send/reply/reaction calls so a
      provider hiccup is retried or logged — never thrown into the router.
- [ ] **Graceful empty result.** If the core still delivers an error/empty
      sentinel after its retries, render it as a normal message; don't crash the
      loop.
- [ ] **Surface missing scopes.** On a permission failure (e.g. Slack
      `missing_scope` for `reactions:write`), log which scope is missing and how
      to re-grant it, not a bare error.

See `docs/design/connector-plugins.md` §8 for the full rationale.

## Security

Plugins run **in-process with the daemon's privileges**. Only install connector
plugins you trust.

## License

MIT
