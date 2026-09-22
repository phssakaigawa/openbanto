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
