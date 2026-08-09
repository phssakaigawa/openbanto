/**
 * `@openbanto/connector-sdk`
 *
 * The stable contract an OpenBanto **connector plugin** implements. A connector
 * bridges an external chat/messaging surface (Slack, Discord, LINE WORKS, a
 * generic webhook bot, …) to the OpenBanto gateway: it delivers inbound
 * messages to the daemon and sends the engine's replies back out.
 *
 * External plugins depend on THIS package only — never on the OpenBanto core —
 * so a plugin can be published as its own npm package / repo. The core resolves
 * a plugin by dynamic `import(module)` and calls its `create(cfg, ctx)`.
 *
 * These types are intentionally self-contained (no core imports); the core's
 * own equivalents are structurally identical, so a plugin built against the SDK
 * is assignable at the loader boundary.
 *
 * See: https://github.com/phssakaigawa/openbanto/blob/main/docs/design/connector-plugins.md
 */

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/**
 * Opaque, connector-defined data needed to address a reply back to its origin
 * (channel/thread/message ids, etc.). The core round-trips it verbatim.
 */
export type ReplyContext = JsonObject;

export interface ConnectorCapabilities {
  threading: boolean;
  messageEdits: boolean;
  reactions: boolean;
  attachments: boolean;
}

export interface ConnectorHealth {
  status: "running" | "stopped" | "error" | "qr_pending";
  detail?: string;
  capabilities: ConnectorCapabilities;
}

export interface Attachment {
  name: string;
  url: string;
  mimeType: string;
  /** Populated by the connector after it downloads the file locally, if it does. */
  localPath?: string;
}

/** Where to send a message. Built by the connector via `reconstructTarget`. */
export interface Target {
  channel: string;
  thread?: string;
  messageTs?: string;
  replyContext?: ReplyContext;
}

/** A normalized inbound message handed to the gateway by a connector. */
export interface IncomingMessage {
  /** Connector instance name/id (e.g. "slack", "lw-support"). */
  connector: string;
  /** Connector type/surface (e.g. "slack", "lineworks"). */
  source: string;
  /** Stable key that groups messages into one conversation/session. */
  sessionKey: string;
  replyContext: ReplyContext;
  messageId?: string;
  channel: string;
  thread?: string;
  /** Human-readable sender name. */
  user: string;
  /** Stable sender id. */
  userId: string;
  text: string;
  attachments: Attachment[];
  /** The raw provider event, for connector-specific needs. */
  raw: unknown;
  transportMeta?: JsonObject;
}

/**
 * The interface a connector implements. Mirrors the OpenBanto core `Connector`
 * shape exactly.
 */
export interface Connector {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  getCapabilities(): ConnectorCapabilities;
  getHealth(): ConnectorHealth;
  reconstructTarget(replyContext: ReplyContext): Target;
  sendMessage(target: Target, text: string): Promise<string | void>;
  replyMessage(target: Target, text: string): Promise<string | void>;
  addReaction(target: Target, emoji: string): Promise<void>;
  removeReaction(target: Target, emoji: string): Promise<void>;
  editMessage(target: Target, text: string): Promise<void>;
  setTypingStatus?(
    channelId: string,
    threadTs: string | undefined,
    status: string,
  ): Promise<void>;
  /** The gateway registers its router here; call it for every inbound message. */
  onMessage(handler: (msg: IncomingMessage) => void): void;
  /** Return the bound employee name, if any. */
  getEmployee?(): string | undefined;
}

/** Minimal logger the host provides to plugins. */
export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * Inbound HTTP webhook handler for callback-style connectors (LINE WORKS,
 * Messenger, generic webhook bots). The host buffers the raw request body and
 * hands it to the plugin, which performs its OWN signature verification before
 * acting. Return after writing the response.
 */
export type WebhookHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  body: Buffer,
) => void | Promise<void>;

/** Loosely-typed view of the host employee a connector instance is bound to. */
export interface ConnectorEmployee {
  name: string;
  engine: string;
  [key: string]: unknown;
}

/**
 * Context handed to a plugin's `create()`. Heavy provider SDKs must be imported
 * lazily INSIDE `create()` so a plugin's dependency is only required when it is
 * actually configured.
 */
export interface ConnectorContext {
  logger: Logger;
  /**
   * The full host config, loosely typed so the SDK stays dependency-free.
   * Most plugins only need their own `cfg` (the first `create()` argument).
   */
  config: Record<string, unknown>;
  /** The employee this connector routes to (undefined → engine default). */
  employee?: ConnectorEmployee;
  portalName?: string;
  operatorName?: string;
  operatorAliases?: string[];
  /** True when the routed engine is Claude (host-specific goal-injection flag). */
  goalInjectionEnabled?: boolean;
  /**
   * Register an inbound HTTP route on the gateway HTTP server. Outbound
   * connectors (Slack Socket Mode, Discord gateway) don't need this. The path
   * is matched exactly (query string stripped).
   */
  mountWebhook(path: string, handler: WebhookHandler): void;
}

/**
 * What a connector plugin module exports as its `default`. The core calls
 * `create()` once per configured instance.
 */
export interface ConnectorPlugin {
  /** Connector type this plugin provides (e.g. "lineworks"). */
  type: string;
  create(
    cfg: Record<string, unknown>,
    ctx: ConnectorContext,
  ): Promise<Connector> | Connector;
}

/**
 * Identity helper for plugin authors — wraps a plugin object so TypeScript
 * checks it against the contract at authoring time:
 *
 * ```ts
 * export default defineConnectorPlugin({
 *   type: "lineworks",
 *   async create(cfg, ctx) { ... }
 * });
 * ```
 */
export function defineConnectorPlugin(plugin: ConnectorPlugin): ConnectorPlugin {
  return plugin;
}
