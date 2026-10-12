/**
 * 日本の祝日データの定期取り込み（#668）。
 * 内閣府 syukujitsu.csv を取得して JINN_HOME/data/jp-holidays.json に保存する。
 * 起動時はデータが無いか古ければ即取得、その後は refreshHours ごと。失敗しても前回データで継続。
 */
import fs from "node:fs";
import type { JinnConfig } from "../shared/types.js";
import { JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import { CAO_HOLIDAYS_URL, coverageWarning, holidayFilePath, loadHolidayData, refreshHolidays } from "../shared/jp-holidays.js";

let timer: NodeJS.Timeout | null = null;

export function startHolidayRefresher(config: JinnConfig): void {
  const cfg = config.calendar?.holidays;
  if (cfg?.enabled === false) return;
  const url = cfg?.url || CAO_HOLIDAYS_URL;
  const hours = cfg?.refreshHours && cfg.refreshHours > 0 ? cfg.refreshHours : 24;
  const file = holidayFilePath(JINN_HOME);

  const run = async (reason: string) => {
    const r = await refreshHolidays(file, { url });
    if (r.ok) logger.info(`[holidays] refreshed (${reason}): ${r.count} entries, coverage to ${r.coverageTo}`);
    else logger.warn(`[holidays] refresh failed (${reason}): ${r.error} — keeping previous data`);
    const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
    const warn = coverageWarning(loadHolidayData(file), today);
    if (warn) logger.warn(`[holidays] ${warn}`);
  };

  let stale = true;
  try {
    stale = Date.now() - fs.statSync(file).mtimeMs > hours * 3600_000;
  } catch {
    /* no file yet */
  }
  if (stale) void run("startup");
  if (timer) clearInterval(timer);
  timer = setInterval(() => void run("interval"), hours * 3600_000);
  timer.unref();
}
