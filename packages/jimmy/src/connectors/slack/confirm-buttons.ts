/**
 * Buttons for a software-rendered confirmation (shared/confirm-block.ts):
 * an approve button that carries the 職人's confirm token, and 修正する / 中止
 * as ordinary choice buttons (their press goes to the engine like any choice).
 */
import { CHOICE_ACTION_ID_PREFIX, CHOICE_BLOCK_ID } from "./choice-buttons.js";
import { CONFIRM_OTHER_CHOICES } from "../../shared/confirm-block.js";

export const CONFIRM_APPROVE_ACTION_ID = "banto_confirm_approve";

export function buildConfirmBlocks(c: { server: string; tool: string; token: string; label: string }): unknown[] {
  return [
    {
      type: "actions",
      block_id: CHOICE_BLOCK_ID,
      elements: [
        {
          type: "button",
          action_id: CONFIRM_APPROVE_ACTION_ID,
          style: "primary",
          text: { type: "plain_text", text: c.label, emoji: true },
          value: `${c.server}|${c.tool}|${c.token}`,
        },
        ...CONFIRM_OTHER_CHOICES.map((label, i) => ({
          type: "button",
          // Index offset keeps ids distinct from the approve button; the choice
          // handler matches banto_choice_<n> and injects the label.
          action_id: `${CHOICE_ACTION_ID_PREFIX}${i + 1}`,
          text: { type: "plain_text", text: label, emoji: true },
          value: label,
        })),
      ],
    },
  ];
}
