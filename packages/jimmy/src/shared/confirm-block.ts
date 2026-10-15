/**
 * Software-rendered confirmations for 職人 operations that need the user's
 * explicit approval (e.g. filing a DC work request).
 *
 * Problem this solves: when the engine (LLM) is asked to relay a preview and
 * collect an approval, it can rewrite the preview, show another one, or show
 * none at all — and the user then "approves" content they never saw.
 *
 * Contract:
 *  1. A 職人 preview tool returns a block in its result:
 *
 *       [[banto-confirm token=<token> confirm=<confirm tool>]]
 *       <exactly what will be executed, in Markdown>
 *       [[/banto-confirm]]
 *
 *  2. The engine records the LAST such block of the turn
 *     (EngineResult.confirmation). The session manager then replaces the
 *     engine's reply text with the block body verbatim plus a trailing
 *     `[[confirm: <server>|<tool>|<token>]]` marker. Any marker of that kind
 *     the engine itself wrote is stripped first, so only tool output can bind
 *     a button to a token.
 *  3. The Slack connector turns the marker into an approve button carrying the
 *     token, plus 修正する / 中止 choice buttons that go back to the engine.
 *     Pressing approve calls `<server>.<tool>({ confirmToken })` directly as
 *     the presser (X-Banto-Via: confirm) — the engine is not involved, so the
 *     approved content is exactly the content that was displayed.
 *  4. The 職人 should accept its confirm tool only with via=confirm.
 */

export interface ConfirmationBlock {
  /** MCP server name (the part before "__" in the engine's tool name). */
  server: string;
  /** Tool to call with { confirmToken } when the user approves. */
  tool: string;
  token: string;
  /** Markdown shown to the user verbatim. */
  display: string;
}

export const CONFIRM_APPROVE_LABEL = "この内容で確定";
export const CONFIRM_OTHER_CHOICES = ["修正する", "中止"];

const BLOCK_RE =
  /\[\[banto-confirm token=([A-Za-z0-9_-]{4,64}) confirm=([A-Za-z0-9_.-]{1,64})(?: label=([^\]\n]{1,30}))?\]\]\r?\n([\s\S]*?)\r?\n\[\[\/banto-confirm\]\]/g;
const SERVER_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** The last confirmation block in a tool result, or null. `toolName` is the engine-side name ("<server>__<tool>"). */
export function extractConfirmation(toolName: string, toolResult: string): (ConfirmationBlock & { label?: string }) | null {
  const sep = toolName.indexOf("__");
  if (sep <= 0) return null;
  const server = toolName.slice(0, sep);
  if (!SERVER_RE.test(server)) return null;
  let last: (ConfirmationBlock & { label?: string }) | null = null;
  for (const m of toolResult.matchAll(BLOCK_RE)) {
    const display = m[4].trim();
    if (!display) continue;
    last = { server, tool: m[2], token: m[1], display, ...(m[3] ? { label: m[3].trim() } : {}) };
  }
  return last;
}

const CONFIRM_MARKER_RE = /\[\[\s*confirm\s*[:：][^\]\n]*\]\]/g;

/** Remove confirm markers the engine may have written itself (they must only come from tool output). */
export function stripConfirmMarkers(text: string): string {
  return text.replace(CONFIRM_MARKER_RE, "").trimEnd();
}

/**
 * Reply text that replaces the engine's text for a turn that produced a
 * confirmation. With `interactive` (Slack) a trailing marker becomes the
 * buttons; otherwise the user is told to use a connector that has them.
 */
export function renderConfirmationReply(c: ConfirmationBlock & { label?: string }, interactive: boolean): string {
  const body = c.display.trim();
  if (!interactive) {
    return `${body}\n\n（確定は Slack の「${c.label ?? CONFIRM_APPROVE_LABEL}」ボタンからのみ行えます）`;
  }
  return `${body}\n[[confirm: ${c.server}|${c.tool}|${c.token}${c.label ? `|${c.label}` : ""}]]`;
}

const TRAILING_CONFIRM_RE =
  /(?:^|\n)\s*\[\[\s*confirm\s*[:：]\s*([A-Za-z0-9_.-]{1,64})\|([A-Za-z0-9_.-]{1,64})\|([A-Za-z0-9_-]{4,64})(?:\|([^\]\n|]{1,30}))?\s*\]\]\s*$/;

/** Parse the trailing confirm marker (Slack connector side). */
export function parseConfirmMarker(
  text: string,
): { body: string; server: string; tool: string; token: string; label: string } | null {
  const m = TRAILING_CONFIRM_RE.exec(text);
  if (!m) return null;
  return {
    body: text.slice(0, m.index).trimEnd(),
    server: m[1],
    tool: m[2],
    token: m[3],
    label: (m[4] ?? "").trim() || CONFIRM_APPROVE_LABEL,
  };
}

/**
 * Apply the contract to an engine result in place: strip engine-written
 * confirm markers, and when a tool produced a confirmation (and the turn did
 * not error) replace the reply with the verbatim preview. Returns true when
 * the reply was replaced. Used by every path that delivers engine output.
 */
export function applyConfirmation(
  result: { result?: string; turns?: string[]; error?: string; confirmation?: ConfirmationBlock & { label?: string } },
  interactive: boolean,
): boolean {
  if (result.result) result.result = stripConfirmMarkers(result.result);
  if (result.turns) result.turns = result.turns.map((t) => (typeof t === "string" ? stripConfirmMarkers(t) : t));
  if (!result.confirmation || result.error) return false;
  const text = renderConfirmationReply(result.confirmation, interactive);
  result.result = text;
  if (result.turns && result.turns.length > 0) result.turns = [...result.turns.slice(0, -1), text];
  return true;
}
