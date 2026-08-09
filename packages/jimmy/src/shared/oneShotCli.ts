import { spawn } from "node:child_process";
import { resolveBin, formatSpawnError } from "./resolveBin.js";
import { buildChildEnv } from "./childEnv.js";

export type OneShotEngine = "claude" | "codex" | "bob";

export interface OneShotOptions {
  engine?: OneShotEngine;
  bin: string;
  model: string;
  timeoutMs: number;
  spawnFn?: typeof spawn;
  label: string;
}

export function defaultBinForEngine(engine: OneShotEngine): string {
  if (engine === "bob") return "bob";
  return engine === "codex" ? "codex" : "claude";
}

export function defaultModelForEngine(engine: OneShotEngine): string {
  // IBM Bob binds the model to the team / API key; `bob run` has no --model flag.
  if (engine === "bob") return "";
  return engine === "codex" ? "gpt-5-nano" : "claude-haiku-4-5";
}

export async function invokeOneShot(prompt: string, opts: OneShotOptions): Promise<string> {
  const engine = opts.engine ?? "claude";
  return new Promise((resolve, reject) => {
    const args = buildArgs(engine, opts.model, prompt);
    const resolvedBin = resolveBin(opts.bin);
    const proc = (opts.spawnFn ?? spawn)(resolvedBin, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: buildChildEnv(),
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill("SIGTERM");
      } catch { /* ignore */ }
      reject(new Error(`${opts.label} timed out after ${opts.timeoutMs}ms`));
    }, opts.timeoutMs);

    proc.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(formatSpawnError(`${opts.label} CLI`, opts.bin, err)));
    });

    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`${engine} exited ${code}: ${stderr.slice(0, 500)}`));
        return;
      }
      if (engine === "bob") {
        resolve(extractBobResult(stdout));
        return;
      }
      resolve(engine === "codex" ? extractCodexResult(stdout) : extractClaudeResult(stdout));
    });
  });
}

function buildArgs(engine: OneShotEngine, model: string, prompt: string): string[] {
  if (engine === "bob") {
    // `bob run --format json <prompt>` — single JSON blob on stdout.
    // No --model flag (model is bound to the team/API key). stdio stdin is
    // "ignore" above, so bob won't hang waiting on stdin.
    return ["run", "--format", "json", prompt];
  }
  if (engine === "codex") {
    return [
      "exec",
      "--json",
      "--color",
      "never",
      "--model",
      model,
      "--dangerously-bypass-approvals-and-sandbox",
      "--skip-git-repo-check",
      prompt,
    ];
  }
  return [
    "-p",
    "--output-format",
    "json",
    "--model",
    model,
    "--dangerously-skip-permissions",
    prompt,
  ];
}

function extractClaudeResult(stdout: string): string {
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.result === "string") {
      return parsed.result;
    }
  } catch { /* fall through */ }
  return trimmed;
}

function extractCodexResult(stdout: string): string {
  let text = "";
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const msg = JSON.parse(trimmed) as Record<string, unknown>;
      if (msg.type !== "item.completed") continue;
      const item = msg.item as Record<string, unknown> | undefined;
      if (item?.type !== "agent_message") continue;
      if (typeof item.text === "string") text += item.text;
    } catch { /* ignore non-json lines */ }
  }
  return text || stdout.trim();
}

function extractBobResult(stdout: string): string {
  // `bob run --format json` emits one JSON object; the final answer is
  // `last_message` (verified against the node-red-contrib-ibmbob reference).
  const trimmed = stdout.trim();
  if (!trimmed) return "";
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && typeof parsed.last_message === "string") {
      return parsed.last_message;
    }
  } catch { /* fall through */ }
  return trimmed;
}
