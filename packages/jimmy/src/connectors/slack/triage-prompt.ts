/**
 * Pure prompt builder for Slack air-reading triage.
 *
 * The triage LLM is given the incoming message plus light context and
 * must respond with a single JSON decision: silent / react / reply.
 *
 * Kept pure (no I/O) so it can be snapshot-tested without spawning
 * a subprocess.
 */

export interface TriagePromptInput {
  /** Display name of the bot itself (e.g. "Banto", "Jinn") */
  botName: string;
  /** Short persona description — what this bot is good at */
  persona?: string;
  /** Name of the operator who owns this Jinn instance */
  operatorName?: string;
  /** Channel type: "im" (DM), "channel", "group", "mpim" etc. */
  channelType: string;
  /** Human-readable channel identifier (e.g. "#general" or "DM") */
  channelDescription: string;
  /** Display name of the speaker */
  speakerName: string;
  /** Whether the speaker is the operator of this Jinn */
  speakerIsOperator: boolean;
  /** Whether the bot was explicitly @-mentioned in the message */
  wasMentioned: boolean;
  /** Recent messages in the thread for context — oldest first */
  recentThread: Array<{ speaker: string; text: string }>;
  /** The message being triaged */
  messageText: string;
  /** True when this is an established 1:1 conversation with the bot (DM-equivalent):
   *  the message IS implicitly addressed to the bot, so the decision space is
   *  react-vs-reply — "silent" (ghosting) is not acceptable here. */
  dmEquivalent?: boolean;
}

export interface TriageDecision {
  action: "silent" | "react" | "reply";
  emoji?: string;
  reason?: string;
}

const MAX_MESSAGE_CHARS = 2000;
const MAX_THREAD_ITEM_CHARS = 300;
const MAX_THREAD_ITEMS = 10;

/** Upper bound (code points) for a message to qualify as a short-ack candidate. */
export const SHORT_ACK_MAX_CHARS = 30;

/**
 * Cheap lexical pre-filter for the DM-equivalent short-ack exception: does this
 * message LOOK like it could be a bare acknowledgment ("ありがとう", "了解",
 * "OK") rather than a request? Candidates are sent through LLM triage (which
 * may still answer "reply"); non-candidates skip triage and get a full reply,
 * exactly as before. Deliberately conservative — a question mark, link,
 * mention, or slash command disqualifies, because those always deserve a real
 * response and shouldn't even risk a react-only outcome.
 */
export function isShortAckCandidate(text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) return false;
  if ([...t].length > SHORT_ACK_MAX_CHARS) return false;
  if (/[?？]/.test(t)) return false;
  if (/https?:\/\//.test(t)) return false;
  if (/<[@#!]/.test(t)) return false; // user/channel/special mentions
  if (t.startsWith("/")) return false; // control slash commands
  return true;
}

export function buildTriagePrompt(input: TriagePromptInput): string {
  const {
    botName,
    persona,
    operatorName,
    channelType,
    channelDescription,
    speakerName,
    speakerIsOperator,
    wasMentioned,
    recentThread,
    messageText,
    dmEquivalent,
  } = input;

  const personaBlock = persona?.trim()
    ? persona.trim()
    : `${botName} is a helpful AI assistant embedded in Slack.`;

  const operatorBlock = operatorName?.trim()
    ? `The operator (who runs this Jinn instance) is **${operatorName.trim()}**.`
    : `No operator has been configured.`;

  const speakerRole = speakerIsOperator
    ? "the operator of this Jinn instance"
    : "NOT the operator — a different person";

  const threadItems = recentThread
    .slice(-MAX_THREAD_ITEMS)
    .map((m) => {
      const text = (m.text ?? "").trim().slice(0, MAX_THREAD_ITEM_CHARS);
      return `- [${m.speaker}] ${text}`;
    })
    .join("\n");
  const threadBlock = threadItems.length > 0 ? threadItems : "(no prior messages in this thread)";

  const truncatedMessage = messageText.length > MAX_MESSAGE_CHARS
    ? messageText.slice(0, MAX_MESSAGE_CHARS) + "\n…(truncated)"
    : messageText;

  return `You are a TRIAGE classifier for ${botName}, an AI assistant on Slack.
You decide whether ${botName} should respond to a specific incoming message.

# Output format (STRICT)
Output EXACTLY ONE JSON object, nothing else. No markdown, no prose, no code fences.
Schema:
  {"action": "silent" | "react" | "reply", "emoji": "<slack-emoji-name>", "reason": "<=30 chars"}

- "silent" — do absolutely nothing. No reply, no reaction. The bot stays invisible.
- "react"  — add ONE emoji reaction and nothing else (no text reply). Choose a Slack emoji name without colons (e.g. "eyes", "thumbsup", "pray", "ok_hand", "dog", "white_check_mark").
- "reply"  — ${botName} should write a real text response.

"emoji" is required only when action = "react". Omit or leave empty otherwise.

# About ${botName}
${personaBlock}

# Operator
${operatorBlock}

# Current context
- Channel: ${channelDescription} (type: ${channelType})
- Speaker: ${speakerName} — ${speakerRole}
- Was ${botName} explicitly @-mentioned in this message? ${wasMentioned ? "YES" : "no"}${dmEquivalent ? `
- Established 1:1 conversation: YES — ${botName} has been engaged here and no third party has joined. The message IS implicitly addressed to ${botName}.` : ""}

# Recent thread (for context only — not the message to triage)
${threadBlock}

# The message to triage
"""
${truncatedMessage}
"""

${dmEquivalent ? `# Decision rules (1:1 conversation — the message IS addressed to ${botName}; NEVER choose "silent")
1. If the message is ONLY a short acknowledgment, thanks, or affirmation that CLOSES the exchange
   (e.g. "ありがとう", "thanks", "了解です", "OK", "なるほど", "助かりました", "👍") → "react" with a fitting emoji.
2. ANYTHING else → "reply". This includes questions, instructions, go-aheads and continuations
   ("GO", "続けて", "お願いします", "やって"), a "はい"/"OK" that answers a question ${botName} asked
   (check the recent thread — if ${botName}'s last message asked something or offered to proceed,
   the acknowledgment is a go-ahead → "reply"), corrections, feedback expecting action, or new information.

# Principles (these override the rules when in tension)
- A missed request is far worse than a redundant reply here. When unsure → "reply".
- Choose "react" only when a single emoji FULLY satisfies the message and no action is expected.` : `# Decision rules (apply in order, stop at first match)
1. If the message is a short acknowledgment, thanks, or affirmation directed at ${botName}'s prior reply
   (e.g. "ありがとう", "thanks", "了解", "OK", "なるほど", "👍") → "react" with a fitting emoji.
2. If the message is clearly addressed to ${botName} (called by name, imperative aimed at the bot,
   continuation of a 1:1 exchange) → "reply".
3. If the topic clearly matches ${botName}'s expertise AND ${botName} can contribute concrete,
   wanted value (not just chitchat) → "reply".
4. Otherwise → "silent".

# Principles (these override the rules when in tension)
- Err on the side of SILENCE. Annoying intrusion is far worse than missing a chance to reply.
- Never butt into casual chat between other people. If the conversation is not for you, stay silent.
- Do not reply just to be polite or to say "I see" / "interesting" — add value or stay out.
- If your confidence that ${botName} should speak is below ~60%, choose "silent".
- Prefer "react" over "reply" for pure acknowledgments. A single emoji is often enough.`}

# Output
Produce the JSON object now. Do not explain. Do not wrap in a code block. JSON only.`;
}

/**
 * Parse the triage LLM output into a TriageDecision.
 * Tolerates:
 *   - whitespace / leading/trailing prose
 *   - markdown code fences (```json ... ```)
 *   - emoji written with surrounding colons (":eyes:" → "eyes")
 * Returns null if no valid decision can be extracted.
 */
export function parseTriageDecision(raw: string): TriageDecision | null {
  if (!raw) return null;

  // Strip markdown code fences if present
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : raw;

  // Find the first {...} block
  const jsonMatch = candidate.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;

  const action = obj.action;
  if (action !== "silent" && action !== "react" && action !== "reply") return null;

  const rawEmoji = typeof obj.emoji === "string" ? obj.emoji.trim() : "";
  const emoji = rawEmoji.replace(/^:+|:+$/g, "") || undefined;
  const reason = typeof obj.reason === "string" ? obj.reason.trim().slice(0, 120) : undefined;

  // Action "react" requires an emoji; default to eyes if missing
  if (action === "react" && !emoji) {
    return { action, emoji: "eyes", reason };
  }

  return { action, emoji, reason };
}
