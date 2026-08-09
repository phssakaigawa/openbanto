// Connector plugin registry (Phase 1: registry + wiring dedup + lazy built-in deps).
//
// Goal: keep behaviour identical to the old hand-written wiring in gateway/server.ts
// while (a) collapsing the duplicated new-connector → onMessage → route → start
// boilerplate into ONE path, and (b) loading each connector's heavy dependency
// lazily so it drops out of the core bundle. Only the modules actually imported by
// a configured connector are ever required — Slack (@slack/bolt) stays a hard core
// dependency because it is the default connector, so its plugin still dynamic-imports
// but the package is present.
//
// See docs/design/connector-plugins.md.
/* eslint-disable @typescript-eslint/no-explicit-any */
import type { Connector, JinnConfig, Employee } from "../shared/types.js";
import { logger } from "../shared/logger.js";

/** Inbound HTTP webhook handler (LINE WORKS / Messenger / generic callback bots).
 *  Given the raw Node req/res, the plugin verifies + dispatches. Returns true if it
 *  handled the request. Kept intentionally minimal for Phase 1. */
export type WebhookHandler = (
  req: import("node:http").IncomingMessage,
  res: import("node:http").ServerResponse,
  body: Buffer,
) => void | Promise<void>;

/** Context handed to a plugin's create(). The heavy dep is imported lazily INSIDE
 *  create(), so a plugin's dependency is only required when it is configured. */
export interface ConnectorContext {
  logger: typeof logger;
  config: JinnConfig;
  /** Resolve the employee this connector routes to (undefined → engine default). */
  employee?: Employee;
  /** Extra portal identity + goal-injection flags a connector may need at
   *  construction time (currently only Slack consumes these). */
  portalName?: string;
  operatorName?: string;
  operatorAliases?: string[];
  goalInjectionEnabled?: boolean;
  /** Register an inbound HTTP route on the gateway HTTP server. Outbound
   *  connectors (Slack Socket Mode, Discord GW) don't need this. */
  mountWebhook(path: string, handler: WebhookHandler): void;
}

export interface ConnectorPlugin {
  type: string;
  /** Heavy deps are dynamic-imported inside create(); may be async. */
  create(cfg: Record<string, any>, ctx: ConnectorContext): Promise<Connector> | Connector;
}

// ---- Built-in plugins (lazy factories) -------------------------------------
// Each entry dynamic-imports the connector module only when invoked, so the
// connector's heavy dependency is not pulled into the core bundle unless it is
// actually configured. `discord-remote` is a distinct built-in for the legacy
// proxyVia form (RemoteDiscordConnector).

const BUILTINS: Record<string, () => Promise<ConnectorPlugin>> = {
  slack: async () => ({
    type: "slack",
    async create(cfg, ctx) {
      const { SlackConnector } = await import("./slack/index.js");
      return new SlackConnector(cfg as any, {
        portalName: ctx.portalName,
        operatorName: ctx.operatorName,
        operatorAliases: ctx.operatorAliases,
        goalInjectionEnabled: ctx.goalInjectionEnabled,
      });
    },
  }),
  discord: async () => ({
    type: "discord",
    async create(cfg) {
      const { DiscordConnector } = await import("./discord/index.js");
      return new DiscordConnector(cfg as any);
    },
  }),
  "discord-remote": async () => ({
    type: "discord-remote",
    async create(cfg) {
      const { RemoteDiscordConnector } = await import("./discord/remote.js");
      return new RemoteDiscordConnector(cfg as any);
    },
  }),
  telegram: async () => ({
    type: "telegram",
    async create(cfg) {
      const { TelegramConnector } = await import("./telegram/index.js");
      return new TelegramConnector(cfg as any);
    },
  }),
  whatsapp: async () => ({
    type: "whatsapp",
    async create(cfg) {
      const { WhatsAppConnector } = await import("./whatsapp/index.js");
      return new WhatsAppConnector(cfg as any);
    },
  }),
};

/** Resolve a plugin by type. Built-ins are lazy; an external `module` specifier
 *  (Phase 2) is dynamic-imported by name. */
export async function resolvePlugin(type: string, module?: string): Promise<ConnectorPlugin> {
  const builtin = BUILTINS[type];
  if (builtin) return builtin();
  if (module) {
    const mod = await import(module).catch(() => {
      throw new Error(
        `Connector "${type}" needs the plugin package "${module}". Install it: npm i ${module}`,
      );
    });
    return (mod.default ?? mod) as ConnectorPlugin;
  }
  throw new Error(`Unknown connector type "${type}" and no "module" given.`);
}

export function hasBuiltin(type: string): boolean {
  return type in BUILTINS;
}
