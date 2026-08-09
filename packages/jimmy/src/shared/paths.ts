import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * One-time migration to the OpenBanto home. If no explicit *_HOME/*_INSTANCE
 * override is set and ~/.openbanto doesn't exist yet, rename a legacy home in
 * place — ~/.ryoko (from OpenRyoko) or ~/.jinn (from Jinn) — so existing
 * config/tokens/sessions carry over seamlessly. Runs at module load so every
 * path constant below already points at the migrated location. Any failure is
 * silent — resolveHome() still has a legacy fallback.
 */
function migrateLegacyHome(): void {
  if (process.env.OPENBANTO_HOME || process.env.RYOKO_HOME || process.env.JINN_HOME) return;
  if (process.env.OPENBANTO_INSTANCE || process.env.RYOKO_INSTANCE || process.env.JINN_INSTANCE) return;
  const target = path.join(os.homedir(), ".openbanto");
  if (fs.existsSync(target)) return;
  // Prefer the most recent legacy home: .ryoko (OpenRyoko) then .jinn (Jinn).
  const legacy = [path.join(os.homedir(), ".ryoko"), path.join(os.homedir(), ".jinn")].find((p) =>
    fs.existsSync(p),
  );
  if (!legacy) return;
  try {
    fs.renameSync(legacy, target);
    console.log(`[openbanto] migrated ${legacy} → ${target}`);
  } catch {
    /* leave legacy in place; resolveHome will still find it via fallback */
  }
}

migrateLegacyHome();

/**
 * Resolve the home directory for the current instance.
 * Precedence: OPENBANTO_HOME > RYOKO_HOME > JINN_HOME (legacy) >
 *             *_INSTANCE > ~/.openbanto (falls back to ~/.ryoko then ~/.jinn
 *             if the new home doesn't exist yet).
 */
function resolveHome(): string {
  if (process.env.OPENBANTO_HOME) return process.env.OPENBANTO_HOME;
  if (process.env.RYOKO_HOME) return process.env.RYOKO_HOME;
  if (process.env.JINN_HOME) return process.env.JINN_HOME;
  const instance = process.env.OPENBANTO_INSTANCE || process.env.RYOKO_INSTANCE || process.env.JINN_INSTANCE;
  if (instance) return path.join(os.homedir(), `.${instance}`);
  const openbantoHome = path.join(os.homedir(), ".openbanto");
  const ryokoHome = path.join(os.homedir(), ".ryoko");
  const jinnHome = path.join(os.homedir(), ".jinn");
  if (fs.existsSync(openbantoHome)) return openbantoHome;
  if (fs.existsSync(ryokoHome)) return ryokoHome;
  if (fs.existsSync(jinnHome)) return jinnHome;
  return openbantoHome;
}

/**
 * JINN_HOME is kept as the exported constant NAME for backwards compatibility
 * with all internal callers. The actual value resolves to ~/.openbanto/ on new
 * installs and after the one-time migration above.
 */
export const JINN_HOME = resolveHome();
export const CONFIG_PATH = path.join(JINN_HOME, "config.yaml");
export const SESSIONS_DB = path.join(JINN_HOME, "sessions", "registry.db");
export const CRON_JOBS = path.join(JINN_HOME, "cron", "jobs.json");
export const CRON_RUNS = path.join(JINN_HOME, "cron", "runs");
export const ORG_DIR = path.join(JINN_HOME, "org");
export const SKILLS_DIR = path.join(JINN_HOME, "skills");
export const DOCS_DIR = path.join(JINN_HOME, "docs");
export const LOGS_DIR = path.join(JINN_HOME, "logs");
export const TMP_DIR = path.join(JINN_HOME, "tmp");
export const JOBS_DIR = path.join(JINN_HOME, "jobs");
export const MODELS_DIR = path.join(JINN_HOME, "models");
export const STT_MODELS_DIR = path.join(JINN_HOME, "models", "whisper");
export const PID_FILE = path.join(JINN_HOME, "gateway.pid");
export const CLAUDE_SKILLS_DIR = path.join(JINN_HOME, ".claude", "skills");
export const AGENTS_SKILLS_DIR = path.join(JINN_HOME, ".agents", "skills");
export const TEMPLATE_DIR = path.join(__dirname, "..", "..", "..", "template");
export const FILES_DIR = path.join(JINN_HOME, "files");
export const MIGRATIONS_DIR = path.join(JINN_HOME, "migrations");
export const TEMPLATE_MIGRATIONS_DIR = path.join(TEMPLATE_DIR, "migrations");

// ---- Interactive Claude (PTY) engine: hook-relay + per-session --settings ----
/** Gateway connection info (port + hook secret + pids) for hook-relay discovery. */
export const GATEWAY_INFO_FILE = path.join(JINN_HOME, "gateway.json");
/** Per-session Claude Code --settings files written for PTY turns. */
export const CLAUDE_SETTINGS_DIR = path.join(JINN_HOME, "tmp", "settings");
/** The hook-relay script copied next to JINN_HOME at boot; PTY-spawned Claude
 *  invokes it from its hook config to POST turn events back to the gateway. */
export const HOOK_RELAY_SCRIPT = path.join(JINN_HOME, "hook-relay.mjs");

/**
 * Global instances registry — always at ~/.openbanto/instances.json regardless
 * of which instance is running, so every instance can discover the others.
 * Falls back to a legacy home (~/.ryoko, then ~/.jinn) when only that exists.
 */
export const INSTANCES_REGISTRY = (() => {
  const openbanto = path.join(os.homedir(), ".openbanto", "instances.json");
  const ryoko = path.join(os.homedir(), ".ryoko", "instances.json");
  const jinn = path.join(os.homedir(), ".jinn", "instances.json");
  if (fs.existsSync(path.dirname(openbanto))) return openbanto;
  if (fs.existsSync(path.dirname(ryoko))) return ryoko;
  if (fs.existsSync(path.dirname(jinn))) return jinn;
  return openbanto;
})();
