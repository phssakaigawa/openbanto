/**
 * 日本の祝日（#668）— 内閣府「国民の祝日」CSV を定期取り込みして判定する。
 *
 * 出典: 内閣府「国民の祝日について」syukujitsu.csv（Shift_JIS, "YYYY/M/D,名称"）。
 * 振替休日・国民の休日を含み、毎年2月頃に翌年分が追加される。
 * 取り込んだデータは JINN_HOME/data/jp-holidays.json に保存し、取得失敗時は前回データで判定を続ける。
 */
import fs from "node:fs";
import path from "node:path";

export const CAO_HOLIDAYS_URL = "https://www8.cao.go.jp/chosei/shukujitsu/syukujitsu.csv";

export interface HolidayData {
  source: string;
  fetchedAt: string; // ISO
  /** 収録範囲（CSV の最初と最後の祝日の年の 1/1〜12/31） */
  coverage: { from: string; to: string };
  holidays: Record<string, string>; // YYYY-MM-DD → 名称
}

/** CSV（Shift_JIS のバイト列 or 文字列）を解析する。形式が想定外なら例外。 */
export function parseCaoCsv(input: Uint8Array | string): Record<string, string> {
  // 公表ファイルは Shift_JIS。将来 UTF-8 になっても読めるよう、厳密な UTF-8 で読めればそれを使う。
  let text: string;
  if (typeof input === "string") text = input;
  else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(input);
    } catch {
      text = new TextDecoder("shift_jis").decode(input);
    }
  }
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 || !/祝日/.test(lines[0])) throw new Error("祝日CSVのヘッダが想定外です");
  const out: Record<string, string> = {};
  for (const line of lines.slice(1)) {
    const m = line.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2}),(.+)$/);
    if (!m) throw new Error(`祝日CSVの行が想定外です: ${line.slice(0, 40)}`);
    const key = `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    out[key] = m[4].trim();
  }
  const n = Object.keys(out).length;
  if (n < 500) throw new Error(`祝日CSVの件数が少なすぎます (${n})`);
  return out;
}

export function buildHolidayData(holidays: Record<string, string>, source: string, now = new Date()): HolidayData {
  const keys = Object.keys(holidays).sort();
  return {
    source,
    fetchedAt: now.toISOString(),
    coverage: { from: `${keys[0].slice(0, 4)}-01-01`, to: `${keys[keys.length - 1].slice(0, 4)}-12-31` },
    holidays,
  };
}

/* ───────────────────────── storage ───────────────────────── */

export function holidayFilePath(home: string): string {
  return path.join(home, "data", "jp-holidays.json");
}

let cache: { file: string; mtimeMs: number; data: HolidayData } | null = null;

/** 保存済みデータを読む（mtime でキャッシュ）。無ければ null。 */
export function loadHolidayData(file: string): HolidayData | null {
  try {
    const st = fs.statSync(file);
    if (cache && cache.file === file && cache.mtimeMs === st.mtimeMs) return cache.data;
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as HolidayData;
    if (!data?.holidays || !data?.coverage) return null;
    cache = { file, mtimeMs: st.mtimeMs, data };
    return data;
  } catch {
    return null;
  }
}

function writeAtomic(file: string, data: HolidayData): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

export interface RefreshResult {
  ok: boolean;
  count?: number;
  coverageTo?: string;
  error?: string;
}

/** 内閣府 CSV を取得して保存。失敗しても既存ファイルは残す。 */
export async function refreshHolidays(
  file: string,
  opts: { url?: string; fetchImpl?: typeof fetch; timeoutMs?: number; now?: Date } = {},
): Promise<RefreshResult> {
  const url = opts.url ?? CAO_HOLIDAYS_URL;
  const f = opts.fetchImpl ?? fetch;
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), opts.timeoutMs ?? 20_000);
  try {
    const res = await f(url, { signal: ac.signal });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const holidays = parseCaoCsv(new Uint8Array(await res.arrayBuffer()));
    const data = buildHolidayData(holidays, url, opts.now);
    writeAtomic(file, data);
    return { ok: true, count: Object.keys(holidays).length, coverageTo: data.coverage.to };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    clearTimeout(t);
  }
}

/* ───────────────────────── queries ───────────────────────── */

export type HolidayStatus =
  | { known: true; holiday: string | null }
  | { known: false; reason: string };

/** YYYY-MM-DD の祝日判定。収録範囲外・データ無しは known:false（推測しない）。 */
export function holidayStatus(data: HolidayData | null, ymd: string): HolidayStatus {
  if (!data) return { known: false, reason: "祝日データ未取得" };
  if (ymd < data.coverage.from || ymd > data.coverage.to) {
    return { known: false, reason: `祝日データの収録範囲外（${data.coverage.from}〜${data.coverage.to}）` };
  }
  return { known: true, holiday: data.holidays[ymd] ?? null };
}

/** 収録範囲の終端が近い（days 日以内）なら警告文。 */
export function coverageWarning(data: HolidayData | null, todayYmd: string, days = 90): string | null {
  if (!data) return "祝日データ未取得（内閣府CSVの取り込みに失敗しています）";
  const end = Date.parse(`${data.coverage.to}T00:00:00Z`);
  const today = Date.parse(`${todayYmd}T00:00:00Z`);
  if (end - today < days * 86_400_000) return `祝日データの収録は ${data.coverage.to} まで（内閣府の翌年分公表待ち）`;
  return null;
}
