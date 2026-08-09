import test from "node:test";
import assert from "node:assert/strict";
import { buildReplyContext, deriveSessionKey, isOldSlackMessage } from "./threads.js";

test("deriveSessionKey keeps DM sessions per user", () => {
  const key = deriveSessionKey({
    channel: "D123",
    user: "U123",
    channel_type: "im",
    ts: "1700000000.000100",
  });
  assert.equal(key, "slack:dm:U123");
});

test("deriveSessionKey uses ts for channel root messages", () => {
  const key = deriveSessionKey({
    channel: "C123",
    user: "U123",
    ts: "1700000000.000100",
  });
  assert.equal(key, "slack:C123:1700000000.000100");
});

test("deriveSessionKey uses thread_ts for thread replies (matches root)", () => {
  const key = deriveSessionKey({
    channel: "C123",
    user: "U123",
    ts: "1700000100.000200",
    thread_ts: "1700000000.000100",
  });
  assert.equal(key, "slack:C123:1700000000.000100");
});

test("deriveSessionKey treats same-ts thread_ts as root message", () => {
  const key = deriveSessionKey({
    channel: "C123",
    user: "U123",
    ts: "1700000000.000100",
    thread_ts: "1700000000.000100",
  });
  assert.equal(key, "slack:C123:1700000000.000100");
});

test("buildReplyContext sets thread for channel root messages", () => {
  const context = buildReplyContext({
    channel: "C123",
    ts: "1700000000.000100",
    channel_type: "channel",
  });
  assert.deepEqual(context, {
    channel: "C123",
    thread: "1700000000.000100",
    messageTs: "1700000000.000100",
  });
});

test("buildReplyContext sets thread_ts for thread replies", () => {
  const context = buildReplyContext({
    channel: "C123",
    ts: "1700000100.000200",
    thread_ts: "1700000000.000100",
  });
  assert.deepEqual(context, {
    channel: "C123",
    thread: "1700000000.000100",
    messageTs: "1700000100.000200",
  });
});

test("buildReplyContext does NOT set thread for DMs", () => {
  const context = buildReplyContext({
    channel: "D123",
    ts: "1700000000.000100",
    channel_type: "im",
  });
  assert.deepEqual(context, {
    channel: "D123",
    thread: null,
    messageTs: "1700000000.000100",
  });
});

test("isOldSlackMessage compares against boot time", () => {
  assert.equal(isOldSlackMessage("1700000000.000100", 1700000001000), true);
  assert.equal(isOldSlackMessage("1700000002.000100", 1700000001000), false);
});
