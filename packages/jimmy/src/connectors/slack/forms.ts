/**
 * Slack modal forms driven by a 職人 (MCP connector).
 *
 * Contract:
 *   1. An assistant reply ends with a marker on its own LAST line:
 *        [[form: <mcpServer>/<formId>]]
 *      The connector strips it and posts a "フォームを開く" launcher button.
 *   2. On click, the gateway calls the 職人's `get_form` tool
 *      ({ form: <formId> }) AS THE CLICKING USER and renders the returned spec
 *      as a Block Kit modal. The spec (fields, options, defaults, submitTool)
 *      lives in the 職人 — the gateway never duplicates choice lists.
 *   3. On submit, the raw field values are passed verbatim to
 *      `<mcpServer>.<submitTool>` as that user, and the tool's text result is
 *      posted to the originating thread. Values never pass through the LLM,
 *      so what the user confirmed is exactly what gets submitted.
 *
 * Unlike [[choices: …]] (≤5 buttons, LLM-emitted every time), selects here
 * accept any number of options, and dates use a real datepicker.
 */

export const FORM_OPEN_ACTION_ID = "banto_form_open";
export const FORM_SUBMIT_CALLBACK_ID = "banto_form_submit";
export const FORM_LAUNCHER_BLOCK_ID = "banto_form_launcher";

// Marker on its own final line; server/form ids are restricted to a safe charset.
const FORM_MARKER_RE = /(?:^|\n)\s*\[\[\s*form\s*[:：]\s*([A-Za-z0-9_.-]+)\s*\/\s*([A-Za-z0-9_.-]+)\s*\]\]\s*$/;

export interface ParsedFormMarker {
  body: string;
  server: string;
  form: string;
}

/** Parse a trailing [[form: server/form]] marker. Body must be non-empty. */
export function parseFormMarker(text: string): ParsedFormMarker | null {
  if (!text) return null;
  const m = text.match(FORM_MARKER_RE);
  if (!m) return null;
  const body = text.slice(0, m.index ?? 0).trimEnd();
  if (!body) return null;
  return { body, server: m[1], form: m[2] };
}

/** Value carried by the launcher button (and the "reopen" button after an error). */
export interface FormLaunchRef {
  s: string; // mcp server
  f: string; // form id
  d?: string; // draft id (prefill from a previous failed submit)
}

export function buildFormLauncherBlocks(ref: FormLaunchRef, label = "フォームを開く"): unknown[] {
  return [
    {
      type: "actions",
      block_id: FORM_LAUNCHER_BLOCK_ID,
      elements: [
        {
          type: "button",
          action_id: FORM_OPEN_ACTION_ID,
          text: { type: "plain_text", text: label, emoji: true },
          style: "primary",
          value: JSON.stringify(ref),
        },
      ],
    },
  ];
}

export function parseLaunchRef(value: string): FormLaunchRef | null {
  try {
    const v = JSON.parse(value) as FormLaunchRef;
    if (typeof v?.s !== "string" || typeof v?.f !== "string") return null;
    if (!/^[A-Za-z0-9_.-]+$/.test(v.s) || !/^[A-Za-z0-9_.-]+$/.test(v.f)) return null;
    if (v.d !== undefined && (typeof v.d !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(v.d))) return null;
    return v;
  } catch {
    return null;
  }
}

/* ------------------------------ spec ------------------------------ */

export type FormFieldSpec =
  | { id: string; label: string; type: "text" | "textarea"; required: boolean; initial?: string; placeholder?: string; hint?: string }
  | { id: string; label: string; type: "select"; required: boolean; options: string[]; initial?: string; hint?: string }
  | { id: string; label: string; type: "date"; required: boolean; initial?: string; hint?: string };

export interface FormSpec {
  form: string;
  title: string;
  submitLabel: string;
  submitTool: string;
  fields: FormFieldSpec[];
}

const ID_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse + validate a get_form result. The 職人 may instead return
 * `{ "error": "…" }` (e.g. the user lacks permission) — surfaced as `error`.
 */
export function parseFormSpec(text: string): { spec: FormSpec } | { error: string } {
  let raw: any;
  try {
    raw = JSON.parse(text);
  } catch {
    return { error: text?.trim() ? text.trim().slice(0, 1500) : "フォーム仕様を取得できませんでした" };
  }
  if (raw && typeof raw.error === "string") return { error: raw.error };
  if (!raw || typeof raw !== "object") return { error: "フォーム仕様が不正です" };
  const { form, title, submitLabel, submitTool, fields } = raw;
  if (typeof form !== "string" || typeof title !== "string" || typeof submitTool !== "string" || !ID_RE.test(submitTool)) {
    return { error: "フォーム仕様が不正です（form/title/submitTool）" };
  }
  if (!Array.isArray(fields) || fields.length === 0 || fields.length > 50) {
    return { error: "フォーム仕様が不正です（fields）" };
  }
  const seen = new Set<string>();
  for (const f of fields) {
    if (!f || typeof f.id !== "string" || !ID_RE.test(f.id) || seen.has(f.id) || typeof f.label !== "string") {
      return { error: "フォーム仕様が不正です（field id/label）" };
    }
    seen.add(f.id);
    if (!["text", "textarea", "select", "date"].includes(f.type)) return { error: `未対応の項目タイプ: ${f.type}` };
    if (f.type === "select") {
      if (!Array.isArray(f.options) || f.options.length === 0 || f.options.length > 100 || !f.options.every((o: unknown) => typeof o === "string" && o.length > 0)) {
        return { error: `選択肢が不正です: ${f.id}` };
      }
    }
  }
  return {
    spec: {
      form,
      title,
      submitLabel: typeof submitLabel === "string" && submitLabel ? submitLabel : "送信",
      submitTool,
      fields: fields as FormFieldSpec[],
    },
  };
}

/* ------------------------------ modal ------------------------------ */

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const pt = (text: string, n = 150) => ({ type: "plain_text", text: clip(text, n), emoji: true });

/** Metadata round-tripped through the modal (Slack limit: 3000 chars). */
export interface FormMeta {
  s: string; // mcp server
  f: string; // form id
  t: string; // submit tool
  c: string; // channel to post the result in
  th?: string; // thread ts
}

/** Minimal "loading" view used to grab the trigger_id within Slack's 3s window. */
export function buildLoadingView(): Record<string, unknown> {
  return {
    type: "modal",
    title: pt("読み込み中", 24),
    close: pt("閉じる", 24),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: "フォームを準備しています…" } }],
  };
}

export function buildErrorView(message: string): Record<string, unknown> {
  return {
    type: "modal",
    title: pt("フォームを開けません", 24),
    close: pt("閉じる", 24),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: clip(message, 2900) } }],
  };
}

/** Render a spec (+ optional prefill) as a Block Kit modal view. */
export function buildFormView(
  spec: FormSpec,
  meta: FormMeta,
  prefill: Record<string, string> = {},
): Record<string, unknown> {
  const blocks = spec.fields.map((f) => {
    const initial = prefill[f.id] ?? f.initial;
    let element: Record<string, unknown>;
    if (f.type === "select") {
      const opts = f.options.map((o) => ({ text: pt(o, 75), value: clip(o, 150) }));
      element = { type: "static_select", action_id: f.id, options: opts };
      const hit = initial !== undefined ? opts.find((o) => o.value === initial) : undefined;
      if (hit) element.initial_option = hit;
    } else if (f.type === "date") {
      element = { type: "datepicker", action_id: f.id };
      if (initial && DATE_RE.test(initial)) element.initial_date = initial;
    } else {
      element = { type: "plain_text_input", action_id: f.id, multiline: f.type === "textarea" };
      if (initial) element.initial_value = clip(initial, 3000);
      if ("placeholder" in f && f.placeholder) element.placeholder = pt(f.placeholder, 150);
    }
    const block: Record<string, unknown> = {
      type: "input",
      block_id: f.id,
      label: pt(f.label, 2000),
      optional: !f.required,
      element,
    };
    if (f.hint) block.hint = pt(f.hint, 2000);
    return block;
  });
  return {
    type: "modal",
    callback_id: FORM_SUBMIT_CALLBACK_ID,
    private_metadata: JSON.stringify(meta),
    title: pt(spec.title, 24),
    submit: pt(spec.submitLabel, 24),
    close: pt("キャンセル", 24),
    blocks,
  };
}

/** Extract `{fieldId: value}` from view.state.values. Empty optional fields are omitted. */
export function extractFormValues(stateValues: Record<string, Record<string, any>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [blockId, actions] of Object.entries(stateValues ?? {})) {
    const a = actions?.[blockId] ?? Object.values(actions ?? {})[0];
    if (!a) continue;
    let v: string | undefined;
    if (a.type === "static_select") v = a.selected_option?.value;
    else if (a.type === "datepicker") v = a.selected_date ?? undefined;
    else if (a.type === "plain_text_input") v = a.value ?? undefined;
    if (typeof v === "string" && v.trim() !== "") out[blockId] = v;
  }
  return out;
}

export function parseFormMeta(s: string | undefined): FormMeta | null {
  try {
    const m = JSON.parse(s ?? "") as FormMeta;
    if (!m || !ID_RE.test(m.s) || !ID_RE.test(m.f) || !ID_RE.test(m.t) || typeof m.c !== "string") return null;
    return m;
  } catch {
    return null;
  }
}

/** Human-readable echo of what was submitted (posted with the result). */
export function summarizeSubmission(spec: Pick<FormSpec, "fields">, values: Record<string, string>): string {
  return spec.fields
    .filter((f) => values[f.id] !== undefined)
    .map((f) => `• ${f.label}: ${values[f.id].includes("\n") ? "\n" + values[f.id] : values[f.id]}`)
    .join("\n");
}
