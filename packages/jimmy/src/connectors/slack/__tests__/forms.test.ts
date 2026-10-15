import { describe, it, expect } from "vitest";
import {
  FORM_OPEN_ACTION_ID,
  FORM_SUBMIT_CALLBACK_ID,
  buildFormLauncherBlocks,
  buildFormView,
  extractFormValues,
  parseFormMarker,
  parseFormMeta,
  parseFormSpec,
  parseLaunchRef,
  summarizeSubmission,
} from "../forms.js";
import { findChoiceAction, isFormAllowed } from "../../../mcp/direct-call.js";

const spec = {
  form: "work_request",
  title: "作業依頼",
  submitLabel: "起票",
  submitTool: "create_work_request",
  fields: [
    { id: "subject", label: "件名", type: "text", required: true, placeholder: "例" },
    { id: "site", label: "作業拠点", type: "select", required: true, options: ["Site-A", "Site-B", "a", "b", "c", "d", "e"] },
    { id: "device", label: "機器", type: "text", required: false, hint: "空欄可" },
    { id: "date", label: "希望日", type: "date", required: true, initial: "2026-10-12" },
    { id: "priority", label: "緊急度", type: "select", required: true, options: ["低め", "通常"], initial: "通常" },
    { id: "work", label: "作業内容", type: "textarea", required: true },
  ],
};

describe("parseFormMarker", () => {
  it("parses a trailing marker and strips it", () => {
    expect(parseFormMarker("フォームから依頼してください\n[[form: tickets/work_request]]")).toEqual({
      body: "フォームから依頼してください",
      server: "tickets",
      form: "work_request",
    });
  });
  it("accepts full-width colon and spacing", () => {
    expect(parseFormMarker("本文\n  [[ form：tickets / work_request ]]  ")?.form).toBe("work_request");
  });
  it("rejects marker not on the last line, without body, or with unsafe ids", () => {
    expect(parseFormMarker("[[form: tickets/work_request]]\n続き")).toBeNull();
    expect(parseFormMarker("[[form: tickets/work_request]]")).toBeNull();
    expect(parseFormMarker("本文\n[[form: red mine/x]]")).toBeNull();
    expect(parseFormMarker("本文\n[[form: ../etc/x]]")).toBeNull();
  });
});

describe("launcher", () => {
  it("round-trips the ref through the button value", () => {
    const blocks = buildFormLauncherBlocks({ s: "tickets", f: "work_request", d: "0f6e-12" }) as any[];
    const btn = blocks[0].elements[0];
    expect(btn.action_id).toBe(FORM_OPEN_ACTION_ID);
    expect(parseLaunchRef(btn.value)).toEqual({ s: "tickets", f: "work_request", d: "0f6e-12" });
  });
  it("rejects tampered values", () => {
    expect(parseLaunchRef("not json")).toBeNull();
    expect(parseLaunchRef(JSON.stringify({ s: "a b", f: "x" }))).toBeNull();
    expect(parseLaunchRef(JSON.stringify({ s: "a", f: "x", d: "../../x" }))).toBeNull();
  });
});

describe("parseFormSpec", () => {
  it("accepts a valid spec", () => {
    const r = parseFormSpec(JSON.stringify(spec));
    expect("spec" in r && r.spec.submitTool).toBe("create_work_request");
  });
  it("surfaces a 職人 error object as error", () => {
    expect(parseFormSpec(JSON.stringify({ error: "権限がありません" }))).toEqual({ error: "権限がありません" });
  });
  it("treats non-JSON text as an error message", () => {
    expect(parseFormSpec("Backend に接続できませんでした")).toEqual({ error: "Backend に接続できませんでした" });
  });
  it("rejects bad shapes", () => {
    expect("error" in parseFormSpec(JSON.stringify({ ...spec, submitTool: "x y" }))).toBe(true);
    expect("error" in parseFormSpec(JSON.stringify({ ...spec, fields: [] }))).toBe(true);
    expect("error" in parseFormSpec(JSON.stringify({ ...spec, fields: [{ id: "a", label: "A", type: "file", required: true }] }))).toBe(true);
    expect("error" in parseFormSpec(JSON.stringify({ ...spec, fields: [spec.fields[0], spec.fields[0]] }))).toBe(true);
    expect("error" in parseFormSpec(JSON.stringify({ ...spec, fields: [{ id: "s", label: "S", type: "select", required: true, options: [] }] }))).toBe(true);
  });
});

describe("buildFormView", () => {
  const meta = { s: "tickets", f: "work_request", t: "create_work_request", c: "C1", th: "1.2" };
  it("renders selects (>5 options), datepicker, textarea, optional and hint", () => {
    const v = buildFormView(spec as any, meta) as any;
    expect(v.callback_id).toBe(FORM_SUBMIT_CALLBACK_ID);
    expect(parseFormMeta(v.private_metadata)).toEqual(meta);
    const byId = Object.fromEntries(v.blocks.map((b: any) => [b.block_id, b]));
    expect(byId.site.element.type).toBe("static_select");
    expect(byId.site.element.options).toHaveLength(7);
    expect(byId.date.element).toEqual({ type: "datepicker", action_id: "date", initial_date: "2026-10-12" });
    expect(byId.priority.element.initial_option.value).toBe("通常");
    expect(byId.work.element.multiline).toBe(true);
    expect(byId.device.optional).toBe(true);
    expect(byId.device.hint.text).toBe("空欄可");
    expect(byId.subject.optional).toBe(false);
    expect(v.title.text.length).toBeLessThanOrEqual(24);
  });
  it("prefill overrides spec initial; unknown select values are ignored", () => {
    const v = buildFormView(spec as any, meta, { subject: "前回の件名", site: "存在しない", date: "2026-10-20" }) as any;
    const byId = Object.fromEntries(v.blocks.map((b: any) => [b.block_id, b]));
    expect(byId.subject.element.initial_value).toBe("前回の件名");
    expect(byId.site.element.initial_option).toBeUndefined();
    expect(byId.date.element.initial_date).toBe("2026-10-20");
  });
});

describe("extractFormValues / summarizeSubmission", () => {
  const state = {
    subject: { subject: { type: "plain_text_input", value: "件名A" } },
    site: { site: { type: "static_select", selected_option: { value: "Site-A" } } },
    device: { device: { type: "plain_text_input", value: null } },
    date: { date: { type: "datepicker", selected_date: "2026-10-13" } },
    work: { work: { type: "plain_text_input", value: "1行目\n2行目" } },
  };
  it("extracts values verbatim and drops empty optionals", () => {
    expect(extractFormValues(state)).toEqual({ subject: "件名A", site: "Site-A", date: "2026-10-13", work: "1行目\n2行目" });
  });
  it("echoes submitted values with labels in spec order", () => {
    const text = summarizeSubmission(spec as any, extractFormValues(state));
    expect(text.split("\n")[0]).toBe("• 件名: 件名A");
    expect(text).toContain("• 希望日: 2026-10-13");
    expect(text).not.toContain("機器");
  });
});

describe("parseFormMeta", () => {
  it("rejects tampered metadata", () => {
    expect(parseFormMeta("{}")).toBeNull();
    expect(parseFormMeta(JSON.stringify({ s: "r", f: "f", t: "a b", c: "C" }))).toBeNull();
    expect(parseFormMeta(undefined)).toBeNull();
  });
});

describe("isFormAllowed", () => {
  const mcp = { custom: { tickets: { url: "https://x/mcp", forms: ["work_request"] }, netbox: { url: "https://y/mcp" }, off: { url: "z", forms: ["a"], enabled: false } } } as any;
  it("is opt-in per server and form", () => {
    expect(isFormAllowed(mcp, "tickets", "work_request")).toBe(true);
    expect(isFormAllowed(mcp, "tickets", "other")).toBe(false);
    expect(isFormAllowed(mcp, "netbox", "work_request")).toBe(false);
    expect(isFormAllowed(mcp, "off", "a")).toBe(false);
    expect(isFormAllowed(mcp, "nope", "a")).toBe(false);
    expect(isFormAllowed(undefined, "tickets", "work_request")).toBe(false);
  });
});

describe("findChoiceAction", () => {
  const mcp = {
    custom: {
      redmine: { url: "https://x/mcp", choiceActions: { "この内容で起票": "confirm_dc_request", bad: "rm -rf /" } },
      netbox: { url: "https://y/mcp" },
      off: { url: "z", choiceActions: { 実行: "run" }, enabled: false },
    },
  } as any;
  it("is opt-in per server and label", () => {
    expect(findChoiceAction(mcp, "この内容で起票")).toEqual({ server: "redmine", tool: "confirm_dc_request" });
    expect(findChoiceAction(mcp, " この内容で起票 ")).toEqual({ server: "redmine", tool: "confirm_dc_request" });
    expect(findChoiceAction(mcp, "修正する")).toBeNull();
    expect(findChoiceAction(mcp, "実行")).toBeNull();
    expect(findChoiceAction(mcp, "bad")).toBeNull();
    expect(findChoiceAction(mcp, "")).toBeNull();
    expect(findChoiceAction(undefined, "この内容で起票")).toBeNull();
  });
  it("is never handed to engines", async () => {
    const { resolveMcpServers } = await import("../../../mcp/resolver.js");
    const m = { browser: { enabled: false }, gateway: { enabled: false }, knowledge: { enabled: false }, custom: { redmine: { type: "http", url: "https://x/mcp", choiceActions: { a: "b" }, forms: ["f"] } } } as any;
    const cfg = resolveMcpServers(m, undefined, { userId: "U1" }).mcpServers.redmine as any;
    expect(cfg.choiceActions).toBeUndefined();
    expect(cfg.forms).toBeUndefined();
  });
});

describe("X-Banto-Via header", () => {
  it("is stamped only when via is set (form calls), never for plain engine turns", async () => {
    const { resolveMcpServers } = await import("../../../mcp/resolver.js");
    const mcp = { browser: { enabled: false }, gateway: { enabled: false }, knowledge: { enabled: false }, custom: { tickets: { type: "http", url: "https://x/mcp" } } } as any;
    const turn = resolveMcpServers(mcp, undefined, { userId: "U1" }).mcpServers.tickets as any;
    expect(turn.headers["X-Banto-Via"]).toBeUndefined();
    const form = resolveMcpServers(mcp, undefined, { userId: "U1", via: "form" }).mcpServers.tickets as any;
    expect(form.headers["X-Banto-Via"]).toBe("form");
  });
});
