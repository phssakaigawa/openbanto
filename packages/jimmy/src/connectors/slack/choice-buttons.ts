/**
 * Confirmation-choice buttons for routine questions.
 *
 * Contract with the engine: when the assistant asks a routine confirmation
 * question whose answer is one of a few fixed choices, it appends a marker as
 * the LAST line of its reply:
 *
 *     [[choices: 続けて|スキップ|中止]]
 *
 * The marker is plain text on purpose — engines only emit text, and a
 * connector that doesn't understand it degrades to a readable line (the user
 * can still type the answer). The Slack connector strips the marker and posts
 * an interactive buttons message instead; a button press is injected back
 * into the session as that user's reply. The prompt-side instruction lives in
 * sessions/context.ts and is only issued to Slack-source sessions, so other
 * connectors (Rocket.Chat etc.) keep today's behavior.
 */

export const CHOICE_ACTION_ID_PREFIX = "banto_choice_";
export const CHOICE_ACTION_ID_PATTERN = /^banto_choice_\d+$/;
export const CHOICE_BLOCK_ID = "banto_choices";

/** Slack action button text display limit is 75 chars; keep labels well under. */
const MAX_CHOICE_LABEL_CHARS = 40;
const MAX_CHOICES = 5;

// Marker on its own final line. Accepts ASCII "|" and full-width "｜"
// separators and optional whitespace; label list must be non-empty.
const CHOICE_MARKER_RE = /(?:^|\n)\s*\[\[\s*choices\s*[:：]\s*([^\]\n]+?)\s*\]\]\s*$/;

export interface ParsedChoices {
  /** Reply text with the marker line removed (trailing whitespace trimmed). */
  body: string;
  /** 2..5 de-duplicated, length-capped button labels in order. */
  choices: string[];
}

/**
 * Extract a trailing choices marker from a reply. Returns null when there is
 * no marker or it yields fewer than 2 usable choices (a one-choice "question"
 * is a statement — post it as plain text).
 */
export function parseChoiceMarker(text: string): ParsedChoices | null {
  if (!text) return null;
  const m = text.match(CHOICE_MARKER_RE);
  if (!m) return null;
  const seen = new Set<string>();
  const choices: string[] = [];
  for (const raw of m[1].split(/[|｜]/)) {
    const label = raw.trim().slice(0, MAX_CHOICE_LABEL_CHARS);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    choices.push(label);
    if (choices.length >= MAX_CHOICES) break;
  }
  if (choices.length < 2) return null;
  const body = text.slice(0, m.index ?? 0).trimEnd();
  if (!body) return null;
  return { body, choices };
}

/** Blocks for the buttons message (posted right after the question text). */
export function buildChoiceBlocks(choices: string[]): unknown[] {
  return [
    {
      type: "actions",
      block_id: CHOICE_BLOCK_ID,
      elements: choices.map((label, i) => ({
        type: "button",
        action_id: `${CHOICE_ACTION_ID_PREFIX}${i}`,
        text: { type: "plain_text", text: label, emoji: true },
        value: label,
      })),
    },
  ];
}

/**
 * Replacement blocks after a press: buttons removed (double-press prevention)
 * and the outcome shown, attributed to the pressing user.
 */
export function buildChosenBlocks(chosenLabel: string, userId: string): { blocks: unknown[]; text: string } {
  const text = `✅ <@${userId}> が「${chosenLabel}」を選択しました`;
  return {
    blocks: [
      {
        type: "context",
        block_id: CHOICE_BLOCK_ID,
        elements: [{ type: "mrkdwn", text }],
      },
    ],
    text,
  };
}

/** What the press handler needs from the gateway to run a bound 職人 tool. */
export interface ChoiceActionCaller {
  call(
    server: string,
    tool: string,
    args: Record<string, unknown>,
    identity: { userId: string; connector: string; channel: string; thread?: string; via?: string },
  ): Promise<{ ok: boolean; text: string }>;
}

export type ChoiceActionOutcome =
  /** Tool succeeded: post `text` to the thread; the label is NOT handed to the engine. */
  | { kind: "done"; text: string }
  /** Tool failed: hand `injectText` (label + failure note) to the engine as usual so it can follow up. */
  | { kind: "failed"; injectText: string };

/**
 * Run the 職人 tool bound to a pressed confirmation button
 * (mcp.custom.<server>.choiceActions). This makes e.g. 「この内容で起票」
 * deterministic: the engine only ever relays the label, and an LLM that
 * re-issues the preview instead of confirming loops forever.
 *
 * The tool gets no arguments — the pressing user's identity and the
 * conversation's channel/thread (the same values an engine turn in that
 * thread sends) are the only inputs, so it can only act on what that user
 * already set up in that conversation.
 */
export async function runChoiceAction(
  caller: ChoiceActionCaller,
  action: { server: string; tool: string },
  label: string,
  identity: { userId: string; connector: string; channel: string; thread?: string },
): Promise<ChoiceActionOutcome> {
  let res: { ok: boolean; text: string };
  try {
    res = await caller.call(action.server, action.tool, {}, { ...identity, via: "choice" });
  } catch (e) {
    res = { ok: false, text: e instanceof Error ? e.message : String(e) };
  }
  if (res.ok && res.text.trim()) return { kind: "done", text: res.text.trim() };
  const why = res.text.trim().slice(0, 500) || "応答なし";
  return {
    kind: "failed",
    injectText: `${label}\n\n（システム記録: このボタン押下で ${action.server} の ${action.tool} を直接実行しましたが失敗しました: ${why}）`,
  };
}
