import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { buildActionHookEnv, extractActionHookContext } from "../action-hooks.js";

const rootPress = {
  type: "block_actions",
  user: { id: "U000PRESSER" },
  channel: { id: "C000CHANNEL" },
  container: { channel_id: "C000CHANNEL", message_ts: "1700000000.000100" },
  message: { ts: "1700000000.000100" },
  actions: [{ action_id: "demo_hook", value: "42" }],
};

describe("extractActionHookContext", () => {
  it("extracts value, presser and location from a root-message press", () => {
    expect(extractActionHookContext("demo_hook", rootPress)).toEqual({
      actionId: "demo_hook",
      value: "42",
      userId: "U000PRESSER",
      channel: "C000CHANNEL",
      messageTs: "1700000000.000100",
      threadTs: "1700000000.000100",
    });
  });

  it("uses the thread root ts for a press inside a thread", () => {
    const ctx = extractActionHookContext("demo_hook", {
      ...rootPress,
      message: { ts: "1700000000.000200", thread_ts: "1700000000.000100" },
    });
    expect(ctx.messageTs).toBe("1700000000.000200");
    expect(ctx.threadTs).toBe("1700000000.000100");
  });

  it("falls back to the container and tolerates missing fields", () => {
    const ctx = extractActionHookContext("demo_hook", {
      container: { channel_id: "C1", message_ts: "1.2" },
      actions: [{}],
    });
    expect(ctx).toEqual({ actionId: "demo_hook", value: "", userId: undefined, channel: "C1", messageTs: "1.2", threadTs: "1.2" });
    expect(extractActionHookContext("x", undefined).value).toBe("");
  });
});

describe("buildActionHookEnv", () => {
  it("adds the press context and keeps the inherited environment", () => {
    const env = buildActionHookEnv(extractActionHookContext("demo_hook", rootPress), { PATH: "/usr/bin", HOME: "/home/x" });
    expect(env).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/x",
      BANTO_ACTION_ID: "demo_hook",
      BANTO_ACTION_USER_ID: "U000PRESSER",
      BANTO_ACTION_CHANNEL: "C000CHANNEL",
      BANTO_ACTION_MESSAGE_TS: "1700000000.000100",
      BANTO_ACTION_THREAD_TS: "1700000000.000100",
    });
  });

  it("drops stale inherited BANTO_ACTION_* and omits unknown fields", () => {
    const env = buildActionHookEnv(
      { actionId: "demo_hook", value: "1" },
      { PATH: "/bin", BANTO_ACTION_USER_ID: "U_STALE", BANTO_ACTION_CHANNEL: "C_STALE" },
    );
    expect(env.BANTO_ACTION_USER_ID).toBeUndefined();
    expect(env.BANTO_ACTION_CHANNEL).toBeUndefined();
    expect(env.BANTO_ACTION_ID).toBe("demo_hook");
    expect(env.PATH).toBe("/bin");
  });

  it("reaches a spawned process while argv stays [...args, value]", async () => {
    const ctx = extractActionHookContext("demo_hook", rootPress);
    const script =
      "process.stdout.write(JSON.stringify({argv: process.argv.slice(1), user: process.env.BANTO_ACTION_USER_ID, thread: process.env.BANTO_ACTION_THREAD_TS}))";
    const child = spawn(process.execPath, ["-e", script, "accept", ctx.value], { env: buildActionHookEnv(ctx) });
    let out = "";
    child.stdout.on("data", (d) => { out += d.toString(); });
    await new Promise((resolve) => child.on("close", resolve));
    expect(JSON.parse(out)).toEqual({ argv: ["accept", "42"], user: "U000PRESSER", thread: "1700000000.000100" });
  });
});
