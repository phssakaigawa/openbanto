/**
 * Call a single 職人 (MCP) tool directly from the gateway — no engine/LLM in
 * the loop. Used by Slack modal forms: fetching a form spec and submitting the
 * user's values verbatim.
 *
 * Server config, static auth headers and the per-user identity headers
 * (X-Banto-User-Id …) are resolved exactly as for an engine turn
 * (resolveMcpServers), and the transport is the same McpToolBridge the
 * OpenAI-compatible engine uses — so a 職人 sees an identical request either way.
 */
import type { McpGlobalConfig } from "../shared/types.js";
import { resolveMcpServers, type McpSessionContext } from "./resolver.js";
import { McpToolBridge } from "./tool-bridge.js";
import { logger } from "../shared/logger.js";

export interface DirectCallResult {
  ok: boolean;
  text: string;
}

/**
 * Whether `form` is enabled for `server` (`mcp.custom.<server>.forms: [...]`).
 * Forms are opt-in per server so an LLM-emitted marker cannot reach arbitrary
 * servers/tools.
 */
export function isFormAllowed(globalMcp: McpGlobalConfig | undefined, server: string, form: string): boolean {
  const custom = globalMcp?.custom?.[server] as { enabled?: boolean; forms?: unknown } | undefined;
  if (!custom || custom.enabled === false) return false;
  return Array.isArray(custom.forms) && custom.forms.includes(form);
}

/**
 * The 職人 tool bound to a confirmation-button label
 * (`mcp.custom.<server>.choiceActions: { "<label>": "<tool>" }`), or null.
 * Opt-in per server for the same reason as forms: the label comes from an
 * LLM-emitted marker, so only labels the operator listed may reach a tool.
 * First enabled server (config order) wins if several bind the same label.
 */
export function findChoiceAction(
  globalMcp: McpGlobalConfig | undefined,
  label: string,
): { server: string; tool: string } | null {
  const key = label.trim();
  if (!key) return null;
  for (const [server, raw] of Object.entries(globalMcp?.custom ?? {})) {
    const custom = raw as { enabled?: boolean; choiceActions?: unknown } | undefined;
    if (!custom || custom.enabled === false) continue;
    const actions = custom.choiceActions;
    if (!actions || typeof actions !== "object" || Array.isArray(actions)) continue;
    const tool = (actions as Record<string, unknown>)[key];
    if (typeof tool === "string" && /^[A-Za-z0-9_.-]+$/.test(tool)) return { server, tool };
  }
  return null;
}

export async function callMcpToolDirect(
  globalMcp: McpGlobalConfig | undefined,
  server: string,
  tool: string,
  args: Record<string, unknown>,
  identity: McpSessionContext,
  opts: { timeoutMs?: number; bridgeFactory?: () => McpToolBridge } = {},
): Promise<DirectCallResult> {
  // X-Banto-Via: form — lets a 職人 require that e.g. a create operation was
  // confirmed by the user in a modal (engine turns never carry this header).
  const { mcpServers } = resolveMcpServers(globalMcp, undefined, { ...identity, via: identity.via ?? "form" });
  const cfg = mcpServers[server];
  if (!cfg) return { ok: false, text: `MCP サーバ「${server}」は利用できません` };

  const bridge = opts.bridgeFactory ? opts.bridgeFactory() : new McpToolBridge();
  const timeoutMs = opts.timeoutMs ?? 30_000;
  let timer: NodeJS.Timeout | undefined;
  try {
    const run = (async () => {
      const n = await bridge.connect({ [server]: cfg });
      if (n === 0) return { ok: false, text: `MCP サーバ「${server}」に接続できませんでした` };
      // stringifyToolResult prefixes "Error: " when the tool set isError.
      const text = await bridge.callTool(`${server}__${tool}`, args);
      return /^Error: /.test(text) ? { ok: false, text: text.slice("Error: ".length) } : { ok: true, text };
    })();
    const timeout = new Promise<DirectCallResult>((resolve) => {
      timer = setTimeout(() => resolve({ ok: false, text: `MCP サーバ「${server}」の応答がタイムアウトしました` }), timeoutMs);
    });
    return await Promise.race([run, timeout]);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.warn(`[forms] direct call ${server}.${tool} failed: ${msg.slice(0, 200)}`);
    return { ok: false, text: `MCP サーバ「${server}」の呼び出しに失敗しました` };
  } finally {
    if (timer) clearTimeout(timer);
    await bridge.close();
  }
}
