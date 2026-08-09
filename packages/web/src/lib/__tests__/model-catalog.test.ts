import { describe, it, expect } from "vitest"
import {
  CLAUDE_MODELS,
  OPENAI_MODELS,
  DEFAULT_CODEX_MODEL,
  DEFAULT_CLAUDE_MODEL,
  modelsForEngine,
  withCurrentValue,
} from "@/lib/model-catalog"

describe("model-catalog", () => {
  it("defaults Codex to GPT-5.6 (Sol) and Claude to Opus 5 (explicit id)", () => {
    expect(DEFAULT_CODEX_MODEL).toBe("gpt-5.6-sol")
    expect(DEFAULT_CLAUDE_MODEL).toBe("claude-opus-5")
    expect(OPENAI_MODELS[0].value).toBe("gpt-5.6-sol")
    expect(CLAUDE_MODELS[0].value).toBe("claude-opus-5")
    expect(CLAUDE_MODELS.some((m) => m.value === DEFAULT_CLAUDE_MODEL)).toBe(true)
  })

  it("keeps Opus 4.8 pin and the bare opus alias selectable", () => {
    const ids = CLAUDE_MODELS.map((m) => m.value)
    expect(ids).toEqual(expect.arrayContaining(["claude-opus-4-8", "opus"]))
  })

  it("exposes the GPT-5.6 松竹梅 tiers (Sol / Terra / Luna)", () => {
    const ids = OPENAI_MODELS.map((m) => m.value)
    expect(ids).toEqual(expect.arrayContaining(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]))
  })

  it("modelsForEngine returns Claude models for claude, OpenAI models otherwise", () => {
    expect(modelsForEngine("claude")).toBe(CLAUDE_MODELS)
    expect(modelsForEngine("codex")).toBe(OPENAI_MODELS)
    expect(modelsForEngine(undefined)).toBe(OPENAI_MODELS)
  })

  it("withCurrentValue keeps an unknown hand-typed value selectable", () => {
    const opts = withCurrentValue(OPENAI_MODELS, "gpt-legacy-custom")
    expect(opts.at(-1)).toEqual({
      value: "gpt-legacy-custom",
      label: "gpt-legacy-custom（現在の設定）",
    })
  })

  it("withCurrentValue is a no-op for a known or empty value", () => {
    expect(withCurrentValue(OPENAI_MODELS, "gpt-5.6-sol")).toBe(OPENAI_MODELS)
    expect(withCurrentValue(OPENAI_MODELS, "")).toBe(OPENAI_MODELS)
    expect(withCurrentValue(OPENAI_MODELS, undefined)).toBe(OPENAI_MODELS)
  })
})
