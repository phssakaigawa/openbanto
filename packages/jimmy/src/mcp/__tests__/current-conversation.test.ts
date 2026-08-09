import { describe, expect, it } from "vitest";
import { currentConversationFromEnv, isSendToCurrentConversation } from "../current-conversation.js";

describe("current conversation send guard", () => {
  const current = {
    connector: "slack",
    channel: "C123",
    thread: "1700000000.000100",
  };

  it("blocks sends to the same connector, channel, and thread", () => {
    expect(isSendToCurrentConversation({
      connector: "slack",
      channel: "C123",
      thread: "1700000000.000100",
    }, current)).toBe(true);
  });

  it("blocks root sends to the current channel", () => {
    expect(isSendToCurrentConversation({
      connector: "slack",
      channel: "C123",
    }, current)).toBe(true);
  });

  it("allows sends to another thread in the same channel", () => {
    expect(isSendToCurrentConversation({
      connector: "slack",
      channel: "C123",
      thread: "1700009999.000100",
    }, current)).toBe(false);
  });

  it("allows sends to another connector or channel", () => {
    expect(isSendToCurrentConversation({
      connector: "discord",
      channel: "C123",
      thread: "1700000000.000100",
    }, current)).toBe(false);
    expect(isSendToCurrentConversation({
      connector: "slack",
      channel: "C999",
      thread: "1700000000.000100",
    }, current)).toBe(false);
  });

  it("defaults omitted connector to slack for the gateway MCP tool", () => {
    expect(isSendToCurrentConversation({
      channel: "C123",
      thread: "1700000000.000100",
    }, current)).toBe(true);
  });

  it("reads current conversation from environment", () => {
    expect(currentConversationFromEnv({
      JINN_CURRENT_CONNECTOR: " slack ",
      JINN_CURRENT_CHANNEL: " C123 ",
      JINN_CURRENT_THREAD: " 1700000000.000100 ",
    })).toEqual(current);
  });
});
