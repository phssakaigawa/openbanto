import { execSync, execFileSync, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PID_FILE, JINN_HOME } from "../shared/paths.js";
import { logger } from "../shared/logger.js";
import type { JinnConfig } from "../shared/types.js";
import { startGateway } from "./server.js";
import { loadConfig } from "../shared/config.js";

export async function startForeground(config: JinnConfig): Promise<void> {
  const cleanup = await startGateway(config);

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      logger.info("Forced exit");
      process.exit(1);
    }
    shuttingDown = true;
    logger.info("Shutting down gateway...");

    // Force exit if graceful shutdown takes too long
    const forceTimer = setTimeout(() => {
      logger.warn("Graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, 5000);
    forceTimer.unref();

    await cleanup();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

export function startDaemon(config: JinnConfig): void {
  const __filename = fileURLToPath(import.meta.url);
  const candidateEntryScripts = [
    // When running from a built bundle, __filename is dist/src/gateway/lifecycle.js
    path.resolve(path.dirname(__filename), "daemon-entry.js"),
    // Fallback for unusual layouts
    path.resolve(path.dirname(__filename), "..", "..", "dist", "src", "gateway", "daemon-entry.js"),
  ];
  const entryScript = candidateEntryScripts.find((p) => fs.existsSync(p)) ?? candidateEntryScripts[0];

  // Fork a child process that will run the gateway
  const child = fork(entryScript, [], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, JINN_HOME },
  });

  if (child.pid) {
    fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
    fs.writeFileSync(PID_FILE, String(child.pid));
    logger.info(`Gateway daemon started with PID ${child.pid}`);
  }

  child.disconnect();
  child.unref();
}

export function stop(port?: number): boolean {
  // Try PID file first
  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);

    try {
      process.kill(pid, "SIGTERM");
      logger.info(`Sent SIGTERM to gateway process ${pid}`);
      fs.unlinkSync(PID_FILE);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        logger.warn(`Process ${pid} not found. Cleaning up stale PID file.`);
        fs.unlinkSync(PID_FILE);
      } else {
        throw err;
      }
    }
    // PID file existed but was stale; fall through to kill by port.
  }

  // No PID file — try to kill whatever is listening on the port
  const targetPort = port ?? resolvePort();
  const pid = findPidOnPort(targetPort);
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      logger.info(`Killed process ${pid} on port ${targetPort}`);
      return true;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH") {
        logger.warn(`Process ${pid} already gone.`);
        return true;
      }
      throw err;
    }
  }

  logger.warn(`No PID file found and nothing listening on port ${targetPort}.`);
  return false;
}

function resolvePort(): number {
  try {
    const config = loadConfig();
    return config.gateway?.port || 7777;
  } catch {
    return 7777;
  }
}

function findPidOnPort(port: number): number | null {
  try {
    if (process.platform === "win32") {
      const output = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: "utf-8" }).trim();
      if (!output) return null;
      // netstat output: proto  local_addr  foreign_addr  state  PID
      const parts = output.split("\n")[0].trim().split(/\s+/);
      const pid = parseInt(parts[parts.length - 1], 10);
      return isNaN(pid) ? null : pid;
    } else {
      const output = execSync(
        process.platform === "darwin"
          ? `/usr/sbin/lsof -ti tcp:${port}`
          : `lsof -ti tcp:${port}`,
        { encoding: "utf-8" },
      ).trim();
      if (!output) return null;
      const pid = parseInt(output.split("\n")[0], 10);
      return isNaN(pid) ? null : pid;
    }
  } catch {
    return null;
  }
}

/**
 * Default systemd unit name (see scripts/systemd/openbanto.service).
 * Override with the RYOKO_SERVICE env var or an explicit argument when the
 * deployment uses a different unit name (e.g. a per-instance unit).
 */
const DEFAULT_SERVICE = "openbanto";

export type RestartMethod =
  | "systemd-user"
  | "systemd-system"
  | "daemon"
  | "none";

export interface RestartResult {
  method: RestartMethod;
  /** systemd unit name, when a systemd method was used. */
  service?: string;
  /** Human-readable note (e.g. "via sudo", "permission denied"). */
  detail?: string;
}

function hasSystemctl(): boolean {
  if (process.platform !== "linux") return false;
  try {
    execFileSync("systemctl", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether `systemctl [scope] is-active <service>` reports the unit as active.
 * `is-active` exits non-zero for inactive units, so the state is read from
 * stdout in both the success and error paths.
 */
function systemctlActive(scopeArgs: string[], service: string): boolean {
  try {
    const out = execFileSync("systemctl", [...scopeArgs, "is-active", service], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.trim() === "active";
  } catch (err) {
    const stdout = (err as { stdout?: Buffer | string }).stdout;
    return stdout?.toString().trim() === "active";
  }
}

/**
 * Restart the running gateway after a CLI update so the new code takes effect.
 *
 * Detection order:
 *   1. systemd --user unit (privilege-free)
 *   2. systemd system unit (falls back to `sudo -n` if direct restart is denied)
 *   3. plain forked daemon (PID file / port) — stop + re-fork
 *
 * Returns how the restart was performed. `{ method: "none" }` means nothing
 * was running, so nothing was restarted.
 */
export function restartGateway(serviceName?: string): RestartResult {
  const service = serviceName || process.env.OPENBANTO_SERVICE || process.env.RYOKO_SERVICE || DEFAULT_SERVICE;

  if (hasSystemctl()) {
    if (systemctlActive(["--user"], service)) {
      execFileSync("systemctl", ["--user", "restart", service], { stdio: "inherit" });
      return { method: "systemd-user", service };
    }
    if (systemctlActive([], service)) {
      try {
        execFileSync("systemctl", ["restart", service], { stdio: "inherit" });
        return { method: "systemd-system", service };
      } catch {
        try {
          execFileSync("sudo", ["-n", "systemctl", "restart", service], { stdio: "inherit" });
          return { method: "systemd-system", service, detail: "via sudo" };
        } catch {
          return { method: "systemd-system", service, detail: "permission denied" };
        }
      }
    }
  }

  // Fallback: plain forked daemon managed via PID file / port.
  if (getStatus().running) {
    stop();
    startDaemon(loadConfig());
    return { method: "daemon" };
  }

  return { method: "none" };
}

export interface GatewayStatus {
  running: boolean;
  pid: number | null;
}

export function getStatus(): GatewayStatus {
  const targetPort = resolvePort();

  if (fs.existsSync(PID_FILE)) {
    const pid = parseInt(fs.readFileSync(PID_FILE, "utf-8").trim(), 10);
    try {
      process.kill(pid, 0);
      return { running: true, pid };
    } catch {
      // Process not alive, stale PID file — fall back to port check.
      const portPid = findPidOnPort(targetPort);
      if (portPid) return { running: true, pid: portPid };
      return { running: false, pid };
    }
  }

  const portPid = findPidOnPort(targetPort);
  if (portPid) return { running: true, pid: portPid };
  return { running: false, pid: null };
}
