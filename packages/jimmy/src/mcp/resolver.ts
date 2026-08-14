import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  McpGlobalConfig,
  McpServerConfig,
  McpServerStdioConfig,
  McpServerUrlConfig,
  Employee,
} from "../shared/types.js";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";

export interface ResolvedMcpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

export interface McpSessionContext {
  connector?: string;
  channel?: string;
  thread?: string;
  /**
   * Identity of the Slack (or other connector) user who spoke THIS turn. The
   * banto injects this into every MCP server (shokunin/職人) so each tool
   * scopes its persistent I/O per-user. See `docs/design/shokunin-contract.md`.
   */
  userId?: string;
  /** Filesystem-safe user key (SlackID-preferred, see sessions/context.ts userKey). */
  userKey?: string;
  /** Human display name of the speaker (msg.user). */
  userName?: string;
}

/**
 * Resolve the MCP servers that should be available for a given employee
 * based on global config and employee-level overrides.
 */
export function resolveMcpServers(
  globalMcp: McpGlobalConfig | undefined,
  employee?: Employee,
  sessionContext?: McpSessionContext,
): ResolvedMcpConfig {
  const servers: Record<string, McpServerConfig> = {};

  if (!globalMcp) return { mcpServers: servers };

  // Build the full set of available MCP servers from global config
  const available = buildAvailableServers(globalMcp, sessionContext);

  // Determine which servers this employee gets
  const employeeMcp = employee?.mcp;

  if (employeeMcp === false) {
    // Employee explicitly opted out of all MCP servers
    return { mcpServers: {} };
  }

  if (Array.isArray(employeeMcp)) {
    // Employee wants only specific servers
    for (const name of employeeMcp) {
      if (available[name]) {
        servers[name] = available[name];
      } else {
        logger.warn(`Employee ${employee?.name} requests MCP server "${name}" but it's not configured`);
      }
    }
  } else {
    // Employee gets all enabled servers (default behavior, or mcp: true)
    Object.assign(servers, available);
  }

  return { mcpServers: servers };
}

/**
 * Build the map of all available (enabled) MCP servers from global config.
 */
function buildAvailableServers(config: McpGlobalConfig, sessionContext?: McpSessionContext): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  // Browser automation via Playwright
  if (config.browser?.enabled !== false) {
    const provider = config.browser?.provider || "playwright";
    if (provider === "playwright") {
      servers.browser = {
        command: "npx",
        args: ["-y", "@anthropic-ai/mcp-server-playwright"],
      };
    } else if (provider === "puppeteer") {
      servers.browser = {
        command: "npx",
        args: ["-y", "@anthropic-ai/mcp-server-puppeteer"],
      };
    }
  }

  // Web search via Brave
  if (config.search?.enabled) {
    const apiKey = resolveEnvVar(config.search.apiKey);
    if (apiKey) {
      servers.search = {
        command: "npx",
        args: ["-y", "brave-search-mcp"],
        env: { BRAVE_API_KEY: apiKey },
      };
    } else {
      logger.warn("MCP search enabled but no API key configured (set mcp.search.apiKey or BRAVE_API_KEY env var)");
    }
  }

  // Web fetch (content extraction)
  if (config.fetch?.enabled) {
    servers.fetch = {
      command: "npx",
      args: ["-y", "@anthropic-ai/mcp-server-fetch"],
    };
  }

  // Gateway MCP server (built-in, always uses the local gateway)
  if (config.gateway?.enabled !== false) {
    const gatewayMcpPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "dist",
      "src",
      "mcp",
      "gateway-server.js",
    );
    // Only add if the built file exists; otherwise fall back to ts-node path
    const scriptPath = fs.existsSync(gatewayMcpPath)
      ? gatewayMcpPath
      : path.resolve(path.dirname(new URL(import.meta.url).pathname), "gateway-server.js");

    servers.gateway = {
      command: "node",
      args: [scriptPath],
      env: {
        JINN_GATEWAY_URL: `http://127.0.0.1:${process.env.JINN_PORT || "7777"}`,
        ...(sessionContext?.connector ? { JINN_CURRENT_CONNECTOR: sessionContext.connector } : {}),
        ...(sessionContext?.channel ? { JINN_CURRENT_CHANNEL: sessionContext.channel } : {}),
        ...(sessionContext?.thread ? { JINN_CURRENT_THREAD: sessionContext.thread } : {}),
      },
    };
  }

  // Knowledge MCP server (built-in, scoped file IO under ~/.openbanto/knowledge/).
  // Default ON — this is the OpenAI (AiDEA) engine's only path to persist
  // per-user knowledge, since it has no native filesystem access.
  if (config.knowledge?.enabled !== false) {
    const knowledgeMcpPath = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "..",
      "dist",
      "src",
      "mcp",
      "knowledge-server.js",
    );
    // Only use the dist build if present; otherwise fall back to the sibling
    // compiled file next to this module.
    const scriptPath = fs.existsSync(knowledgeMcpPath)
      ? knowledgeMcpPath
      : path.resolve(path.dirname(new URL(import.meta.url).pathname), "knowledge-server.js");

    servers.knowledge = {
      command: "node",
      args: [scriptPath],
    };
  }

  // Custom user-defined MCP servers
  if (config.custom) {
    for (const [name, serverConfig] of Object.entries(config.custom)) {
      if (serverConfig.enabled === false) continue;
      const { enabled, ...rest } = serverConfig;

      // URL-based MCP server (HTTP/SSE transport)
      // Claude Code requires "type": "sse" for URL-based servers
      if ("url" in rest && (rest as McpServerUrlConfig).url) {
        servers[name] = { type: "sse", ...rest } as McpServerConfig;
        continue;
      }

      // Stdio-based MCP server — resolve env vars
      if ("env" in rest && rest.env) {
        for (const [key, value] of Object.entries(rest.env)) {
          rest.env[key] = resolveEnvVar(value) || value;
        }
      }
      servers[name] = rest as McpServerConfig;
    }
  }

  // ── Per-turn identity injection (番頭ID伝播) ──────────────────
  // The banto is the authority on who is speaking this turn. Stamp that
  // identity into EVERY MCP server (職人) so each tool scopes its persistent
  // I/O per-user. stdio servers receive it as JINN_USER_* env; URL servers as
  // X-Banto-* headers. Static auth (Authorization, existing env) is preserved;
  // only these well-known keys are overwritten by the banto. When no identity
  // is present (cron, tests, older callers) nothing is injected — fully
  // backward compatible. See docs/design/shokunin-contract.md.
  injectIdentity(servers, sessionContext);

  return servers;
}

/** stdio env keys the banto stamps onto every 職人 process. */
function identityEnv(ctx?: McpSessionContext): Record<string, string> {
  const env: Record<string, string> = {};
  if (!ctx) return env;
  if (ctx.userId) env.JINN_USER_ID = ctx.userId;
  if (ctx.userKey) env.JINN_USER_KEY = ctx.userKey;
  if (ctx.userName) env.JINN_USER_NAME = ctx.userName;
  if (ctx.connector) env.JINN_CONNECTOR = ctx.connector;
  if (ctx.channel) env.JINN_CHANNEL = ctx.channel;
  return env;
}

/** URL header keys the banto stamps onto every HTTP 職人 request. */
function identityHeaders(ctx?: McpSessionContext): Record<string, string> {
  const headers: Record<string, string> = {};
  if (!ctx) return headers;
  if (ctx.userId) headers["X-Banto-User-Id"] = ctx.userId;
  if (ctx.userKey) headers["X-Banto-User-Key"] = ctx.userKey;
  if (ctx.userName) headers["X-Banto-User-Name"] = ctx.userName;
  if (ctx.connector) headers["X-Banto-Connector"] = ctx.connector;
  if (ctx.channel) headers["X-Banto-Channel"] = ctx.channel;
  return headers;
}

/**
 * Merge the current speaker's identity into every resolved MCP server. The
 * banto's values are authoritative for the well-known keys (they overwrite),
 * but pre-existing env / static auth headers are otherwise preserved. A no-op
 * when the session carries no identity (backward compatible).
 */
function injectIdentity(
  servers: Record<string, McpServerConfig>,
  ctx?: McpSessionContext,
): void {
  const env = identityEnv(ctx);
  const headers = identityHeaders(ctx);
  if (Object.keys(env).length === 0 && Object.keys(headers).length === 0) return;

  for (const name of Object.keys(servers)) {
    const server = servers[name];
    // URL-based (HTTP/SSE) 職人 → X-Banto-* headers, keep Authorization etc.
    if ("url" in server && (server as McpServerUrlConfig).url) {
      const url = server as McpServerUrlConfig;
      url.headers = { ...(url.headers ?? {}), ...headers };
      continue;
    }
    // stdio 職人 → JINN_USER_* env, keep existing env.
    const stdio = server as McpServerStdioConfig;
    stdio.env = { ...(stdio.env ?? {}), ...env };
  }
}

/**
 * Write a resolved MCP config to a temp file and return the path.
 * Claude Code reads this via --mcp-config <path>.
 */
export function writeMcpConfigFile(config: ResolvedMcpConfig, sessionId: string): string {
  const tmpDir = path.join(JINN_HOME, "tmp", "mcp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const filePath = path.join(tmpDir, `${sessionId}.json`);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
  return filePath;
}

/**
 * Clean up a temp MCP config file.
 */
export function cleanupMcpConfigFile(sessionId: string): void {
  const filePath = path.join(JINN_HOME, "tmp", "mcp", `${sessionId}.json`);
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Resolve a value that may reference an environment variable.
 * Supports ${VAR_NAME} syntax.
 */
function resolveEnvVar(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^\$\{(.+)\}$/);
  if (match) {
    return process.env[match[1]] || undefined;
  }
  // Also check if the raw value is a plain env var name
  if (value.startsWith("$")) {
    return process.env[value.slice(1)] || undefined;
  }
  return value;
}
