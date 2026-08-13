// Self-restart of the running gateway (WebUI "Banto を再起動" — admin only).
//
// The banto daemon runs under a systemd (user) unit `getworks-banto` with
// `Restart=always`. That is the load-bearing fact: if this process exits (or is
// SIGTERM'd), systemd brings it straight back up. So a "restart" here is simply
// a *self-terminate* — we do NOT shell out to `systemctl` (no execFile, no
// privileged call), we just deliver SIGTERM to our OWN pid. lifecycle.ts's
// SIGTERM handler ("Shutting down gateway...") then runs the existing graceful
// shutdown (engines killAll, connectors stop, sessions marked interrupted, HTTP
// server closed) and process.exit(0)s, at which point systemd restarts us.
//
// The HTTP route (POST /api/admin/restart in gateway/api.ts) is gated by the
// SAME requirePluginAdmin() used for every /api/plugins* route and audited via
// auditPluginAction(). This module owns only the mechanics: single-flight guard
// + a short delay so the 200 JSON response is flushed to the client before the
// process goes down.
import { logger } from "../shared/logger.js";

/** Module-scoped single-flight guard: once a restart is armed we refuse to arm
 *  a second one (rapid double-click / concurrent admins). Never reset — the
 *  process is about to die anyway; a fresh boot starts with it false. */
let restarting = false;

/** True once {@link armSelfRestart} has scheduled a self-terminate. */
export function isRestarting(): boolean {
  return restarting;
}

/** Test-only: reset the single-flight guard between unit tests. */
export function __resetRestartingForTests(): void {
  restarting = false;
}

export interface ArmRestartOptions {
  /** Delay before delivering the signal, so the HTTP 200 can flush first. */
  delayMs?: number;
  /** Injectable for tests — defaults to process.kill(process.pid, "SIGTERM").
   *  In production this drives lifecycle.ts's graceful shutdown, which then
   *  process.exit(0)s; systemd (Restart=always) restarts us. */
  kill?: (pid: number, signal: NodeJS.Signals) => void;
  /** Injectable for tests — the pid to signal (defaults to process.pid). */
  pid?: number;
}

export interface ArmRestartResult {
  /** True if this call armed the restart; false if one was already in flight. */
  armed: boolean;
  /** True when a restart was ALREADY in flight (caller returns 409 / already). */
  already: boolean;
}

/**
 * Arm a self-restart: schedule a SIGTERM to our own process after `delayMs`
 * (default 700ms) so the caller's 200 response flushes first. Idempotent —
 * a second call while one is in flight returns `{ armed:false, already:true }`
 * and schedules nothing. Pure w.r.t. the injectable `kill`/`pid` so unit tests
 * never actually terminate the test runner.
 */
export function armSelfRestart(opts: ArmRestartOptions = {}): ArmRestartResult {
  if (restarting) {
    return { armed: false, already: true };
  }
  restarting = true;

  const delayMs = opts.delayMs ?? 700;
  const pid = opts.pid ?? process.pid;
  const kill = opts.kill ?? ((p, sig) => process.kill(p, sig));

  logger.info(`[self-restart] armed — delivering SIGTERM to pid ${pid} in ${delayMs}ms (systemd Restart=always will restart)`);

  const timer = setTimeout(() => {
    try {
      // Graceful path: lifecycle.ts's SIGTERM handler runs the existing cleanup
      // and process.exit(0)s. A backstop force-timer there guards against hangs.
      kill(pid, "SIGTERM");
    } catch (err) {
      logger.error(`[self-restart] SIGTERM failed: ${err instanceof Error ? err.message : err}`);
    }
  }, delayMs);
  // Don't let the pending timer keep the event loop alive on its own.
  if (typeof timer.unref === "function") timer.unref();

  return { armed: true, already: false };
}
