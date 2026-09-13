import { describe, expect, it } from "vitest";
import { resolveMcpServers } from "../resolver.js";
import type { Employee, McpGlobalConfig } from "../../shared/types.js";

const emp = (name: string, mcp?: Employee["mcp"]): Employee =>
  ({ name, displayName: name, department: "d", rank: "employee", engine: "claude", model: "opus", persona: "", mcp }) as Employee;

// employee-scoped custom server: only the named employees receive it
const mcpConfig: McpGlobalConfig = {
  browser: { enabled: false },
  fetch: { enabled: false },
  gateway: { enabled: false },
  knowledge: { enabled: false },
  custom: {
    "k8s-onboarding": { url: "https://example.internal/mcp", employees: ["k8s"] },
    "open-tool": { url: "https://example.internal/open" },
  },
} as unknown as McpGlobalConfig;

describe("resolver: employee-scoped custom MCP servers", () => {
  it("default (no-employee) persona does not receive an employee-scoped server", () => {
    const r = resolveMcpServers(mcpConfig, undefined);
    expect(Object.keys(r.mcpServers)).not.toContain("k8s-onboarding");
    expect(Object.keys(r.mcpServers)).toContain("open-tool");
  });

  it("listed employee receives the scoped server (via mcp allowlist)", () => {
    const r = resolveMcpServers(mcpConfig, emp("k8s", ["k8s-onboarding"]));
    expect(Object.keys(r.mcpServers)).toContain("k8s-onboarding");
  });

  it("other employees do not receive the scoped server even with mcp: true", () => {
    const r = resolveMcpServers(mcpConfig, emp("netbox", true));
    expect(Object.keys(r.mcpServers)).not.toContain("k8s-onboarding");
    expect(Object.keys(r.mcpServers)).toContain("open-tool");
  });

  it("the employees key never leaks into the resolved server config", () => {
    const r = resolveMcpServers(mcpConfig, emp("k8s", ["k8s-onboarding"]));
    expect((r.mcpServers["k8s-onboarding"] as unknown as Record<string, unknown>).employees).toBeUndefined();
  });
});
