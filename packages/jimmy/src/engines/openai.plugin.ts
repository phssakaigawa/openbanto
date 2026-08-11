// OpenAI-compatible HTTP engine plugin.
//
// This is the plugin the registry resolves for ANY config engine block that
// carries `impl: "openai"` — the third resolution path alongside built-in names
// (bob/claude/codex/gemini) and external `module` specifiers. One plugin, many
// named instances: `engines.aidea` and `engines.kannon` both resolve here and
// each get their own OpenAiEngine built from their own baseUrl/apiKey/model.
//
// See openai.ts, registry.ts (resolveEngine / IMPL_PLUGINS) and
// docs/design/http-engine-skeleton.md.
import type { EngineContext } from "./registry.js";
import { defineEnginePlugin } from "./registry.js";

export default defineEnginePlugin({
  name: "openai",
  capabilities: {
    transport: "http",
    interactive: false, // each turn is a fresh HTTP request (no surviving process)
    supportsFork: false, // no live process to fork
    syncResume: false, // no transcript hand-back after a fallback (MVP)
    usableAsFallback: false, // ★ the metered primary owns rate-limit fallback
    usableAsOneShot: false, // one-shot (triage/goal/migrate) is CLI-only today
    models: [], // per-instance model comes from engines.<name>.model (picker wiring)
    effort: "none",
  },
  // No defaultBin — HTTP engine has no binary.
  async create(cfg: Record<string, unknown>, _ctx: EngineContext) {
    void _ctx;
    const c = cfg as {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      headers?: Record<string, string>;
      temperature?: number;
      name?: string;
    };
    if (!c.baseUrl || typeof c.baseUrl !== "string") {
      throw new Error(`openai engine "${c.name ?? "openai"}" requires "baseUrl"`);
    }
    if (!c.apiKey || typeof c.apiKey !== "string") {
      throw new Error(`openai engine "${c.name ?? "openai"}" requires "apiKey"`);
    }
    if (!c.model || typeof c.model !== "string") {
      throw new Error(`openai engine "${c.name ?? "openai"}" requires "model"`);
    }
    // Lazy import keeps the module out of the graph until an openai engine is
    // actually configured (mirrors the other plugins' create()).
    const { OpenAiEngine } = await import("./openai.js");
    return new OpenAiEngine({
      baseUrl: c.baseUrl,
      apiKey: c.apiKey,
      model: c.model,
      headers: c.headers,
      temperature: c.temperature,
      name: c.name,
    });
  },
});
