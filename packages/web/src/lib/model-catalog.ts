// ---------------------------------------------------------------------------
// Model catalog — single source of truth for the model pickers in the settings
// UI. The engine dropdowns AND the air-reading-triage / goal-extraction model
// pickers all draw from these lists, so a new model is a one-line edit here
// rather than a hunt through hardcoded <select> blocks.
//
// Values are the exact ids passed to each engine's CLI:
//   - Claude: Opus は明示 ID `claude-opus-5` を既定にする。裸の `opus`
//     エイリアスは「インストール済み Claude CLI が知っている最新 Opus」に
//     解決されるため、CLI が古いと旧世代（4.8 等）に留まる。明示 ID なら
//     CLI バージョンに関係なく Opus 5 が使われる（ID は API パススルー）。
//     `sonnet`/`haiku` の裸エイリアスは従来どおり最新ティアに解決。
//   - OpenAI (Codex): GPT-5.6 ships three durable capability tiers —
//     Sol (上 / flagship), Terra (中 / balanced), Luna (小 / fastest & cheapest).
//     Always use the explicit tier ids (`gpt-5.6-sol` etc.): the bare
//     `gpt-5.6` alias is rejected (400) by Codex on ChatGPT accounts,
//     which is how most gateways run (subscription, not metered API).
// ---------------------------------------------------------------------------

export interface ModelOption {
  value: string
  label: string
}

/** Default model id for each engine, mirrored by the backend synth defaults. */
export const DEFAULT_CLAUDE_MODEL = "claude-opus-5"
export const DEFAULT_CODEX_MODEL = "gpt-5.6-sol"

/** Anthropic tiers. Opus は明示 ID（CLI 版数に依存しない）、他は裸エイリアス。 */
export const CLAUDE_MODELS: ModelOption[] = [
  { value: "claude-opus-5", label: "Opus 5 — 上（最上位 / 既定 / claude-opus-5）" },
  { value: "claude-opus-4-8", label: "Opus 4.8 — 旧世代（ピン留め用 / claude-opus-4-8）" },
  { value: "opus", label: "Opus — CLI が解決する最新 Opus に自動追従" },
  { value: "sonnet", label: "Sonnet 5 — 中（バランス / claude-sonnet-5）" },
  { value: "haiku", label: "Haiku 4.5 — 小（軽量・高速 / claude-haiku-4-5）" },
]

/**
 * OpenAI models. GPT-5.6 Sol / Terra / Luna lead the list as the current
 * generation's 松竹梅（上・中・小）tiers; older generations remain selectable
 * for pinning. `gpt-5-nano` stays at the tail as a cheap triage-tier option.
 */
export const OPENAI_MODELS: ModelOption[] = [
  { value: "gpt-5.6-sol", label: "GPT-5.6 Sol — 上（フラッグシップ / 既定）" },
  { value: "gpt-5.6-terra", label: "GPT-5.6 Terra — 中（バランス・低コスト）" },
  { value: "gpt-5.6-luna", label: "GPT-5.6 Luna — 小（最速・最安 / トリアージ向け）" },
  { value: "gpt-5.5", label: "GPT-5.5" },
  { value: "gpt-5.4", label: "GPT-5.4" },
  { value: "gpt-5.3-codex", label: "GPT-5.3 Codex" },
  { value: "gpt-5.2-codex", label: "GPT-5.2 Codex" },
  { value: "gpt-5.2", label: "GPT-5.2" },
  { value: "gpt-5.1-codex-max", label: "GPT-5.1 Codex Max" },
  { value: "gpt-5.1-codex-mini", label: "GPT-5.1 Codex Mini" },
  { value: "gpt-5-nano", label: "GPT-5 nano — 軽量（トリアージ向け）" },
]

/** Model list for a given triage/goal engine (defaults to the OpenAI list). */
export function modelsForEngine(engine: string | undefined): ModelOption[] {
  return engine === "claude" ? CLAUDE_MODELS : OPENAI_MODELS
}

/**
 * Ensure a currently-configured value stays selectable even when it isn't in
 * the curated catalog (e.g. a hand-typed legacy model id). Converting a field
 * from a free-text input to a <select> must never silently drop an existing
 * choice, so an unknown current value is appended as its own option.
 */
export function withCurrentValue(
  options: ModelOption[],
  current: string | undefined | null,
): ModelOption[] {
  if (!current) return options
  if (options.some((o) => o.value === current)) return options
  return [...options, { value: current, label: `${current}（現在の設定）` }]
}
