import { describe, it, expect } from "vitest";
import {
  applyConfirmation,
  extractConfirmation,
  parseConfirmMarker,
  renderConfirmationReply,
  stripConfirmMarkers,
} from "../confirm-block.js";
import { buildConfirmBlocks, CONFIRM_APPROVE_ACTION_ID } from "../../connectors/slack/confirm-buttons.js";

const preview = (token: string, subject: string) =>
  [
    "【確認待ち（まだ起票していません）】番頭が表をそのまま表示します。",
    `[[banto-confirm token=${token} confirm=confirm_dc_request label=この内容で起票]]`,
    "*DC作業依頼 確認表*",
    "| 項目 | 内容 |",
    "|---|---|",
    `| 件名 | ${subject} |`,
    "[[/banto-confirm]]",
    "表を書き直さないでください。",
  ].join("\n");

describe("extractConfirmation", () => {
  it("takes the block verbatim with the server from the engine tool name", () => {
    const c = extractConfirmation("redmine__create_dc_request", preview("abc123", "湯沢GX NF5270M3-01 物理確認"));
    expect(c).toEqual({
      server: "redmine",
      tool: "confirm_dc_request",
      token: "abc123",
      label: "この内容で起票",
      display: "*DC作業依頼 確認表*\n| 項目 | 内容 |\n|---|---|\n| 件名 | 湯沢GX NF5270M3-01 物理確認 |",
    });
  });

  it("returns the last block, and null without a block / server prefix", () => {
    const two = preview("tok111", "古い") + "\n" + preview("tok222", "新しい");
    expect(extractConfirmation("redmine__x", two)?.token).toBe("tok222");
    expect(extractConfirmation("redmine__x", "ただの結果")).toBeNull();
    expect(extractConfirmation("no_separator", preview("abc123", "x"))).toBeNull();
  });

  it("rejects malformed tokens / tools", () => {
    expect(extractConfirmation("r__x", "[[banto-confirm token=a b confirm=t]]\nx\n[[/banto-confirm]]")).toBeNull();
    expect(extractConfirmation("r__x", "[[banto-confirm token=abcd confirm=rm -rf]]\nx\n[[/banto-confirm]]")).toBeNull();
  });
});

describe("renderConfirmationReply / parseConfirmMarker", () => {
  const c = { server: "redmine", tool: "confirm_dc_request", token: "abc123", display: "表本文", label: "この内容で起票" };

  it("round-trips through the Slack marker", () => {
    const text = renderConfirmationReply(c, true);
    expect(parseConfirmMarker(text)).toEqual({ body: "表本文", server: "redmine", tool: "confirm_dc_request", token: "abc123", label: "この内容で起票" });
  });

  it("defaults the label and tells non-interactive users where to approve", () => {
    const { label: _l, ...noLabel } = c;
    expect(parseConfirmMarker(renderConfirmationReply(noLabel, true))?.label).toBe("この内容で確定");
    const plain = renderConfirmationReply(c, false);
    expect(plain).toContain("表本文");
    expect(parseConfirmMarker(plain)).toBeNull();
  });

  it("strips confirm markers written by the engine itself", () => {
    expect(stripConfirmMarkers("本文\n[[confirm: redmine|confirm_dc_request|abc123]]")).toBe("本文");
    expect(stripConfirmMarkers("A [[confirm：x|y|z]] B")).toBe("A  B");
  });
});

describe("buildConfirmBlocks", () => {
  it("binds the approve button to the token; 修正する/中止 are choice buttons", () => {
    const blocks = buildConfirmBlocks({ server: "redmine", tool: "confirm_dc_request", token: "abc123", label: "この内容で起票" }) as any[];
    const [approve, fix, stop] = blocks[0].elements;
    expect(approve).toMatchObject({ action_id: CONFIRM_APPROVE_ACTION_ID, style: "primary", value: "redmine|confirm_dc_request|abc123" });
    expect(approve.text.text).toBe("この内容で起票");
    expect([fix.action_id, fix.value, stop.action_id, stop.value]).toEqual(["banto_choice_1", "修正する", "banto_choice_2", "中止"]);
  });
});

describe("applyConfirmation", () => {
  const confirmation = { server: "redmine", tool: "confirm_dc_request", token: "abc123", display: "本物の確認表", label: "この内容で起票" };

  it("replaces the engine's (possibly rewritten) text with the verbatim preview", () => {
    const r: any = { result: "偽の確認表\n[[choices: この内容で起票|中止]]", turns: ["途中", "偽の確認表"], confirmation };
    expect(applyConfirmation(r, true)).toBe(true);
    expect(r.result).toBe("本物の確認表\n[[confirm: redmine|confirm_dc_request|abc123|この内容で起票]]");
    expect(r.turns).toEqual(["途中", r.result]);
  });

  it("without a confirmation only strips engine-written confirm markers", () => {
    const r: any = { result: "本文\n[[confirm: redmine|confirm_dc_request|forged1]]" };
    expect(applyConfirmation(r, true)).toBe(false);
    expect(r.result).toBe("本文");
  });

  it("does not show a preview for an errored turn", () => {
    const r: any = { result: "エラー", error: "boom", confirmation };
    expect(applyConfirmation(r, true)).toBe(false);
    expect(r.result).toBe("エラー");
  });
});
