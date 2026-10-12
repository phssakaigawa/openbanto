import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toLunar } from "../kyureki.js";
import { parseCaoCsv, buildHolidayData, refreshHolidays, loadHolidayData, holidayStatus, coverageWarning } from "../jp-holidays.js";
import { dayInfo, addBusinessDays, holidaysBetween, shortAnnotation } from "../jp-calendar.js";
import { buildDateContext } from "../dates.js";

// Verified against two independent published calendars (incl. leap months; see PR).
const LUNAR: Array<[string, boolean, number, number, string]> = [
  ["2000-01-01", false, 11, 25, "大安"],
  ["2001-05-23", true, 4, 1, "仏滅"],
  ["2004-03-21", true, 2, 1, "友引"],
  ["2006-08-24", true, 7, 1, "先勝"],
  ["2009-06-23", true, 5, 1, "大安"],
  ["2012-04-21", true, 3, 1, "先負"],
  ["2014-10-24", true, 9, 1, "先負"],
  ["2017-06-24", true, 5, 1, "大安"],
  ["2020-05-23", true, 4, 1, "仏滅"],
  ["2023-01-21", false, 12, 30, "大安"],
  ["2023-03-21", false, 2, 30, "先勝"],
  ["2023-03-22", true, 2, 1, "友引"],
  ["2023-04-19", true, 2, 29, "赤口"],
  ["2023-04-20", false, 3, 1, "先負"],
  ["2025-07-25", true, 6, 1, "赤口"],
  ["2025-08-22", true, 6, 29, "仏滅"],
  ["2025-08-23", false, 7, 1, "先勝"],
  ["2026-01-01", false, 11, 13, "大安"],
  ["2026-02-17", false, 1, 1, "先勝"],
  ["2026-10-12", false, 9, 2, "仏滅"],
  ["2026-10-13", false, 9, 3, "大安"],
  ["2026-12-31", false, 11, 23, "先負"],
  ["2027-01-01", false, 11, 24, "仏滅"],
  ["2028-06-22", false, 5, 30, "仏滅"],
  ["2030-12-31", false, 12, 7, "赤口"],
  ["2033-08-25", false, 8, 1, "友引"],
  ["2033-12-22", true, 11, 1, "大安"],
  ["2034-01-20", false, 12, 1, "赤口"],
  ["2050-12-31", false, 11, 18, "仏滅"],
];

describe("kyureki / rokuyo", () => {
  it.each(LUNAR)("%s → leap=%s %s/%s %s", (ymd, leap, m, d, rk) => {
    const [y, mo, dd] = ymd.split("-").map(Number);
    const q = toLunar(y, mo, dd);
    expect([q.leap, q.month, q.day, q.rokuyo]).toEqual([leap, m, d, rk]);
  });
  it("flags the 2033 problem period as ambiguous", () => {
    expect(toLunar(2033, 12, 22).ambiguous).toBe(true);
    expect(toLunar(2026, 10, 12).ambiguous).toBe(false);
  });
  it("is consistent day to day (day increments by 1 within a month, resets to 1 at new moon)", () => {
    let prev = toLunar(2024, 1, 1);
    for (let t = Date.UTC(2024, 0, 2); t <= Date.UTC(2026, 11, 31); t += 86400000) {
      const x = new Date(t);
      const q = toLunar(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate());
      if (q.day !== 1) expect(q.day).toBe(prev.day + 1);
      else expect([29, 30]).toContain(prev.day);
      prev = q;
    }
  });
});

const CSV = "国民の祝日・休日月日,国民の祝日・休日名称\r\n" +
  Array.from({ length: 520 }, (_, i) => {
    const d = new Date(Date.UTC(2000, 0, 1) + i * 7 * 86400000); // distinct past dates
    return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()},ダミー${i}`;
  }).join("\r\n") +
  "\r\n2026/1/1,元日\r\n2026/9/22,休日\r\n2026/10/12,スポーツの日\r\n2027/11/23,勤労感謝の日\r\n";

describe("jp-holidays", () => {
  it("parses the Cabinet Office CSV (string, UTF-8 bytes or Shift_JIS bytes)", () => {
    expect(parseCaoCsv(new TextEncoder().encode(CSV))["2026-10-12"]).toBe("スポーツの日");
    const h = parseCaoCsv(CSV);
    expect(h["2026-10-12"]).toBe("スポーツの日");
    // "2026/1/1,元日" header-less bytes are not accepted; real file is Shift_JIS — header in SJIS:
    const sjisHeader = Uint8Array.from([0x8d, 0x91, 0x96, 0xaf, 0x82, 0xcc, 0x8f, 0x6a, 0x93, 0xfa]); // 国民の祝日
    const body = new TextEncoder().encode(CSV.split("\r\n").slice(1).join("\r\n").replace(/[^\x00-\x7f]/g, "x"));
    const bytes = new Uint8Array([...sjisHeader, 0x2c, 0x78, 0x0d, 0x0a, ...body]);
    expect(Object.keys(parseCaoCsv(bytes)).length).toBeGreaterThan(500);
  });
  it("rejects malformed or too-small data", () => {
    expect(() => parseCaoCsv("foo,bar\n2026/1/1,元日")).toThrow();
    expect(() => parseCaoCsv("国民の祝日・休日月日,名称\n2026/1/1,元日")).toThrow(/少なすぎ/);
    expect(() => parseCaoCsv("国民の祝日・休日月日,名称\nbad line")).toThrow();
  });
  it("refresh writes atomically and keeps the previous data on failure", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hol-"));
    const file = path.join(dir, "data", "jp-holidays.json");
    const ok = await refreshHolidays(file, { fetchImpl: (async () => new Response(CSV)) as typeof fetch });
    expect(ok).toMatchObject({ ok: true, coverageTo: "2027-12-31" });
    const before = fs.readFileSync(file, "utf8");
    const ng = await refreshHolidays(file, { fetchImpl: (async () => new Response("x", { status: 503 })) as typeof fetch });
    expect(ng).toEqual({ ok: false, error: "HTTP 503" });
    const bad = await refreshHolidays(file, { fetchImpl: (async () => new Response("<html>maintenance</html>")) as typeof fetch });
    expect(bad.ok).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
    expect(loadHolidayData(file)!.holidays["2026-10-12"]).toBe("スポーツの日");
  });
  it("never guesses outside coverage and warns near the end", () => {
    const data = buildHolidayData(parseCaoCsv(CSV), "test");
    expect(holidayStatus(data, "2026-10-12")).toEqual({ known: true, holiday: "スポーツの日" });
    expect(holidayStatus(data, "2028-01-01").known).toBe(false);
    expect(holidayStatus(null, "2026-10-12")).toEqual({ known: false, reason: "祝日データ未取得" });
    expect(coverageWarning(data, "2026-10-12")).toBeNull();
    expect(coverageWarning(data, "2027-11-01")).toMatch(/2027-12-31 まで/);
  });
});

describe("jp-calendar", () => {
  const data = buildHolidayData(parseCaoCsv(CSV), "test");
  it("dayInfo combines weekday, holiday, business day and rokuyo", () => {
    expect(dayInfo("2026-10-12", data)).toMatchObject({ weekday: "月", holiday: "スポーツの日", businessDay: false, rokuyo: "仏滅", lunar: "9月2日" });
    expect(dayInfo("2026-10-13", data)).toMatchObject({ businessDay: true, rokuyo: "大安" });
    expect(dayInfo("2026-10-17", data)).toMatchObject({ weekday: "土", businessDay: false });
    expect(dayInfo("2028-03-01", data)).toMatchObject({ holidayKnown: false, businessDay: null });
    expect(shortAnnotation(dayInfo("2026-10-12", data))).toBe("仏滅・祝:スポーツの日");
  });
  it("addBusinessDays skips weekends and holidays, refuses to guess beyond coverage", () => {
    expect(addBusinessDays("2026-10-09", 1, data)).toEqual({ date: "2026-10-13", skipped: ["2026-10-10(土)", "2026-10-11(日)", "2026-10-12(月・スポーツの日)"] });
    expect(addBusinessDays("2026-10-13", -1, data)!.date).toBe("2026-10-09");
    expect(addBusinessDays("2027-12-30", 3, data)).toBeNull();
  });
  it("holidaysBetween lists sorted holidays", () => {
    expect(holidaysBetween("2026-09-01", "2026-10-31", data)).toEqual([
      { date: "2026-09-22", name: "休日" },
      { date: "2026-10-12", name: "スポーツの日" },
    ]);
  });
  it("buildDateContext can annotate the lookup table", () => {
    const now = new Date("2026-10-11T16:30:00Z"); // 2026-10-12 01:30 JST
    const ctx = buildDateContext(now, "Asia/Tokyo", (ymd) => shortAnnotation(dayInfo(ymd, data)));
    expect(ctx).toContain("- 今日: 2026-10-12（月） 仏滅・祝:スポーツの日");
    expect(ctx).toContain("- 明日: 2026-10-13（火） 大安");
  });
});
