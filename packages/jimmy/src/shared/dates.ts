/**
 * Deterministic date grounding (#654).
 *
 * LLM engines do not know the current date and will happily invent one — even
 * mutating a correct date that a tool returned (observed: "本日は 2025-10-12(月)"
 * when the tool said 2026-10-12). Dates are therefore computed here, in
 * software, and handed to the model as facts:
 *   - buildDateContext(): per-turn system-prompt block with a lookup table
 *   - resolveDateExpression(): backs the built-in `resolve_date` tool
 *   - guardDateClaims(): corrects "本日/明日/昨日 … YYYY-MM-DD" claims in replies
 *
 * All calendar math is done on plain Y-M-D values via Date.UTC so it is
 * independent of the host TZ; only "now" is projected into the target TZ.
 */

export const DEFAULT_TIMEZONE = "Asia/Tokyo";
const WEEKDAYS_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

export interface Ymd {
  y: number;
  m: number; // 1-12
  d: number;
}

/** Validate an IANA zone name; fall back to the default on anything unknown. */
export function safeTimeZone(tz: string | undefined): string {
  if (!tz) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** Calendar date + wall-clock time of `now` in `tz`. */
export function zonedNow(now: Date, tz: string): Ymd & { hh: number; mi: number } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: safeTimeZone(tz),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour") % 24, mi: get("minute") };
}

const toUtc = (v: Ymd) => Date.UTC(v.y, v.m - 1, v.d);
const fromUtc = (ms: number): Ymd => {
  const x = new Date(ms);
  return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate() };
};

export function addDays(v: Ymd, n: number): Ymd {
  return fromUtc(toUtc(v) + n * 86_400_000);
}

/** 0=日 … 6=土 */
export function weekday(v: Ymd): number {
  return new Date(toUtc(v)).getUTCDay();
}

export function isValidYmd(v: Ymd): boolean {
  if (!Number.isInteger(v.y) || !Number.isInteger(v.m) || !Number.isInteger(v.d)) return false;
  const r = fromUtc(toUtc(v));
  return r.y === v.y && r.m === v.m && r.d === v.d;
}

export function iso(v: Ymd): string {
  return `${String(v.y).padStart(4, "0")}-${String(v.m).padStart(2, "0")}-${String(v.d).padStart(2, "0")}`;
}

/** 2026-10-12（月） */
export function fmt(v: Ymd): string {
  return `${iso(v)}（${WEEKDAYS_JA[weekday(v)]}）`;
}

export function sameYmd(a: Ymd, b: Ymd): boolean {
  return a.y === b.y && a.m === b.m && a.d === b.d;
}

/** Monday of the week containing v (weeks run 月〜日, Japanese business convention). */
function mondayOf(v: Ymd): Ymd {
  const w = weekday(v);
  return addDays(v, w === 0 ? -6 : 1 - w);
}

/* ───────────────────────── A. context block ───────────────────────── */

export function buildDateContext(now: Date, tz?: string): string {
  const zone = safeTimeZone(tz);
  const n = zonedNow(now, zone);
  const today: Ymd = { y: n.y, m: n.m, d: n.d };
  const rel = [
    ["一昨日", -2],
    ["昨日", -1],
    ["今日", 0],
    ["明日", 1],
    ["明後日", 2],
  ] as const;
  const week = (offsetWeeks: number) => {
    const mon = addDays(mondayOf(today), offsetWeeks * 7);
    return Array.from({ length: 7 }, (_, i) => {
      const day = addDays(mon, i);
      return `${WEEKDAYS_JA[weekday(day)]} ${iso(day).slice(5)}`;
    }).join(" / ");
  };
  return [
    "## 現在日時（ゲートウェイの時計。これが唯一の正）",
    `現在: ${fmt(today)} ${String(n.hh).padStart(2, "0")}:${String(n.mi).padStart(2, "0")}（${zone}）`,
    "",
    "日付早見表（相対日付はこの表から引く。自分で計算・推測しない。年も必ずこの表の年を使う）:",
    ...rel.map(([label, off]) => `- ${label}: ${fmt(addDays(today, off))}`),
    `- 先週（月〜日）: ${week(-1)}`,
    `- 今週（月〜日）: ${week(0)}`,
    `- 来週（月〜日）: ${week(1)}`,
    "",
    "上表に無い日付表現（「3日後」「来月10日」「次の金曜」等）は `resolve_date` ツールで変換すること。解釈できない場合は推測せず相手に確認する。",
  ].join("\n");
}

/* ───────────────────────── B. resolve_date ───────────────────────── */

export interface ResolvedDate {
  date: string; // YYYY-MM-DD
  display: string; // 2026-10-12（月）
  basis: string; // human explanation of how it was interpreted
}

const toHalf = (s: string) =>
  s.replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/／/g, "/").replace(/－/g, "-");

const KANJI_NUM: Record<string, number> = { 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
const num = (s: string): number => (/^\d+$/.test(s) ? Number(s) : s === "十" ? 10 : s.length === 2 && s[0] === "十" ? 10 + (KANJI_NUM[s[1]] ?? NaN) : KANJI_NUM[s] ?? NaN);

const WD_RE = "(月|火|水|木|金|土|日)";

/**
 * Resolve a natural-language date expression relative to `now` in `tz`.
 * Returns null when it cannot be interpreted unambiguously.
 */
export function resolveDateExpression(expr: string, now: Date, tz?: string): ResolvedDate | null {
  const zone = safeTimeZone(tz);
  const n = zonedNow(now, zone);
  const today: Ymd = { y: n.y, m: n.m, d: n.d };
  const e = toHalf(String(expr ?? "")).trim().replace(/\s+/g, "");
  if (!e) return null;
  const out = (v: Ymd, basis: string): ResolvedDate | null =>
    isValidYmd(v) ? { date: iso(v), display: fmt(v), basis: `${basis}（基準: 今日=${fmt(today)} ${zone}）` } : null;

  const simple: Record<string, number> = {
    今日: 0, 本日: 0, きょう: 0,
    明日: 1, あした: 1, あす: 1, 翌日: 1,
    明後日: 2, あさって: 2,
    明々後日: 3, 明明後日: 3, しあさって: 3,
    昨日: -1, きのう: -1, 前日: -1,
    一昨日: -2, おととい: -2, おとつい: -2,
  };
  if (e in simple) return out(addDays(today, simple[e]), `「${e}」= 今日${simple[e] >= 0 ? "+" : ""}${simple[e]}日`);

  let m: RegExpMatchArray | null;
  if ((m = e.match(/^(\d+|[一二三四五六七八九十]+)(日|週間)(後|前)$/))) {
    const k = num(m[1]) * (m[2] === "週間" ? 7 : 1) * (m[3] === "後" ? 1 : -1);
    if (!Number.isFinite(k)) return null;
    return out(addDays(today, k), `「${e}」= 今日${k >= 0 ? "+" : ""}${k}日`);
  }
  if ((m = e.match(new RegExp(`^(先週|今週|来週|再来週)の?${WD_RE}曜?日?$`)))) {
    const off = { 先週: -1, 今週: 0, 来週: 1, 再来週: 2 }[m[1] as "先週"]!;
    const idx = WEEKDAYS_JA.indexOf(m[2] as (typeof WEEKDAYS_JA)[number]);
    const v = addDays(mondayOf(today), off * 7 + (idx === 0 ? 6 : idx - 1));
    return out(v, `「${e}」= ${m[1]}（週は月曜始まり）の${m[2]}曜日`);
  }
  if ((m = e.match(new RegExp(`^(?:次の|今度の|次回の)?${WD_RE}曜日?$`)))) {
    const idx = WEEKDAYS_JA.indexOf(m[1] as (typeof WEEKDAYS_JA)[number]);
    const delta = ((idx - weekday(today) + 7) % 7) || 7;
    return out(addDays(today, delta), `「${e}」= 今日より後で最初の${m[1]}曜日`);
  }
  // Date.UTC(y, m, 0): m is the 1-based current month = 0-based next month → day 0 = last day of this month
  if (e === "今月末" || e === "月末") return out(fromUtc(Date.UTC(today.y, today.m, 0)), "今月の末日");
  if (e === "来月末") return out(fromUtc(Date.UTC(today.y, today.m + 1, 0)), "来月の末日");
  if ((m = e.match(/^(今月|来月|先月)(\d{1,2})日$/))) {
    const off = { 今月: 0, 来月: 1, 先月: -1 }[m[1] as "今月"]!;
    const first = fromUtc(Date.UTC(today.y, today.m - 1 + off, 1));
    return out({ y: first.y, m: first.m, d: Number(m[2]) }, `「${e}」`);
  }
  if ((m = e.match(/^(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})日?(?:\((?:月|火|水|木|金|土|日)\)|（(?:月|火|水|木|金|土|日)）)?$/))) {
    return out({ y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) }, "年月日の明示指定");
  }
  if ((m = e.match(/^(\d{1,2})[/月](\d{1,2})日?$/))) {
    // 年の省略: 今日以降で最も近い日付（過去なら翌年）
    const md = { m: Number(m[1]), d: Number(m[2]) };
    let v: Ymd = { y: today.y, ...md };
    if (!isValidYmd(v)) return null;
    let basis = "月日指定・年省略→今年";
    if (toUtc(v) < toUtc(today)) {
      v = { y: today.y + 1, ...md };
      basis = "月日指定・年省略→今年では過去のため翌年";
    }
    return out(v, basis);
  }
  return null;
}

/* ───────────────────────── C. reply guard ───────────────────────── */

export interface DateFix {
  label: string;
  wrong: string;
  correct: string;
}

const LABEL_OFFSETS: Record<string, number> = {
  本日: 0, 今日: 0, きょう: 0,
  明日: 1, あした: 1, あす: 1,
  明後日: 2, あさって: 2,
  昨日: -1, きのう: -1,
  一昨日: -2, おととい: -2,
};

// 「本日は 2025-10-12(月)」「今日：2025/10/12」「【※ 本日は 2025年10月12日 です】」
const CLAIM_RE = new RegExp(
  `(本日|今日|きょう|明後日|明日|あさって|あした|あす|一昨日|昨日|おととい|きのう)` +
    `((?:\\s*(?:は|が|の日付は|=|＝|:|：|→|、|,)\\s*|\\s+)[(（【]?\\s*)` +
    `(\\d{4})([-/年])(\\d{1,2})([-/月])(\\d{1,2})(日?)` +
    `(\\s*[(（](?:月|火|水|木|金|土|日)(?:曜日?)?[)）])?`,
  "g",
);

/**
 * Correct explicit "相対ラベル + 日付" claims that contradict the gateway clock.
 * Only rewrites a date that is directly attached to 本日/今日/明日/昨日… so
 * unrelated dates (deadlines, history) are never touched. Weekday suffixes are
 * rewritten together. Returns the corrected text and what was fixed.
 */
export function guardDateClaims(text: string, now: Date, tz?: string): { text: string; fixes: DateFix[] } {
  if (!text) return { text, fixes: [] };
  const z = zonedNow(now, safeTimeZone(tz));
  const today: Ymd = { y: z.y, m: z.m, d: z.d };
  const fixes: DateFix[] = [];
  const outText = text.replace(CLAIM_RE, (all, label: string, sep: string, y: string, s1: string, mo: string, s2: string, d: string, dayMark: string, wd: string | undefined) => {
    const claimed: Ymd = { y: Number(y), m: Number(mo), d: Number(d) };
    const truth = addDays(today, LABEL_OFFSETS[label] ?? 0);
    const wdOk = !wd || wd.includes(WEEKDAYS_JA[weekday(truth)]);
    if (sameYmd(claimed, truth) && wdOk) return all;
    const pad = (x: number, like: string) => (like.length >= 2 ? String(x).padStart(2, "0") : String(x));
    const date = `${truth.y}${s1}${pad(truth.m, mo)}${s2}${pad(truth.d, d)}${dayMark}`;
    const wdOut = wd ? wd.replace(/(月|火|水|木|金|土|日)/, WEEKDAYS_JA[weekday(truth)]) : "";
    fixes.push({ label, wrong: `${y}${s1}${mo}${s2}${d}${dayMark}${wd ?? ""}`, correct: `${date}${wdOut}` });
    return `${label}${sep}${date}${wdOut}`;
  });
  if (fixes.length === 0) return { text, fixes };
  const note = `\n\n（※日付を自動補正しました: ${fixes.map((f) => `${f.label} ${f.wrong} → ${f.correct}`).join(" / ")}）`;
  return { text: outText + note, fixes };
}
