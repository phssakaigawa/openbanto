#!/usr/bin/env node
/**
 * Built-in `datetime` MCP server (stdio) — deterministic date tools (#654).
 *
 * Attached to every session (including employees with an explicit `mcp:` list,
 * unless `mcp: false` or `mcp.datetime.enabled: false`) so no 職人 has to guess
 * what "明日" or "来週月曜" means. Time zone: JINN_TIMEZONE env (speaker /
 * portal), defaulting to Asia/Tokyo.
 */
import { createInterface } from "node:readline";
import { buildDateContext, resolveDateExpression, safeTimeZone, zonedNow, iso } from "../shared/dates.js";
import { coverageWarning, loadHolidayData } from "../shared/jp-holidays.js";
import { addBusinessDays, dayInfo, holidaysBetween, shortAnnotation, type DayInfo } from "../shared/jp-calendar.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const TZ = safeTimeZone(process.env.JINN_TIMEZONE);
const HOLIDAYS_FILE = process.env.JINN_HOLIDAYS_FILE || "";
const holidays = () => (HOLIDAYS_FILE ? loadHolidayData(HOLIDAYS_FILE) : null);

function describeDay(i: DayInfo): string {
  const biz = i.businessDay === null ? "不明（祝日データ範囲外）" : i.businessDay ? "営業日" : "休業日（土日祝）";
  return [
    `${i.date}（${i.weekday}）`,
    `祝日: ${i.holidayKnown ? i.holiday ?? "なし" : "不明"}`,
    `営業日: ${biz}`,
    `六曜: ${i.rokuyo}`,
    `旧暦: ${i.lunar}`,
    ...(i.note ? [`注記: ${i.note}`] : []),
  ].join("\n");
}

const TOOLS = [
  {
    name: "resolve_date",
    description:
      "日付表現（今日/明日/明後日/昨日/一昨日/N日後/N週間前/来週月曜/次の金曜/今月末/来月10日/M月D日/M/D/YYYY-MM-DD 等）を、ゲートウェイの時計基準で YYYY-MM-DD（曜日付き）に変換する。日付を自分で計算・推測せず必ずこれを使う。解釈できない場合はエラーを返すので、その時は相手に確認すること。",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string", description: "日付表現（例: 明日 / 来週月曜 / 10/20）" } },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "date_info",
    description:
      "日付表現（resolve_date と同じ書式）の暦情報を返す: 曜日・祝日（内閣府の公表データ）・営業日か・六曜・旧暦。祝日や六曜は推測せず必ずこれで確認する。",
    inputSchema: {
      type: "object",
      properties: { expression: { type: "string", description: "例: 今日 / 来週月曜 / 2026-11-23" } },
      required: ["expression"],
      additionalProperties: false,
    },
  },
  {
    name: "add_business_days",
    description: "起点から N 営業日後（負なら前）の日付を返す。土日・祝日（内閣府データ）を除く。",
    inputSchema: {
      type: "object",
      properties: {
        expression: { type: "string", description: "起点（例: 今日 / 2026-10-09）" },
        days: { type: "number", description: "営業日数（負なら前）" },
      },
      required: ["expression", "days"],
      additionalProperties: false,
    },
  },
  {
    name: "list_holidays",
    description: "期間内の祝日（休日を含む）一覧を返す（内閣府の公表データ）。",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "開始（日付表現、省略時は今日）" },
        to: { type: "string", description: "終了（日付表現、省略時は開始から1年後）" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "current_datetime",
    description: "現在日時（曜日・タイムゾーン付き）と、昨日〜明後日・先週/今週/来週の日付早見表を返す。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function handleTool(name: string, args: Record<string, unknown>): { text: string; isError?: boolean } {
  const now = new Date();
  const hd = holidays();
  if (name === "current_datetime") {
    const z = zonedNow(now, TZ);
    const warn = coverageWarning(hd, iso({ y: z.y, m: z.m, d: z.d }));
    return { text: buildDateContext(now, TZ, (ymd) => shortAnnotation(dayInfo(ymd, hd)), warn ? [warn] : []) };
  }
  const resolve = (expr: unknown) => resolveDateExpression(typeof expr === "string" ? expr : "", now, TZ);
  if (name === "date_info") {
    const r = resolve(args.expression);
    if (!r) return { text: `「${String(args.expression ?? "")}」は日付として解釈できませんでした。相手に確認してください。`, isError: true };
    return { text: describeDay(dayInfo(r.date, hd)) };
  }
  if (name === "add_business_days") {
    const r = resolve(args.expression);
    const n = Number(args.days);
    if (!r || !Number.isInteger(n) || Math.abs(n) > 400) return { text: "起点の日付または日数が不正です。", isError: true };
    const out = addBusinessDays(r.date, n, hd);
    if (!out) return { text: "祝日データの収録範囲外にかかるため計算できません（推測しない）。", isError: true };
    return {
      text: `${r.display} から ${n} 営業日${n >= 0 ? "後" : "前"}: ${describeDay(dayInfo(out.date, hd)).split("\n")[0]}\n除外した日: ${out.skipped.join(", ") || "なし"}`,
    };
  }
  if (name === "list_holidays") {
    const f = args.from ? resolve(args.from) : resolve("今日");
    if (!f) return { text: "開始日を解釈できませんでした。", isError: true };
    let to = f.date.replace(/^(\d{4})/, (y) => String(Number(y) + 1));
    if (args.to) {
      const t = resolve(args.to);
      if (!t) return { text: "終了日を解釈できませんでした。", isError: true };
      to = t.date;
    }
    if (!hd) return { text: "祝日データ未取得です。", isError: true };
    const list = holidaysBetween(f.date, to, hd);
    const cov = hd.coverage.to < to ? `\n※ 祝日データの収録は ${hd.coverage.to} まで` : "";
    return { text: `${f.date}〜${to} の祝日（${list.length}件）:\n${list.map((h) => `- ${h.date}（${dayInfo(h.date, hd).weekday}） ${h.name}`).join("\n")}${cov}` };
  }
  if (name === "resolve_date") {
    const expr = typeof args.expression === "string" ? args.expression : "";
    const r = resolveDateExpression(expr, now, TZ);
    if (!r) {
      return {
        text: `「${expr}」は日付として解釈できませんでした。推測せず、YYYY-MM-DD などで相手に確認してください。（今日=${resolveDateExpression("今日", now, TZ)!.display} ${TZ}）`,
        isError: true,
      };
    }
    const i = dayInfo(r.date, hd);
    return { text: `${r.display}\nYYYY-MM-DD: ${r.date}\n解釈: ${r.basis}\n暦: ${shortAnnotation(i)}${i.businessDay === false ? "（休業日）" : ""}` };
  }
  return { text: `Unknown tool: ${name}`, isError: true };
}

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function handleRequest(req: JsonRpcRequest): void {
  const { id, method, params } = req;
  switch (method) {
    case "initialize":
      send({
        jsonrpc: "2.0",
        id,
        result: { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "jinn-datetime", version: "0.1.0" } },
      });
      return;
    case "tools/list":
      send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      return;
    case "tools/call": {
      const r = handleTool(String(params?.name ?? ""), (params?.arguments as Record<string, unknown>) ?? {});
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: r.text }], ...(r.isError ? { isError: true } : {}) } });
      return;
    }
    case "notifications/initialized":
      return;
    default:
      if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  try {
    handleRequest(JSON.parse(line) as JsonRpcRequest);
  } catch {
    /* ignore unparseable lines */
  }
});
rl.on("close", () => process.exit(0));
