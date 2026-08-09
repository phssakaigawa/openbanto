import { spawn, type ChildProcess } from "node:child_process";
import type { InterruptibleEngine, EngineRunOpts, EngineResult } from "../shared/types.js";
import { logger } from "../shared/logger.js";
import { resolveBin, formatSpawnError } from "../shared/resolveBin.js";
import { buildChildEnv } from "../shared/childEnv.js";

interface LiveProcess {
  proc: ChildProcess;
  terminationReason: string | null;
}

/**
 * IBM Bob Shell engine (`bob run`).
 *
 * First-cut implementation uses the single-blob `--format json` output rather
 * than `--format stream-json`: `bob run` emits one JSON object on stdout whose
 * `last_message` is the final answer and whose `stats`/`task_id` carry usage and
 * the resumable task id. This is enough for a working colleague (reply at end of
 * turn); incremental token streaming via `stream-json` can be layered on later
 * once the event schema is confirmed against a live key.
 *
 * Auth: `bob` reads `BOB_API_KEY` from the environment (an Inference-type key
 * needs no team id; a General-type key needs `--team-id`, which can be supplied
 * via `engines.bob` cliFlags). We deliberately do NOT strip BOB_* from the child
 * env so the key propagates.
 */
export class BobEngine implements InterruptibleEngine {
  name = "bob" as const;
  private liveProcesses = new Map<string, LiveProcess>();

  kill(sessionId: string, reason = "Interrupted"): void {
    const live = this.liveProcesses.get(sessionId);
    if (!live) return;

    live.terminationReason = reason;
    logger.info(`Killing Bob process for session ${sessionId}`);
    this.signalProcess(live.proc, "SIGTERM");
    setTimeout(() => {
      if (live.proc.exitCode === null) {
        this.signalProcess(live.proc, "SIGKILL");
      }
    }, 2000);
  }

  killAll(): void {
    for (const sessionId of this.liveProcesses.keys()) {
      this.kill(sessionId, "Interrupted: gateway shutting down");
    }
  }

  isAlive(sessionId: string): boolean {
    const live = this.liveProcesses.get(sessionId);
    return !!live && !live.proc.killed && live.proc.exitCode === null;
  }

  async run(opts: EngineRunOpts): Promise<EngineResult> {
    let prompt = opts.prompt;
    if (opts.systemPrompt) {
      prompt = opts.systemPrompt + "\n\n---\n\n" + prompt;
    }
    if (opts.attachments?.length) {
      prompt += "\n\nAttached files:\n" + opts.attachments.map((a) => `- ${a}`).join("\n");
    }

    const requestedBin = opts.bin || "bob";
    const bin = resolveBin(requestedBin);
    const isResume = !!opts.resumeSessionId;
    const args = this.buildArgs(opts, prompt);

    logger.info(
      `Bob engine starting: ${bin} run${isResume ? ` (resume ${opts.resumeSessionId})` : ""} (workspace: ${opts.cwd || "cwd"})`,
    );

    // Keep BOB_* in the child env so BOB_API_KEY reaches the CLI.
    const cleanEnv = buildChildEnv();

    return new Promise((resolve, reject) => {
      const proc = spawn(bin, args, {
        cwd: opts.cwd,
        env: cleanEnv,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });

      const sessionId = opts.sessionId || `bob-${opts.resumeSessionId || "new"}`;
      this.liveProcesses.set(sessionId, { proc, terminationReason: null });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const onStream = opts.onStream || null;
      const STDERR_MAX = 10 * 1024;

      // Surface an immediate "working" indicator; the real text arrives at close
      // because `--format json` is a single terminal blob (not a token stream).
      if (onStream) onStream({ type: "status", content: "Bob is working…" });

      proc.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });

      proc.stderr.on("data", (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;
        if (stderr.length > STDERR_MAX) stderr = stderr.slice(stderr.length - STDERR_MAX);
        for (const line of chunk.trim().split("\n").filter(Boolean)) {
          logger.debug(`[bob stderr] ${line}`);
        }
      });

      // `bob run` hangs waiting on stdin if it stays open — close it immediately.
      proc.stdin.end();

      proc.on("close", (code) => {
        if (settled) return;
        settled = true;

        const terminationReason = this.liveProcesses.get(sessionId)?.terminationReason ?? null;
        this.liveProcesses.delete(sessionId);

        const parsed = this.parseResult(stdout);
        const resultText = parsed.text;
        const taskId = parsed.taskId || opts.resumeSessionId || "";

        logger.info(
          `Bob engine exited with code ${code} (task: ${taskId || "none"}, cost: ${parsed.cost ?? "n/a"})`,
        );

        if (resultText && onStream) onStream({ type: "text", content: resultText });

        if (terminationReason) {
          resolve({
            sessionId: taskId,
            result: resultText,
            error: terminationReason,
            ...(typeof parsed.cost === "number" ? { cost: parsed.cost } : {}),
            ...(typeof parsed.durationMs === "number" ? { durationMs: parsed.durationMs } : {}),
          });
          return;
        }

        if (parsed.isError) {
          const errMsg = resultText || `Bob reported an error (exit ${code})`;
          logger.error(`[bob] ${errMsg}`);
          resolve({ sessionId: taskId, result: resultText, error: errMsg });
          return;
        }

        if (code === 0 || (code !== null && resultText)) {
          resolve({
            sessionId: taskId,
            result: resultText,
            ...(typeof parsed.cost === "number" ? { cost: parsed.cost } : {}),
            ...(typeof parsed.durationMs === "number" ? { durationMs: parsed.durationMs } : {}),
          });
          return;
        }

        const errMsg = `Bob exited with code ${code}: ${stderr.slice(0, 500)}`;
        logger.error(errMsg);
        resolve({ sessionId: taskId, result: resultText, error: errMsg });
      });

      proc.on("error", (err) => {
        if (settled) return;
        settled = true;
        this.liveProcesses.delete(sessionId);
        const errMsg = formatSpawnError("IBM Bob CLI", requestedBin, err);
        logger.error(errMsg);
        opts.onStream?.({ type: "error", content: errMsg });
        reject(new Error(errMsg));
      });
    });
  }

  private buildArgs(opts: EngineRunOpts, prompt: string): string[] {
    const args = ["run"];
    if (opts.resumeSessionId) args.push("--resume", opts.resumeSessionId);
    args.push("--format", "json");
    // Trust the workspace so a daemon run never blocks on an interactive prompt.
    args.push("--trust");
    if (opts.cwd) args.push("--workspace", opts.cwd);
    // `bob run` has no --model flag (model is bound to the team/API key).
    if (opts.cliFlags?.length) args.push(...opts.cliFlags);
    args.push(prompt);
    return args;
  }

  /** Parse the single JSON blob from `bob run --format json`. Defensive: any
   *  shape mismatch degrades to raw stdout text so a reply is always produced. */
  private parseResult(stdout: string): {
    text: string;
    taskId: string;
    cost?: number;
    durationMs?: number;
    isError: boolean;
  } {
    const trimmed = stdout.trim();
    if (!trimmed) return { text: "", taskId: "", isError: false };
    try {
      const out = JSON.parse(trimmed) as Record<string, any>;
      const stats = (out.stats ?? {}) as Record<string, any>;
      const text = typeof out.last_message === "string" ? out.last_message : "";
      const taskId = String(out.task_id ?? stats.task_id ?? "");
      const cost = typeof stats.session_costs === "number" ? stats.session_costs : undefined;
      const durationMs = typeof stats.duration_ms === "number" ? stats.duration_ms : undefined;
      const isError = out.status === "error";
      return { text: text || (isError ? String(out.error ?? "") : ""), taskId, cost, durationMs, isError };
    } catch {
      logger.debug(`[bob] non-JSON stdout: ${trimmed.slice(0, 120)}`);
      return { text: trimmed, taskId: "", isError: false };
    }
  }

  private signalProcess(proc: ChildProcess, signal: NodeJS.Signals): void {
    if (proc.exitCode !== null) return;
    try {
      if (process.platform !== "win32" && proc.pid) {
        process.kill(-proc.pid, signal);
      } else {
        proc.kill(signal);
      }
    } catch (err) {
      logger.debug(`Failed to send ${signal} to Bob process: ${err instanceof Error ? err.message : err}`);
    }
  }
}
