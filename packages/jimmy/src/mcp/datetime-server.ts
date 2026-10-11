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
import { buildDateContext, resolveDateExpression, safeTimeZone } from "../shared/dates.js";

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

const TZ = safeTimeZone(process.env.JINN_TIMEZONE);

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
    name: "current_datetime",
    description: "現在日時（曜日・タイムゾーン付き）と、昨日〜明後日・先週/今週/来週の日付早見表を返す。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

function handleTool(name: string, args: Record<string, unknown>): { text: string; isError?: boolean } {
  const now = new Date();
  if (name === "current_datetime") return { text: buildDateContext(now, TZ) };
  if (name === "resolve_date") {
    const expr = typeof args.expression === "string" ? args.expression : "";
    const r = resolveDateExpression(expr, now, TZ);
    if (!r) {
      return {
        text: `「${expr}」は日付として解釈できませんでした。推測せず、YYYY-MM-DD などで相手に確認してください。（今日=${resolveDateExpression("今日", now, TZ)!.display} ${TZ}）`,
        isError: true,
      };
    }
    return { text: `${r.display}\nYYYY-MM-DD: ${r.date}\n解釈: ${r.basis}` };
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
