import { describe, it, expect } from "vitest";
import {
  parseChoiceMarker,
  buildChoiceBlocks,
  buildChosenBlocks,
  CHOICE_ACTION_ID_PATTERN,
  CHOICE_BLOCK_ID,
} from "../choice-buttons.js";

describe("parseChoiceMarker", () => {
  it("extracts a trailing marker and strips it from the body", () => {
    const text = "📋 確認質問\nこのまま続けて実施しますか？\n[[choices: 続けて|スキップ|中止]]";
    const parsed = parseChoiceMarker(text);
    expect(parsed).not.toBeNull();
    expect(parsed!.body).toBe("📋 確認質問\nこのまま続けて実施しますか？");
    expect(parsed!.choices).toEqual(["続けて", "スキップ", "中止"]);
  });

  it("accepts full-width separators, spacing, and full-width colon", () => {
    const parsed = parseChoiceMarker("質問です\n[[ choices： はい ｜ いいえ ]]");
    expect(parsed!.choices).toEqual(["はい", "いいえ"]);
  });

  it("returns null when there is no marker", () => {
    expect(parseChoiceMarker("ただの返信です")).toBeNull();
    expect(parseChoiceMarker("")).toBeNull();
  });

  it("returns null when the marker is not at the end", () => {
    expect(parseChoiceMarker("[[choices: A|B]]\nあとに本文が続く")).toBeNull();
  });

  it("returns null for fewer than 2 usable choices", () => {
    expect(parseChoiceMarker("質問\n[[choices: 続けて]]")).toBeNull();
    expect(parseChoiceMarker("質問\n[[choices: A|A]]")).toBeNull();
    expect(parseChoiceMarker("質問\n[[choices: | ]]")).toBeNull();
  });

  it("returns null when stripping the marker leaves no body", () => {
    expect(parseChoiceMarker("[[choices: A|B]]")).toBeNull();
  });

  it("dedupes and caps at 5 choices", () => {
    const parsed = parseChoiceMarker("質問\n[[choices: 1|2|2|3|4|5|6|7]]");
    expect(parsed!.choices).toEqual(["1", "2", "3", "4", "5"]);
  });
});

describe("buildChoiceBlocks", () => {
  it("builds one actions block with a button per choice", () => {
    const blocks = buildChoiceBlocks(["続けて", "スキップ"]) as Array<Record<string, unknown>>;
    expect(blocks).toHaveLength(1);
    expect(blocks[0].type).toBe("actions");
    expect(blocks[0].block_id).toBe(CHOICE_BLOCK_ID);
    const elements = blocks[0].elements as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(2);
    expect(elements[0]).toMatchObject({
      type: "button",
      action_id: "banto_choice_0",
      value: "続けて",
      text: { type: "plain_text", text: "続けて" },
    });
    expect(elements[1]).toMatchObject({ action_id: "banto_choice_1", value: "スキップ" });
    for (const el of elements) {
      expect(String(el.action_id)).toMatch(CHOICE_ACTION_ID_PATTERN);
    }
  });
});

describe("buildChosenBlocks", () => {
  it("replaces the buttons with an attributed outcome line", () => {
    const { blocks, text } = buildChosenBlocks("続けて", "U123");
    expect(text).toContain("<@U123>");
    expect(text).toContain("「続けて」");
    const b = blocks as Array<Record<string, unknown>>;
    expect(b).toHaveLength(1);
    expect(b[0].type).toBe("context");
    // No interactive elements remain — double presses have nothing to hit.
    expect(JSON.stringify(blocks)).not.toContain("button");
  });
});
