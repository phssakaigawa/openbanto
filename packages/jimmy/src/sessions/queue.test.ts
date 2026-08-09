import test from "node:test";
import assert from "node:assert/strict";
import { SessionQueue } from "./queue.js";

test("SessionQueue tracks queued work behind the active task", async () => {
  const queue = new SessionQueue();
  let releaseFirst: (() => void) | undefined;

  const first = queue.enqueue("slack:C123", async () => {
    await new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
  });

  while (!queue.isRunning("slack:C123")) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  const second = queue.enqueue("slack:C123", async () => {});

  assert.equal(queue.getPendingCount("slack:C123"), 1);
  assert.equal(queue.getTransportState("slack:C123", "running"), "running");

  releaseFirst?.();
  await first;
  await second;

  assert.equal(queue.getPendingCount("slack:C123"), 0);
  assert.equal(queue.getTransportState("slack:C123", "idle"), "idle");
});

test("SessionQueue preserves error transport state", () => {
  const queue = new SessionQueue();
  assert.equal(queue.getTransportState("slack:C123", "error"), "error");
});
