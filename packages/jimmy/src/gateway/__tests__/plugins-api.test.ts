import { describe, it, expect } from "vitest";
import type { IncomingMessage } from "node:http";
import {
  validateModuleSpec,
  requirePluginAdmin,
  summarizePlugins,
  summarizeMcpServers,
  buildMcpBlock,
  mergeSecretMap,
} from "../plugins-api.js";
import type { JinnConfig } from "../../shared/types.js";

describe("validateModuleSpec", () => {
  it("accepts plain npm package names", () => {
    expect(validateModuleSpec("my-guardrail").ok).toBe(true);
    expect(validateModuleSpec("my-guardrail").kind).toBe("npm");
    expect(validateModuleSpec("@openbanto/some-engine").ok).toBe(true);
    expect(validateModuleSpec("@scope/pkg.name_2").ok).toBe(true);
  });

  it("accepts versioned npm package names", () => {
    expect(validateModuleSpec("pkg@1.2.3").ok).toBe(true);
    expect(validateModuleSpec("@scope/pkg@^2.0.0").ok).toBe(true);
    expect(validateModuleSpec("pkg@latest").ok).toBe(true);
  });

  it("accepts git+https URLs", () => {
    const v = validateModuleSpec("git+https://github.com/acme/plugin.git#v1.0.0");
    expect(v.ok).toBe(true);
    expect(v.kind).toBe("git");
    expect(validateModuleSpec("git+https://gitlab.example.com/x/y").ok).toBe(true);
  });

  it("rejects shell metacharacters (command injection)", () => {
    expect(validateModuleSpec("pkg; rm -rf /").ok).toBe(false);
    expect(validateModuleSpec("pkg && curl evil").ok).toBe(false);
    expect(validateModuleSpec("pkg`whoami`").ok).toBe(false);
    expect(validateModuleSpec("pkg$(id)").ok).toBe(false);
    expect(validateModuleSpec("pkg | sh").ok).toBe(false);
    expect(validateModuleSpec("pkg\nrm").ok).toBe(false);
    expect(validateModuleSpec('pkg"x').ok).toBe(false);
  });

  it("rejects local / absolute / relative paths", () => {
    expect(validateModuleSpec("/abs/path/to/pkg").ok).toBe(false);
    expect(validateModuleSpec("./local").ok).toBe(false);
    expect(validateModuleSpec("../up").ok).toBe(false);
    expect(validateModuleSpec("~/home").ok).toBe(false);
    expect(validateModuleSpec("file:../evil").ok).toBe(false);
    expect(validateModuleSpec("link:../evil").ok).toBe(false);
    expect(validateModuleSpec("C:\\Windows\\pkg").ok).toBe(false);
  });

  it("rejects non-git+https protocols", () => {
    expect(validateModuleSpec("http://example.com/x").ok).toBe(false);
    expect(validateModuleSpec("https://example.com/x").ok).toBe(false);
    expect(validateModuleSpec("git://example.com/x").ok).toBe(false);
    expect(validateModuleSpec("git+ssh://git@host/x").ok).toBe(false);
    expect(validateModuleSpec("ssh://host/x").ok).toBe(false);
  });

  it("rejects empty / non-string / overly long", () => {
    expect(validateModuleSpec("").ok).toBe(false);
    expect(validateModuleSpec("   ").ok).toBe(false);
    expect(validateModuleSpec(42 as unknown as string).ok).toBe(false);
    expect(validateModuleSpec(undefined as unknown as string).ok).toBe(false);
    expect(validateModuleSpec("a".repeat(600)).ok).toBe(false);
  });
});

// Minimal fake request for gate tests.
function fakeReq(opts: { headers?: Record<string, string>; remoteAddress?: string }): IncomingMessage {
  return {
    headers: opts.headers ?? {},
    socket: { remoteAddress: opts.remoteAddress ?? "203.0.113.9" },
  } as unknown as IncomingMessage;
}

const baseConfig = (overrides: Partial<JinnConfig["plugins"]> = {}): JinnConfig =>
  ({
    plugins: { manageUi: true, adminGroup: "openbanto-admins", ...overrides },
    engines: { default: "claude" },
    connectors: {},
  } as unknown as JinnConfig);

describe("requirePluginAdmin", () => {
  it("403s when manageUi is not true", () => {
    const cfg = { plugins: { manageUi: false } } as unknown as JinnConfig;
    const g = requirePluginAdmin(fakeReq({}), cfg);
    expect(g.ok).toBe(false);
    expect(g.status).toBe(403);
  });

  it("403s when plugins block absent", () => {
    const cfg = {} as unknown as JinnConfig;
    expect(requirePluginAdmin(fakeReq({}), cfg).ok).toBe(false);
  });

  it("allows when X-Forwarded-Groups contains the admin group", () => {
    const req = fakeReq({ headers: { "x-forwarded-groups": "a,openbanto-admins,b", "x-forwarded-email": "u@x.com" } });
    const g = requirePluginAdmin(req, baseConfig());
    expect(g.ok).toBe(true);
    expect(g.who).toBe("u@x.com");
  });

  it("denies when groups present but admin group missing", () => {
    const req = fakeReq({ headers: { "x-forwarded-groups": "a,b" } });
    const g = requirePluginAdmin(req, baseConfig());
    expect(g.ok).toBe(false);
    expect(g.status).toBe(403);
  });

  it("allows loopback when no proxy headers", () => {
    expect(requirePluginAdmin(fakeReq({ remoteAddress: "127.0.0.1" }), baseConfig()).ok).toBe(true);
    expect(requirePluginAdmin(fakeReq({ remoteAddress: "::1" }), baseConfig()).ok).toBe(true);
    const g = requirePluginAdmin(fakeReq({ remoteAddress: "127.0.0.1" }), baseConfig());
    expect(g.who).toBe("localhost");
  });

  it("denies non-loopback with no proxy headers", () => {
    const g = requirePluginAdmin(fakeReq({ remoteAddress: "10.0.0.5" }), baseConfig());
    expect(g.ok).toBe(false);
    expect(g.status).toBe(403);
  });

  it("honors a custom admin group", () => {
    const req = fakeReq({ headers: { "x-forwarded-groups": "custom-admins" } });
    expect(requirePluginAdmin(req, baseConfig({ adminGroup: "custom-admins" })).ok).toBe(true);
  });
});

describe("summarizePlugins", () => {
  it("classifies builtin vs module engines and reflects default as enabled", () => {
    const cfg = {
      plugins: { manageUi: true },
      engines: {
        default: "claude",
        claude: { bin: "claude", model: "sonnet" },
        myeng: { module: "my-engine-plugin", foo: "bar" },
      },
      connectors: {
        slack: { botToken: "x" },
        acme: { module: "acme-connector", enabled: false },
      },
      guardrails: { module: "my-guardrail", config: { block: ["x"] } },
    } as unknown as JinnConfig;
    const s = summarizePlugins(cfg);
    const claude = s.engines.find((e) => e.name === "claude");
    const myeng = s.engines.find((e) => e.name === "myeng");
    expect(claude?.kind).toBe("builtin");
    expect(claude?.enabled).toBe(true);
    expect(myeng?.kind).toBe("module");
    expect(myeng?.module).toBe("my-engine-plugin");
    expect(myeng?.hasConfig).toBe(true);

    const slack = s.connectors.find((c) => c.name === "slack");
    const acme = s.connectors.find((c) => c.name === "acme");
    expect(slack?.kind).toBe("builtin");
    expect(acme?.kind).toBe("module");
    expect(acme?.enabled).toBe(false);

    expect(s.guardrails[0].kind).toBe("module");
    expect(s.guardrails[0].hasConfig).toBe(true);
  });

  it("reports the noop guardrail when none configured", () => {
    const cfg = { engines: { default: "claude" }, connectors: {} } as unknown as JinnConfig;
    const s = summarizePlugins(cfg);
    expect(s.guardrails[0].name).toBe("noop");
    expect(s.guardrails[0].kind).toBe("builtin");
  });
});

describe("mergeSecretMap (secret preserve-on-blank)", () => {
  it("keeps stored value when incoming value is blank", () => {
    const out = mergeSecretMap({ Authorization: "" }, { Authorization: "Bearer stored" });
    expect(out).toEqual({ Authorization: "Bearer stored" });
  });

  it("overwrites stored value when incoming value is non-empty", () => {
    const out = mergeSecretMap({ Authorization: "Bearer new" }, { Authorization: "Bearer old" });
    expect(out).toEqual({ Authorization: "Bearer new" });
  });

  it("drops a blank key with no stored value", () => {
    const out = mergeSecretMap({ X: "" }, undefined);
    expect(out).toBeUndefined();
  });

  it("preserves the whole stored map when no incoming map is supplied", () => {
    const out = mergeSecretMap(undefined, { A: "1", B: "2" });
    expect(out).toEqual({ A: "1", B: "2" });
  });

  it("returns undefined for empty inputs", () => {
    expect(mergeSecretMap({}, undefined)).toBeUndefined();
    expect(mergeSecretMap(undefined, undefined)).toBeUndefined();
  });
});

describe("buildMcpBlock (validation + secret preserve)", () => {
  it("rejects a bad name", () => {
    const r = buildMcpBlock({ name: "Bad Name", transport: "url", url: "https://x" }, undefined);
    expect(r.ok).toBe(false);
  });

  it("rejects an unknown transport", () => {
    const r = buildMcpBlock({ name: "x", transport: "grpc" as never }, undefined);
    expect(r.ok).toBe(false);
  });

  it("URL: requires an http(s) url and sets type:sse", () => {
    expect(buildMcpBlock({ name: "x", transport: "url", url: "ftp://nope" }, undefined).ok).toBe(false);
    const r = buildMcpBlock({ name: "x", transport: "url", url: "https://mcp.example.com/sse" }, undefined);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.block.type).toBe("sse");
      expect(r.block.url).toBe("https://mcp.example.com/sse");
      expect(r.created).toBe(true);
    }
  });

  it("stdio: requires a command; args cleaned", () => {
    expect(buildMcpBlock({ name: "x", transport: "stdio", command: "" }, undefined).ok).toBe(false);
    const r = buildMcpBlock(
      { name: "x", transport: "stdio", command: "npx", args: [" -y ", "", "@a/b"] as string[] },
      undefined,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.block.command).toBe("npx");
      expect(r.block.args).toEqual(["-y", "@a/b"]);
    }
  });

  it("edit preserves stored header secret when value left blank", () => {
    const existing = { type: "sse", url: "https://old", headers: { Authorization: "Bearer stored" } };
    const r = buildMcpBlock(
      { name: "x", transport: "url", url: "https://new", headers: { Authorization: "" } },
      existing,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.block.headers).toEqual({ Authorization: "Bearer stored" });
      expect(r.block.url).toBe("https://new");
      expect(r.created).toBe(false);
    }
  });

  it("only writes enabled:false (omits when enabled)", () => {
    const on = buildMcpBlock({ name: "x", transport: "stdio", command: "c", enabled: true }, undefined);
    const off = buildMcpBlock({ name: "x", transport: "stdio", command: "c", enabled: false }, undefined);
    if (on.ok) expect("enabled" in on.block).toBe(false);
    if (off.ok) expect(off.block.enabled).toBe(false);
  });
});

describe("summarizeMcpServers (masking)", () => {
  it("masks header/env values to booleans and surfaces url/command", () => {
    const cfg = {
      mcp: {
        custom: {
          remote: { type: "sse", url: "https://mcp.example.com/sse", headers: { Authorization: "Bearer SECRET" } },
          local: { command: "npx", args: ["-y", "@a/b"], env: { TOKEN: "SECRET" }, enabled: false },
        },
      },
    } as unknown as JinnConfig;
    const list = summarizeMcpServers(cfg);
    const remote = list.find((s) => s.name === "remote")!;
    const local = list.find((s) => s.name === "local")!;
    expect(remote.transport).toBe("url");
    expect(remote.url).toBe("https://mcp.example.com/sse");
    expect(remote.hasHeaders).toBe(true);
    expect(remote.enabled).toBe(true);
    expect(local.transport).toBe("stdio");
    expect(local.command).toBe("npx");
    expect(local.hasEnv).toBe(true);
    expect(local.enabled).toBe(false);
    // No secret value must appear anywhere in the serialized summary.
    expect(JSON.stringify(list)).not.toContain("SECRET");
  });

  it("returns [] when no custom servers", () => {
    expect(summarizeMcpServers({} as unknown as JinnConfig)).toEqual([]);
  });
});
