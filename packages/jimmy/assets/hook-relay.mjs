#!/usr/bin/env node
// OpenBanto hook relay. Invoked by Claude Code hooks as: node hook-relay.mjs <jinnSessionId>
// Reads hook JSON on stdin, POSTs to the gateway's /api/internal/hook. Always exits 0.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const jinnSessionId = process.argv[2];

/** Mirror shared/paths.ts resolveHome() precedence so the relay finds the same
 *  ~/.openbanto (or legacy ~/.jinn) the gateway wrote gateway.json into. Kept inline:
 *  the relay runs in Claude's hook process, separate from the gateway bundle. */
function resolveHome() {
  if (process.env.RYOKO_HOME) return process.env.RYOKO_HOME;
  if (process.env.JINN_HOME) return process.env.JINN_HOME;
  const instance = process.env.RYOKO_INSTANCE || process.env.JINN_INSTANCE;
  if (instance) return path.join(os.homedir(), `.${instance}`);
  const ryokoHome = path.join(os.homedir(), ".ryoko");
  const jinnHome = path.join(os.homedir(), ".jinn");
  if (fs.existsSync(ryokoHome)) return ryokoHome;
  if (fs.existsSync(jinnHome)) return jinnHome;
  return ryokoHome;
}

const JINN_HOME = resolveHome();

function logBestEffort(err) {
  // Best-effort diagnostic log. Never throws — silent failure here is OK
  // because we'd rather lose a log line than block the TUI on exit.
  try {
    const line = `${new Date().toISOString()} ${err?.message ?? err}\n`;
    fs.appendFileSync(path.join(JINN_HOME, "hook-relay.log"), line);
  } catch {}
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let payload;
  try { payload = JSON.parse(raw); } catch (err) { logBestEffort(err); return; }

  let info;
  try { info = JSON.parse(fs.readFileSync(path.join(JINN_HOME, "gateway.json"), "utf-8")); } catch (err) { logBestEffort(err); return; }

  const body = JSON.stringify({ jinnSessionId, hook: payload });
  await fetch(`http://127.0.0.1:${info.port}/api/internal/hook`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-jinn-hook-secret": info.secret },
    body,
  }).catch((err) => { logBestEffort(err); });
}

main().catch((err) => { logBestEffort(err); }).finally(() => process.exit(0));
