import { describe, expect, it } from "vitest";
import { resolveMcpServers } from "../resolver.js";
import type { Employee, McpGlobalConfig, McpServerStdioConfig } from "../../shared/types.js";

const base: McpGlobalConfig = {
  browser: { enabled: false },
  gateway: { enabled: false },
  knowledge: { enabled: false },
  custom: { tickets: { type: "http", url: "https://x/mcp" } as never },
} as McpGlobalConfig;
const emp = (mcp: Employee["mcp"]) => ({ name: "e", displayName: "E", department: "d", rank: "employee", engine: "claude", model: "m", persona: "", mcp }) as unknown as Employee;

describe("resolver: built-in datetime server (#654)", () => {
  it("is attached by default with the session timezone", () => {
    const s = resolveMcpServers(base, undefined, { timezone: "Asia/Tokyo" }).mcpServers.datetime as McpServerStdioConfig;
    expect(s.command).toBe("node");
    expect(s.args?.[0]).toMatch(/datetime-server\.js$/);
    expect(s.env?.JINN_TIMEZONE).toBe("Asia/Tokyo");
  });
  it("is attached even to employees with an explicit server list", () => {
    const s = resolveMcpServers(base, emp(["tickets"])).mcpServers;
    expect(Object.keys(s).sort()).toEqual(["datetime", "tickets"]);
  });
  it("is not attached when the employee opted out of MCP or it is disabled", () => {
    expect(resolveMcpServers(base, emp(false)).mcpServers.datetime).toBeUndefined();
    expect(resolveMcpServers({ ...base, datetime: { enabled: false } }, emp(["tickets"])).mcpServers.datetime).toBeUndefined();
  });
  it("defaults the timezone to Asia/Tokyo", () => {
    const s = resolveMcpServers(base).mcpServers.datetime as McpServerStdioConfig;
    expect(s.env?.JINN_TIMEZONE).toBe("Asia/Tokyo");
  });
});
