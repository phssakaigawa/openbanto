import { describe, it, expect } from "vitest";
import {
  scopeForChannelType,
  resolveRespondMode,
  evaluateRespondPolicy,
  hasMentionScope,
  respondPolicyNeedsTracking,
} from "../respond-policy.js";
import type { SlackRespondToConfig } from "../../../shared/types.js";

describe("scopeForChannelType", () => {
  it("maps im to im", () => {
    expect(scopeForChannelType("im")).toBe("im");
  });

  it("maps mpim to mpim", () => {
    expect(scopeForChannelType("mpim")).toBe("mpim");
  });

  it("maps channel to channel", () => {
    expect(scopeForChannelType("channel")).toBe("channel");
  });

  it("maps legacy private-channel type 'group' to channel", () => {
    expect(scopeForChannelType("group")).toBe("channel");
  });

  it("maps unknown/undefined to channel (safe default)", () => {
    expect(scopeForChannelType(undefined)).toBe("channel");
    expect(scopeForChannelType("something-new")).toBe("channel");
  });
});

describe("resolveRespondMode", () => {
  it("defaults every scope to always when config is absent", () => {
    expect(resolveRespondMode(undefined, "im")).toBe("always");
    expect(resolveRespondMode(undefined, "mpim")).toBe("always");
    expect(resolveRespondMode(undefined, "channel")).toBe("always");
  });

  it("defaults unset scopes to always when config is partial", () => {
    const config: SlackRespondToConfig = { channel: "mention" };
    expect(resolveRespondMode(config, "im")).toBe("always");
    expect(resolveRespondMode(config, "mpim")).toBe("always");
    expect(resolveRespondMode(config, "channel")).toBe("mention");
  });

  it("treats invalid values as always (config files are untyped YAML)", () => {
    const config = { channel: "sometimes" } as unknown as SlackRespondToConfig;
    expect(resolveRespondMode(config, "channel")).toBe("always");
  });
});

describe("evaluateRespondPolicy", () => {
  const mentionOnly: SlackRespondToConfig = {
    im: "always",
    mpim: "mention",
    channel: "mention",
  };

  it("allows everything when config is absent (legacy behavior)", () => {
    expect(
      evaluateRespondPolicy({
        config: undefined,
        channelType: "channel",
        wasMentioned: false,
        isEngagedThread: false,
      }).allow,
    ).toBe(true);
  });

  it("allows DMs without a mention under the mention-only config", () => {
    expect(
      evaluateRespondPolicy({
        config: mentionOnly,
        channelType: "im",
        wasMentioned: false,
        isEngagedThread: false,
      }).allow,
    ).toBe(true);
  });

  it("drops un-mentioned channel messages", () => {
    const decision = evaluateRespondPolicy({
      config: mentionOnly,
      channelType: "channel",
      wasMentioned: false,
      isEngagedThread: false,
    });
    expect(decision.allow).toBe(false);
    if (!decision.allow) expect(decision.reason).toContain("channel=mention");
  });

  it("drops un-mentioned group-DM (mpim) messages", () => {
    expect(
      evaluateRespondPolicy({
        config: mentionOnly,
        channelType: "mpim",
        wasMentioned: false,
        isEngagedThread: false,
      }).allow,
    ).toBe(false);
  });

  it("allows @-mentioned channel messages", () => {
    expect(
      evaluateRespondPolicy({
        config: mentionOnly,
        channelType: "channel",
        wasMentioned: true,
        isEngagedThread: false,
      }).allow,
    ).toBe(true);
  });

  it("allows un-mentioned follow-ups inside a bot-engaged thread by default", () => {
    expect(
      evaluateRespondPolicy({
        config: mentionOnly,
        channelType: "channel",
        wasMentioned: false,
        isEngagedThread: true,
      }).allow,
    ).toBe(true);
  });

  it("drops engaged-thread follow-ups when engagedThreads is false", () => {
    expect(
      evaluateRespondPolicy({
        config: { ...mentionOnly, engagedThreads: false },
        channelType: "channel",
        wasMentioned: false,
        isEngagedThread: true,
      }).allow,
    ).toBe(false);
  });

  it("treats legacy private-channel type 'group' under the channel scope", () => {
    expect(
      evaluateRespondPolicy({
        config: mentionOnly,
        channelType: "group",
        wasMentioned: false,
        isEngagedThread: false,
      }).allow,
    ).toBe(false);
  });

  it("drops everything in a never scope, even mentions", () => {
    expect(
      evaluateRespondPolicy({
        config: { channel: "never" },
        channelType: "channel",
        wasMentioned: true,
        isEngagedThread: true,
      }).allow,
    ).toBe(false);
  });
});

describe("hasMentionScope / respondPolicyNeedsTracking", () => {
  it("is false when config is absent", () => {
    expect(hasMentionScope(undefined)).toBe(false);
    expect(respondPolicyNeedsTracking(undefined)).toBe(false);
  });

  it("is false when no scope uses mention", () => {
    expect(hasMentionScope({ im: "always", channel: "never" })).toBe(false);
  });

  it("is true when any scope uses mention", () => {
    expect(hasMentionScope({ channel: "mention" })).toBe(true);
    expect(hasMentionScope({ mpim: "mention" })).toBe(true);
  });

  it("needs tracking only when engaged-thread continuation is on", () => {
    expect(respondPolicyNeedsTracking({ channel: "mention" })).toBe(true);
    expect(respondPolicyNeedsTracking({ channel: "mention", engagedThreads: false })).toBe(false);
  });
});
