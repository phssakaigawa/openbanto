/**
 * 日本の暦情報（#668）: 曜日・祝日（内閣府CSV）・営業日・六曜・旧暦。
 * 祝日データが無い/収録範囲外の日は「不明」と返し、推測しない。
 */
import { addDays, iso, weekday, type Ymd } from "./dates.js";
import { holidayStatus, loadHolidayData, type HolidayData } from "./jp-holidays.js";
import { toLunar } from "./kyureki.js";

const W = ["日", "月", "火", "水", "木", "金", "土"];

export interface DayInfo {
  date: string;
  weekday: string;
  holiday: string | null; // 祝日名（休日含む）
  holidayKnown: boolean;
  businessDay: boolean | null; // 土日祝でなければ true。祝日不明なら平日は null
  rokuyo: string;
  lunar: string; // 旧暦 例: "閏2月1日"
  note?: string;
}

const parse = (ymd: string): Ymd => {
  const [y, m, d] = ymd.split("-").map(Number);
  return { y, m, d };
};

export function dayInfo(ymd: string, data: HolidayData | null): DayInfo {
  const v = parse(ymd);
  const wd = weekday(v);
  const hs = holidayStatus(data, ymd);
  const lunar = toLunar(v.y, v.m, v.d);
  const weekend = wd === 0 || wd === 6;
  const holiday = hs.known ? hs.holiday : null;
  return {
    date: ymd,
    weekday: W[wd],
    holiday,
    holidayKnown: hs.known,
    businessDay: weekend || holiday ? false : hs.known ? true : null,
    rokuyo: lunar.rokuyo,
    lunar: `${lunar.leap ? "閏" : ""}${lunar.month}月${lunar.day}日`,
    note: [hs.known ? undefined : hs.reason, lunar.ambiguous ? "2033年問題の期間（旧暦・六曜は暦によって異なる場合あり）" : undefined]
      .filter(Boolean)
      .join(" / ") || undefined,
  };
}

/** 早見表などに付ける短い注記: "大安・祝:スポーツの日" */
export function shortAnnotation(info: DayInfo): string {
  const parts = [info.rokuyo];
  if (info.holiday) parts.push(`祝:${info.holiday}`);
  return parts.join("・");
}

/** n 営業日後（負なら前）。祝日不明の日に当たったら null（推測しない）。 */
export function addBusinessDays(ymd: string, n: number, data: HolidayData | null): { date: string; skipped: string[] } | null {
  let cur = parse(ymd);
  const step = n >= 0 ? 1 : -1;
  let left = Math.abs(n);
  const skipped: string[] = [];
  let guard = 0;
  while (left > 0) {
    cur = addDays(cur, step);
    const info = dayInfo(iso(cur), data);
    if (info.businessDay === null) return null;
    if (info.businessDay) left--;
    else skipped.push(`${info.date}(${info.weekday}${info.holiday ? `・${info.holiday}` : ""})`);
    if (++guard > 3660) return null;
  }
  return { date: iso(cur), skipped };
}

/** 期間内の祝日一覧。 */
export function holidaysBetween(from: string, to: string, data: HolidayData | null): Array<{ date: string; name: string }> {
  if (!data) return [];
  return Object.entries(data.holidays)
    .filter(([d]) => d >= from && d <= to)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, name]) => ({ date, name }));
}

export { loadHolidayData };
