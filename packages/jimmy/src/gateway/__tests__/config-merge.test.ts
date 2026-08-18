import { describe, it, expect } from "vitest";
import { deepMerge, maskConfigSecrets } from "../api.js";

/**
 * PUT /api/config deep-merges the incoming partial config into the on-disk one
 * before writing. The Settings UI's interactive-PTY toggle relies on this: a
 * partial `{ engines: { claude: { interactive } } }` must set the flag WITHOUT
 * dropping connector secrets or sibling engine fields.
 */
describe("deepMerge (PUT /api/config)", () => {
  const existing = {
    engines: {
      default: "claude",
      claude: { bin: "claude", model: "opus", effortLevel: "medium" },
      codex: { bin: "codex", model: "gpt-5.5" },
    },
    connectors: {
      slack: { botToken: "xoxb-secret", appToken: "xapp-secret", signingSecret: "sig" },
    },
  };

  it("sets engines.claude.interactive while preserving connectors + sibling fields", () => {
    const merged = deepMerge(existing as Record<string, unknown>, {
      engines: { claude: { interactive: true } },
    });
    const m = merged as typeof existing & { engines: { claude: { interactive?: boolean } } };

    expect(m.engines.claude.interactive).toBe(true);
    // sibling claude fields preserved
    expect(m.engines.claude.bin).toBe("claude");
    expect(m.engines.claude.model).toBe("opus");
    expect(m.engines.claude.effortLevel).toBe("medium");
    // other engines preserved
    expect(m.engines.codex.model).toBe("gpt-5.5");
    // connector secrets NOT dropped by a partial engines update
    expect(m.connectors.slack.botToken).toBe("xoxb-secret");
    expect(m.connectors.slack.appToken).toBe("xapp-secret");
  });

  it("flips interactive back to false without touching the rest", () => {
    const on = deepMerge(existing as Record<string, unknown>, { engines: { claude: { interactive: true } } });
    const off = deepMerge(on, { engines: { claude: { interactive: false } } }) as typeof existing & {
      engines: { claude: { interactive?: boolean } };
    };
    expect(off.engines.claude.interactive).toBe(false);
    expect((off as typeof existing).connectors.slack.botToken).toBe("xoxb-secret");
  });
});

/**
 * GET /api/config must never leak a secret in the clear. Regression guard for
 * the admin-console leak: OpenAI-compatible engine apiKey + MCP Authorization headers were
 * being served verbatim while Slack tokens were already masked.
 */
describe("maskConfigSecrets (GET /api/config)", () => {
  const config = {
    engines: {
      default: "myllm",
      claude: { bin: "claude", model: "opus" },
      myllm: {
        impl: "openai",
        baseUrl: "https://llm.example/v1",
        model: "llm-1",
        apiKey: "sk-SUPERSECRET",
        headers: { "X-Org": "getworks", Authorization: "Bearer legacy-tok" },
      },
    },
    connectors: {
      slack: { botToken: "xoxb-secret", appToken: "xapp-secret", signingSecret: "sig" },
    },
    mcp: {
      search: { enabled: true, provider: "brave", apiKey: "brave-KEY" },
      custom: {
        netbox: {
          type: "sse",
          url: "https://banto-netbox.example.internal/mcp",
          headers: { Authorization: "Bearer netbox-mcp-KEY" },
        },
        localtool: {
          command: "node",
          args: ["server.js"],
          env: { API_TOKEN: "env-SECRET", DEBUG: "1" },
        },
      },
    },
  };

  it("masks engine apiKey, auth headers, search apiKey and MCP env — keeps non-secrets", () => {
    const m = maskConfigSecrets(config) as typeof config;

    // engine secrets
    expect(m.engines.myllm.apiKey).toBe("***");
    expect(m.engines.myllm.headers.Authorization).toBe("***");
    // non-secret header value inside a headers block is still masked (whole map is secret)
    expect(m.engines.myllm.headers["X-Org"]).toBe("***");
    // non-secret engine fields untouched
    expect(m.engines.myllm.baseUrl).toBe("https://llm.example/v1");
    expect(m.engines.myllm.model).toBe("llm-1");

    // connector secrets (existing behavior preserved)
    expect(m.connectors.slack.botToken).toBe("***");
    expect(m.connectors.slack.appToken).toBe("***");
    expect(m.connectors.slack.signingSecret).toBe("***");

    // mcp secrets
    expect(m.mcp.search.apiKey).toBe("***");
    expect(m.mcp.custom.netbox.headers.Authorization).toBe("***");
    expect(m.mcp.custom.netbox.url).toBe("https://banto-netbox.example.internal/mcp");
    expect(m.mcp.custom.localtool.env.API_TOKEN).toBe("***");
    expect(m.mcp.custom.localtool.env.DEBUG).toBe("***");
    expect(m.mcp.custom.localtool.command).toBe("node");
  });

  it("does not mutate the source config", () => {
    maskConfigSecrets(config);
    expect(config.engines.myllm.apiKey).toBe("sk-SUPERSECRET");
    expect(config.mcp.custom.netbox.headers.Authorization).toBe("Bearer netbox-mcp-KEY");
  });

  it("round-trips: PUT of a masked config preserves real secrets", () => {
    const masked = maskConfigSecrets(config) as Record<string, unknown>;
    const merged = deepMerge(
      config as Record<string, unknown>,
      masked,
    ) as typeof config;

    expect(merged.engines.myllm.apiKey).toBe("sk-SUPERSECRET");
    expect(merged.engines.myllm.headers.Authorization).toBe("Bearer legacy-tok");
    expect(merged.connectors.slack.botToken).toBe("xoxb-secret");
    expect(merged.mcp.search.apiKey).toBe("brave-KEY");
    expect(merged.mcp.custom.netbox.headers.Authorization).toBe("Bearer netbox-mcp-KEY");
    expect(merged.mcp.custom.localtool.env.API_TOKEN).toBe("env-SECRET");
  });
});
