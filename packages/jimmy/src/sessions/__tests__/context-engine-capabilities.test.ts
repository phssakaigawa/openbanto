import { describe, it, expect } from "vitest";
import { buildContext } from "../context.js";

// The system prompt must not promise a local shell / filesystem to an engine
// that can't back it. A CLI engine (claude) has native FS; an OpenAI-compatible
// HTTP engine (impl:"openai") does not — it acts only through MCP tools. Getting
// this wrong made the OpenAI-compatible engine role-play "I'll read CLAUDE.md
// with Bash" for tools it doesn't have.
describe("buildContext — engine-aware capability claims", () => {
  const baseOpts = { source: "slack", channel: "C1", user: "U1" };
  const base = {
    jinn: { version: "0" },
    gateway: { port: 7777, host: "127.0.0.1" },
    connectors: {},
    logging: { level: "info", stdout: false, file: "" },
  };

  const claudeConfig = {
    ...base,
    engines: { default: "claude", claude: { bin: "claude", model: "" }, codex: { bin: "codex", model: "" } },
  };
  const openaiConfig = {
    ...base,
    engines: {
      default: "myllm",
      claude: { bin: "claude", model: "" },
      codex: { bin: "codex", model: "" },
      myllm: { impl: "openai", baseUrl: "https://llm.example/v1", apiKey: "k", model: "m" },
    },
  };

  it("claude (native FS) is told it can use the filesystem and shell", () => {
    const ctx = buildContext({ ...baseOpts, config: claudeConfig as never });
    expect(ctx).toContain("You have access to the filesystem, can run commands");
    expect(ctx).toContain("## Your home directory");
    expect(ctx).toContain("`CLAUDE.md` — user-defined instructions");
  });

  it("OpenAI-compatible engine is told it has NO shell/filesystem and works via tools", () => {
    const ctx = buildContext({ ...baseOpts, config: openaiConfig as never });
    expect(ctx).toContain("configured **tools** (MCP");
    expect(ctx).toContain("NO local shell or filesystem");
    // Must NOT promise capabilities it lacks
    expect(ctx).not.toContain("You have access to the filesystem, can run commands");
    expect(ctx).not.toContain("## Your home directory");
    expect(ctx).not.toContain("Run shell commands");
  });
});
