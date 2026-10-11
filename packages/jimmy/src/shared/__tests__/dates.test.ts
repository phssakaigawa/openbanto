import { describe, it, expect } from "vitest";
import {
  addDays,
  buildDateContext,
  guardDateClaims,
  resolveDateExpression,
  safeTimeZone,
  zonedNow,
} from "../dates.js";

// 2026-10-12 (Mon) 01:30 JST  ==  2026-10-11T16:30Z
const NOW = new Date("2026-10-11T16:30:00Z");
const r = (e: string, now = NOW, tz = "Asia/Tokyo") => resolveDateExpression(e, now, tz)?.date ?? null;

describe("zonedNow / tz", () => {
  it("projects now into the target zone (UTC day differs from JST day)", () => {
    expect(zonedNow(NOW, "Asia/Tokyo")).toMatchObject({ y: 2026, m: 10, d: 12, hh: 1, mi: 30 });
    expect(zonedNow(NOW, "UTC")).toMatchObject({ y: 2026, m: 10, d: 11, hh: 16 });
  });
  it("falls back to Asia/Tokyo for unknown zones", () => {
    expect(safeTimeZone("Not/AZone")).toBe("Asia/Tokyo");
    expect(safeTimeZone(undefined)).toBe("Asia/Tokyo");
  });
  it("addDays crosses month/year/leap boundaries", () => {
    expect(addDays({ y: 2026, m: 12, d: 31 }, 1)).toEqual({ y: 2027, m: 1, d: 1 });
    expect(addDays({ y: 2028, m: 2, d: 28 }, 1)).toEqual({ y: 2028, m: 2, d: 29 });
    expect(addDays({ y: 2027, m: 3, d: 1 }, -1)).toEqual({ y: 2027, m: 2, d: 28 });
  });
});

describe("buildDateContext", () => {
  const ctx = buildDateContext(NOW, "Asia/Tokyo");
  it("states the current date/time with weekday and zone", () => {
    expect(ctx).toContain("現在: 2026-10-12（月） 01:30（Asia/Tokyo）");
  });
  it("includes the relative-day table", () => {
    expect(ctx).toContain("- 昨日: 2026-10-11（日）");
    expect(ctx).toContain("- 明日: 2026-10-13（火）");
    expect(ctx).toContain("- 明後日: 2026-10-14（水）");
  });
  it("weeks run Monday→Sunday", () => {
    expect(ctx).toContain("- 今週（月〜日）: 月 10-12 / 火 10-13 / 水 10-14 / 木 10-15 / 金 10-16 / 土 10-17 / 日 10-18");
    expect(ctx).toContain("- 来週（月〜日）: 月 10-19");
    expect(ctx).toContain("- 先週（月〜日）: 月 10-05");
  });
});

describe("resolveDateExpression", () => {
  it("simple relative words", () => {
    expect(r("今日")).toBe("2026-10-12");
    expect(r("本日")).toBe("2026-10-12");
    expect(r("明日")).toBe("2026-10-13");
    expect(r("あさって")).toBe("2026-10-14");
    expect(r("しあさって")).toBe("2026-10-15");
    expect(r("昨日")).toBe("2026-10-11");
    expect(r("おととい")).toBe("2026-10-10");
  });
  it("N日後 / N週間前 (incl. full-width and kanji numerals)", () => {
    expect(r("3日後")).toBe("2026-10-15");
    expect(r("３日後")).toBe("2026-10-15");
    expect(r("十日後")).toBe("2026-10-22");
    expect(r("2週間前")).toBe("2026-09-28");
  });
  it("week-relative weekdays (Monday-start weeks)", () => {
    expect(r("来週月曜")).toBe("2026-10-19");
    expect(r("来週の金曜日")).toBe("2026-10-23");
    expect(r("今週日曜")).toBe("2026-10-18");
    expect(r("先週水曜")).toBe("2026-10-07");
    expect(r("再来週火曜")).toBe("2026-10-27");
  });
  it("next weekday is strictly after today", () => {
    expect(r("月曜")).toBe("2026-10-19"); // today is Monday → next Monday
    expect(r("次の金曜")).toBe("2026-10-16");
  });
  it("month ends and month-relative days", () => {
    expect(r("今月末")).toBe("2026-10-31");
    expect(r("来月末")).toBe("2026-11-30");
    expect(r("来月10日")).toBe("2026-11-10");
    expect(r("今月末", new Date("2028-02-10T03:00:00Z"))).toBe("2028-02-29");
    expect(r("来月末", new Date("2026-12-05T03:00:00Z"))).toBe("2027-01-31");
  });
  it("explicit and year-less dates", () => {
    expect(r("2026/10/20")).toBe("2026-10-20");
    expect(r("2026年10月20日（火）")).toBe("2026-10-20");
    expect(r("10/20")).toBe("2026-10-20");
    expect(r("1月5日")).toBe("2027-01-05"); // past this year → next year
    expect(resolveDateExpression("1月5日", NOW, "Asia/Tokyo")!.basis).toContain("翌年");
  });
  it("rejects invalid or unknown expressions", () => {
    expect(r("2026-02-30")).toBeNull();
    expect(r("2/30")).toBeNull();
    expect(r("そのうち")).toBeNull();
    expect(r("")).toBeNull();
  });
  it("uses the target zone's 'today' (JST is already Monday while UTC is Sunday)", () => {
    expect(r("今日", NOW, "UTC")).toBe("2026-10-11");
    expect(r("今日", NOW, "Asia/Tokyo")).toBe("2026-10-12");
  });
});

describe("guardDateClaims", () => {
  const g = (t: string) => guardDateClaims(t, NOW, "Asia/Tokyo");
  it("fixes the observed incident (wrong year, correct weekday)", () => {
    const out = g("【※ 本日は 2025-10-12(月) です】");
    expect(out.text.startsWith("【※ 本日は 2026-10-12(月) です】")).toBe(true);
    expect(out.fixes).toEqual([{ label: "本日", wrong: "2025-10-12(月)", correct: "2026-10-12(月)" }]);
    expect(out.text).toContain("※日付を自動補正しました");
  });
  it("fixes 明日 / 昨日 claims and weekday suffixes, keeping the original format", () => {
    expect(g("明日は2025/07/24（木）です").text.split("\n")[0]).toBe("明日は2026/10/13（火）です");
    expect(g("昨日：2026年10月10日").text.split("\n")[0]).toBe("昨日：2026年10月11日");
  });
  it("fixes a correct date paired with a wrong weekday", () => {
    expect(g("今日は 2026-10-12（火）").text.split("\n")[0]).toBe("今日は 2026-10-12（月）");
  });
  it("leaves correct claims and unrelated dates untouched", () => {
    const t = "本日は 2026-10-12（月）です。期限は 2025-12-01、明日 2026-10-13 に対応します。";
    expect(g(t)).toEqual({ text: t, fixes: [] });
    expect(g("希望日: 2025-07-24")).toEqual({ text: "希望日: 2025-07-24", fixes: [] });
  });
});
