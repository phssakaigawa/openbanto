import { describe, expect, it } from "vitest";
import { resolveMcpServers } from "../resolver.js";
import type { JinnConfig, McpServerStdioConfig } from "../../shared/types.js";

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
