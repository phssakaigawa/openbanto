import { describe, expect, it } from "vitest";
import { resolveMcpServers } from "../resolver.js";
import type { JinnConfig, McpServerStdioConfig, McpServerUrlConfig } from "../../shared/types.js";

describe("resolveMcpServers", () => {
  it("passes current conversation context to the gateway MCP server", () => {
    const config = {
      gateway: { enabled: true },
      browser: { enabled: false },
      fetch: { enabled: false },
      search: { enabled: false },
    } satisfies JinnConfig["mcp"];

    const resolved = resolveMcpServers(config, undefined, {
      connector: "slack",
      channel: "C123",
      thread: "1700000000.000100",
    });

    const gateway = resolved.mcpServers.gateway as McpServerStdioConfig;
    expect(gateway.env).toMatchObject({
      JINN_CURRENT_CONNECTOR: "slack",
      JINN_CURRENT_CHANNEL: "C123",
      JINN_CURRENT_THREAD: "1700000000.000100",
    });
  });

  it("includes the built-in knowledge server by default", () => {
    const config = {
      browser: { enabled: false },
      fetch: { enabled: false },
      search: { enabled: false },
    } satisfies JinnConfig["mcp"];

    const resolved = resolveMcpServers(config, undefined);
    const knowledge = resolved.mcpServers.knowledge as McpServerStdioConfig;
    expect(knowledge).toBeDefined();
    expect(knowledge.command).toBe("node");
    expect(knowledge.args?.[0]).toMatch(/knowledge-server\.js$/);
  });

  it("omits the knowledge server when explicitly disabled", () => {
    const config = {
      knowledge: { enabled: false },
      browser: { enabled: false },
      fetch: { enabled: false },
      search: { enabled: false },
    } satisfies JinnConfig["mcp"];

    const resolved = resolveMcpServers(config, undefined);
    expect(resolved.mcpServers.knowledge).toBeUndefined();
  });
});

describe("resolveMcpServers — per-turn identity injection (番頭ID伝播)", () => {
  it("injects JINN_USER_* env into stdio servers when identity is present", () => {
    const config = {
      knowledge: { enabled: true },
      gateway: { enabled: false },
      browser: { enabled: false },
      fetch: { enabled: false },
      search: { enabled: false },
    } satisfies JinnConfig["mcp"];

    const resolved = resolveMcpServers(config, undefined, {
      connector: "slack",
      channel: "C123",
      userId: "U999",
      userKey: "u999",
      userName: "sakaigawa",
    });

    const knowledge = resolved.mcpServers.knowledge as McpServerStdioConfig;
    expect(knowledge.env).toMatchObject({
      JINN_USER_ID: "U999",
      JINN_USER_KEY: "u999",
      JINN_USER_NAME: "sakaigawa",
      JINN_CONNECTOR: "slack",
      JINN_CHANNEL: "C123",
    });
  });

  it("injects X-Banto-* headers into URL servers and preserves static auth", () => {
    const config = {
      knowledge: { enabled: false },
      gateway: { enabled: false },
      browser: { enabled: false },
      fetch: { enabled: false },
      search: { enabled: false },
      custom: {
        ledger: {
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer STATIC" },
        },
      },
    } satisfies JinnConfig["mcp"];

    const resolved = resolveMcpServers(config, undefined, {
      connector: "slack",
      channel: "C123",
      userId: "U999",
      userKey: "u999",
      userName: "sakaigawa",
    });

    const ledger = resolved.mcpServers.ledger as McpServerUrlConfig;
    expect(ledger.headers).toMatchObject({
      Authorization: "Bearer STATIC", // static auth preserved
      "X-Banto-User-Id": "U999",
      "X-Banto-User-Key": "u999",
      "X-Banto-User-Name": "sakaigawa",
      "X-Banto-Connector": "slack",
      "X-Banto-Channel": "C123",
    });
  });

  it("does NOT inject identity keys when no identity is present (backward compatible)", () => {
    const config = {
      knowledge: { enabled: true },
      gateway: { enabled: false },
      browser: { enabled: false },
      fetch: { enabled: false },
      search: { enabled: false },
      custom: {
        ledger: {
          url: "https://example.test/mcp",
          headers: { Authorization: "Bearer STATIC" },
        },
      },
    } satisfies JinnConfig["mcp"];

    const resolved = resolveMcpServers(config, undefined, {
      connector: "slack",
      channel: "C123",
      // no userId / userKey / userName
    });

    const knowledge = resolved.mcpServers.knowledge as McpServerStdioConfig;
    expect(knowledge.env?.JINN_USER_ID).toBeUndefined();
    expect(knowledge.env?.JINN_USER_KEY).toBeUndefined();
    expect(knowledge.env?.JINN_USER_NAME).toBeUndefined();

    const ledger = resolved.mcpServers.ledger as McpServerUrlConfig;
    expect(ledger.headers?.["X-Banto-User-Id"]).toBeUndefined();
    expect(ledger.headers?.["X-Banto-User-Key"]).toBeUndefined();
    // static auth still intact
    expect(ledger.headers?.Authorization).toBe("Bearer STATIC");
  });
});
