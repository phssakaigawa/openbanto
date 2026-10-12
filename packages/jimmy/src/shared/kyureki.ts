/**
 * 旧暦（天保暦の規則による太陰太陽暦）と六曜の計算（#668）。
 *
 * 天文計算は J. Meeus "Astronomical Algorithms" (2nd ed.) に基づく自前実装:
 *   - 朔（新月）: 49章の平均朔＋補正項（精度 数秒）
 *   - 太陽の視黄経: 25章の簡易式（精度 約0.01°）
 *   - ΔT: Espenak & Meeus (2006) の多項式
 * 暦法の規則（現行の旧暦＝天保暦の慣行）:
 *   - 日付の境界は JST（UTC+9）
 *   - 冬至（太陽黄経270°）を含む月を11月とする
 *   - 11月〜翌11月の間が13か月ある年は、最初の「中気（黄経30°の倍数）を含まない月」を閏月とする
 * 六曜 = (旧暦月 + 旧暦日) mod 6 → 0:大安 1:赤口 2:先勝 3:友引 4:先負 5:仏滅（閏月は同じ月番号）
 *
 * 既知の限界: 2033年問題（2033〜2034年は天保暦の規則だけでは閏月が一意に決まらない）。
 * 本実装は規則を機械的に適用した結果を返し、該当期間は `ambiguous: true` を付ける。
 */

export const ROKUYO = ["大安", "赤口", "先勝", "友引", "先負", "仏滅"] as const;
export type Rokuyo = (typeof ROKUYO)[number];

export interface LunarDate {
  year: number; // 旧暦の年（1月朔日が属するグレゴリオ年）
  month: number; // 1-12
  day: number; // 1-30
  leap: boolean; // 閏月
  rokuyo: Rokuyo;
  /** 2033年問題の期間（閏月の扱いが一意でない） */
  ambiguous: boolean;
}

const RAD = Math.PI / 180;
const sin = (deg: number) => Math.sin(deg * RAD);
const norm360 = (x: number) => ((x % 360) + 360) % 360;

/** グレゴリオ暦日 → ユリウス日番号（その日の正午の JD）。 */
export function jdn(y: number, m: number, d: number): number {
  const a = Math.floor((14 - m) / 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) - Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

/** ユリウス日番号 → グレゴリオ暦日。 */
export function fromJdn(j: number): { y: number; m: number; d: number } {
  const a = j + 32044;
  const b = Math.floor((4 * a + 3) / 146097);
  const c = a - Math.floor((146097 * b) / 4);
  const d = Math.floor((4 * c + 3) / 1461);
  const e = c - Math.floor((1461 * d) / 4);
  const m = Math.floor((5 * e + 2) / 153);
  return { d: e - Math.floor((153 * m + 2) / 5) + 1, m: m + 3 - 12 * Math.floor(m / 10), y: 100 * b + d - 4800 + Math.floor(m / 10) };
}

/** ΔT（秒）— Espenak & Meeus (2006)。 */
function deltaT(year: number): number {
  const y = year;
  if (y >= 2005 && y < 2050) {
    const t = y - 2000;
    return 62.92 + 0.32217 * t + 0.005589 * t * t;
  }
  if (y >= 2050 && y < 2150) return -20 + 32 * ((y - 1820) / 100) ** 2 - 0.5628 * (2150 - y);
  if (y >= 1986 && y < 2005) {
    const t = y - 2000;
    return 63.86 + 0.3345 * t - 0.060374 * t ** 2 + 0.0017275 * t ** 3 + 0.000651814 * t ** 4 + 0.00002373599 * t ** 5;
  }
  if (y >= 1961 && y < 1986) {
    const t = y - 1975;
    return 45.45 + 1.067 * t - (t * t) / 260 - (t ** 3) / 718;
  }
  if (y >= 1941 && y < 1961) {
    const t = y - 1950;
    return 29.07 + 0.407 * t - (t * t) / 233 + (t ** 3) / 2547;
  }
  return -20 + 32 * ((y - 1820) / 100) ** 2;
}

/** JDE（力学時）→ その瞬間の JST 暦日のユリウス日番号。 */
function jstDayOf(jde: number): number {
  const year = 2000 + (jde - 2451545) / 365.25;
  const jdUt = jde - deltaT(year) / 86400;
  return Math.floor(jdUt + 0.5 + 9 / 24);
}

/** k 番目の朔の JDE（k=0 ≒ 2000-01-06）。Meeus 49章。 */
function newMoonJde(k: number): number {
  const T = k / 1236.85;
  const T2 = T * T, T3 = T2 * T, T4 = T3 * T;
  let jde = 2451550.09766 + 29.530588861 * k + 0.00015437 * T2 - 0.00000015 * T3 + 0.00000000073 * T4;
  const E = 1 - 0.002516 * T - 0.0000074 * T2;
  const M = 2.5534 + 29.1053567 * k - 0.0000014 * T2 - 0.00000011 * T3;
  const Mp = 201.5643 + 385.81693528 * k + 0.0107582 * T2 + 0.00001238 * T3 - 0.000000058 * T4;
  const F = 160.7108 + 390.67050284 * k - 0.0016118 * T2 - 0.00000227 * T3 + 0.000000011 * T4;
  const Om = 124.7746 - 1.56375588 * k + 0.0020672 * T2 + 0.00000215 * T3;
  jde +=
    -0.4072 * sin(Mp) +
    0.17241 * E * sin(M) +
    0.01608 * sin(2 * Mp) +
    0.01039 * sin(2 * F) +
    0.00739 * E * sin(Mp - M) -
    0.00514 * E * sin(Mp + M) +
    0.00208 * E * E * sin(2 * M) -
    0.00111 * sin(Mp - 2 * F) -
    0.00057 * sin(Mp + 2 * F) +
    0.00056 * E * sin(2 * Mp + M) -
    0.00042 * sin(3 * Mp) +
    0.00042 * E * sin(M + 2 * F) +
    0.00038 * E * sin(M - 2 * F) -
    0.00024 * E * sin(2 * Mp - M) -
    0.00017 * sin(Om) -
    0.00007 * sin(Mp + 2 * M) +
    0.00004 * sin(2 * Mp - 2 * F) +
    0.00004 * sin(3 * M) +
    0.00003 * sin(Mp + M - 2 * F) +
    0.00003 * sin(2 * Mp + 2 * F) -
    0.00003 * sin(Mp + M + 2 * F) +
    0.00003 * sin(Mp - M + 2 * F) -
    0.00002 * sin(Mp - M - 2 * F) -
    0.00002 * sin(3 * Mp + M) +
    0.00002 * sin(4 * Mp);
  const A = [
    [299.77 + 0.107408 * k - 0.009173 * T2, 0.000325],
    [251.88 + 0.016321 * k, 0.000165],
    [251.83 + 26.651886 * k, 0.000164],
    [349.42 + 36.412478 * k, 0.000126],
    [84.66 + 18.206239 * k, 0.00011],
    [141.74 + 53.303771 * k, 0.000062],
    [207.14 + 2.453732 * k, 0.00006],
    [154.84 + 7.30686 * k, 0.000056],
    [34.52 + 27.261239 * k, 0.000047],
    [207.19 + 0.121824 * k, 0.000042],
    [291.34 + 1.844379 * k, 0.00004],
    [161.72 + 24.198154 * k, 0.000037],
    [239.56 + 25.513099 * k, 0.000035],
    [331.55 + 3.592518 * k, 0.000023],
  ];
  for (const [arg, c] of A) jde += c * sin(arg);
  return jde;
}

/** 太陽の視黄経（度）。Meeus 25章 簡易式。 */
function sunLongitude(jde: number): number {
  const T = (jde - 2451545) / 36525;
  const L0 = 280.46646 + 36000.76983 * T + 0.0003032 * T * T;
  const M = 357.52911 + 35999.05029 * T - 0.0001537 * T * T;
  const C = (1.914602 - 0.004817 * T - 0.000014 * T * T) * sin(M) + (0.019993 - 0.000101 * T) * sin(2 * M) + 0.000289 * sin(3 * M);
  const om = 125.04 - 1934.136 * T;
  return norm360(L0 + C - 0.00569 - 0.00478 * sin(om));
}

/** 太陽黄経が target 度になる JDE（guess 付近）。 */
function solarTermJde(target: number, guess: number): number {
  let jde = guess;
  for (let i = 0; i < 50; i++) {
    let diff = target - sunLongitude(jde);
    diff = ((diff + 540) % 360) - 180;
    jde += (diff / 360) * 365.2422;
    if (Math.abs(diff) < 1e-7) break;
  }
  return jde;
}

/** JST 暦日 j の 00:00 JST に対応する JDE。 */
function jdeAtJstMidnight(j: number): number {
  const jdUt = j - 0.5 - 9 / 24;
  const year = 2000 + (jdUt - 2451545) / 365.25;
  return jdUt + deltaT(year) / 86400;
}

/** JST 暦日の区間 [a, b) に中気（太陽黄経 30° の倍数）が入るか。 */
function hasPrincipalTerm(a: number, b: number): boolean {
  const start = jdeAtJstMidnight(a);
  const lon = sunLongitude(start);
  const next = (Math.floor(lon / 30) + 1) * 30;
  const termJde = solarTermJde(next % 360, start + ((next - lon) / 360) * 365.2422);
  return jstDayOf(termJde) < b;
}

/** k の朔の JST 暦日。 */
const newMoonDay = (k: number) => jstDayOf(newMoonJde(k));

/** JST 暦日 j を含む朔望月の開始（朔日）の k。 */
function newMoonKOnOrBefore(j: number): number {
  let k = Math.floor((j - 2451550.1) / 29.530588861);
  while (newMoonDay(k) > j) k--;
  while (newMoonDay(k + 1) <= j) k++;
  return k;
}

/** Y 年の冬至の JST 暦日。 */
function winterSolsticeDay(Y: number): number {
  return jstDayOf(solarTermJde(270, jdn(Y, 12, 21)));
}

interface MonthRow {
  start: number; // 朔日の JST 暦日
  month: number;
  leap: boolean;
}

const yearCache = new Map<number, MonthRow[]>();

/**
 * 「Y 年の冬至を含む月（11月）」から「Y+1 年の冬至を含む月」の直前までの月表。
 * 13か月なら最初の中気なし月を閏月にする。
 */
function monthsFromSolstice(Y: number): MonthRow[] {
  const hit = yearCache.get(Y);
  if (hit) return hit;
  const k0 = newMoonKOnOrBefore(winterSolsticeDay(Y));
  const k1 = newMoonKOnOrBefore(winterSolsticeDay(Y + 1));
  const n = k1 - k0; // 12 or 13
  const rows: MonthRow[] = [];
  let m = 11;
  let leapDone = n !== 13;
  for (let k = k0; k < k1; k++) {
    const a = newMoonDay(k);
    const b = newMoonDay(k + 1);
    let isLeap = false;
    if (k > k0 && !leapDone && !hasPrincipalTerm(a, b)) {
      isLeap = true;
      leapDone = true;
    }
    if (k > k0 && !isLeap) m = (m % 12) + 1;
    rows.push({ start: a, month: m, leap: isLeap });
  }
  yearCache.set(Y, rows);
  return rows;
}

/** グレゴリオ暦日（JST の暦日）→ 旧暦と六曜。 */
export function toLunar(y: number, m: number, d: number): LunarDate {
  const j = jdn(y, m, d);
  // j を含む区間は「前年冬至月〜今年冬至月」か「今年冬至月〜翌年冬至月」
  let rows = monthsFromSolstice(y);
  if (j < rows[0].start) rows = monthsFromSolstice(y - 1);
  let i = rows.length - 1;
  while (i > 0 && rows[i].start > j) i--;
  const row = rows[i];
  const day = j - row.start + 1;
  return {
    // 11月・12月が1〜2月に掛かる場合は前年の旧暦年
    year: row.month >= 11 && m <= 6 ? y - 1 : y,
    month: row.month,
    day,
    leap: row.leap,
    rokuyo: ROKUYO[(row.month + day) % 6],
    ambiguous: (y === 2033 && m >= 7) || (y === 2034 && m <= 5),
  };
}

/** YYYY-MM-DD → 六曜。 */
export function rokuyoOf(ymd: string): Rokuyo {
  const [y, m, d] = ymd.split("-").map(Number);
  return toLunar(y, m, d).rokuyo;
}
