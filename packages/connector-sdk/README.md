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

## Security

Plugins run **in-process with the daemon's privileges**. Only install connector
plugins you trust.

## License

MIT
