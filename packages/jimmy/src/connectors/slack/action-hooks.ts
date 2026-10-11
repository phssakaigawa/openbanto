/**
 * Block Kit button hooks (SlackConnectorConfig.actionHooks): pure helpers that
 * extract the press context from a Bolt action payload and turn it into the
 * environment handed to the spawned hook command.
 *
 * The hook command receives the button `value` as its last argv (unchanged,
 * backward compatible) and, additionally, WHO pressed the button and WHERE:
 *
 *   BANTO_ACTION_ID          the action_id that fired
 *   BANTO_ACTION_USER_ID     Slack user ID of the presser
 *   BANTO_ACTION_CHANNEL     channel ID of the message carrying the button
 *   BANTO_ACTION_MESSAGE_TS  ts of the message carrying the button
 *   BANTO_ACTION_THREAD_TS   thread root ts (= message ts for a root message)
 *
 * These values come from Slack's signed interaction payload, so a hook can use
 * them for authorization decisions (e.g. "only members of group X may press").
 * Any BANTO_ACTION_* inherited from the gateway's own environment is dropped so
 * a stale value can never be mistaken for the presser.
 */

export interface ActionHookContext {
  actionId: string;
  value: string;
  userId?: string;
  channel?: string;
  messageTs?: string;
  threadTs?: string;
}

const ENV_PREFIX = "BANTO_ACTION_";

/** Pull value / presser / location out of a Bolt `block_actions` body. */
export function extractActionHookContext(actionId: string, body: unknown): ActionHookContext {
  const b = (body ?? {}) as any;
  const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);
  const messageTs = str(b.message?.ts) ?? str(b.container?.message_ts);
  return {
    actionId,
    value: typeof b.actions?.[0]?.value === "string" ? b.actions[0].value : "",
    userId: str(b.user?.id),
    channel: str(b.channel?.id) ?? str(b.container?.channel_id),
    messageTs,
    threadTs: str(b.message?.thread_ts) ?? messageTs,
  };
}

/** Environment for the hook process: inherited env minus stale BANTO_ACTION_*, plus this press. */
export function buildActionHookEnv(
  ctx: ActionHookContext,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(base)) {
    if (!k.startsWith(ENV_PREFIX)) env[k] = v;
  }
  const set = (k: string, v: string | undefined) => {
    if (v) env[ENV_PREFIX + k] = v;
  };
  set("ID", ctx.actionId);
  set("USER_ID", ctx.userId);
  set("CHANNEL", ctx.channel);
  set("MESSAGE_TS", ctx.messageTs);
  set("THREAD_TS", ctx.threadTs);
  return env;
}
