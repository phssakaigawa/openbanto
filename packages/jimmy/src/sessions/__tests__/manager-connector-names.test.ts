import { describe, it, expect } from "vitest";
import { SessionManager } from "../manager.js";
import type { JinnConfig, Engine } from "../../shared/types.js";

const STUB_CONFIG = {
  jinn: { version: "0.0.0" },
  gateway: { port: 0, host: "127.0.0.1" },
  engines: {
    default: "claude",
    claude: { bin: "claude", model: "" },
    codex: { bin: "codex", model: "" },
  },
  connectors: {},
  logging: { level: "info", stdout: false, file: "" },
} as unknown as JinnConfig;

describe("SessionManager.setConnectorNames", () => {
  it("replaces the connector names list (used in engine system prompt)", () => {
    const engines = new Map<string, Engine>();
    const mgr = new SessionManager(STUB_CONFIG, engines, ["slack"]);

    // Read via a minimal indirect path: call setConnectorNames and verify
    // the internal list updates by going through a public method that uses it.
    // Since `connectorNames` is private and only consumed by buildContext
    // (called from runEngine), we expose state by calling setConnectorNames
    // and then inspecting via the `(mgr as any).connectorNames` escape hatch.
    // This is acceptable for a focused unit test on a public setter.

    expect((mgr as any).connectorNames).toEqual(["slack"]);

    mgr.setConnectorNames(["slack", "discord", "telegram"]);
    expect((mgr as any).connectorNames).toEqual(["slack", "discord", "telegram"]);

    mgr.setConnectorNames([]);
    expect((mgr as any).connectorNames).toEqual([]);
  });

  it("copies the input array (mutating the caller's array does not affect the manager)", () => {
    const engines = new Map<string, Engine>();
    const mgr = new SessionManager(STUB_CONFIG, engines, []);
    const input = ["slack"];
    mgr.setConnectorNames(input);
    input.push("discord");
    expect((mgr as any).connectorNames).toEqual(["slack"]);
  });
});
