import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { JINN_HOME } from "../shared/paths.js";
import { getPackageVersion } from "../shared/version.js";

const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

function run(command: string, args: string[]): void {
  execFileSync(command, args, {
    stdio: "inherit",
    env: process.env,
  });
}

function buildBantoArgs(args: string[]): string[] {
  const instance = process.env.RYOKO_INSTANCE;
  return instance ? ["-i", instance, ...args] : args;
}

export async function runUpdate(opts: {
  noMigrate?: boolean;
  restart?: boolean;
  service?: string;
}): Promise<void> {
  const currentVersion = getPackageVersion();

  console.log(`\n${DIM}Current CLI version:${RESET} ${currentVersion}`);
  console.log(`${YELLOW}Updating OpenBanto CLI from npm...${RESET}\n`);

  try {
    run("npm", ["install", "-g", "openbanto@latest"]);
  } catch {
    console.error(`\n${RED}Update failed.${RESET}`);
    console.error(`Try running manually: ${DIM}npm install -g openbanto@latest${RESET}\n`);
    process.exit(1);
  }

  if (!opts.noMigrate && fs.existsSync(JINN_HOME)) {
    console.log(`\n${YELLOW}Applying instance migrations...${RESET}\n`);
    try {
      run("ryoko", buildBantoArgs(["migrate", "--auto"]));
    } catch {
      console.error(`\n${RED}Migration failed.${RESET}`);
      console.error(`The CLI update succeeded. Retry migrations with: ${DIM}ryoko migrate --auto${RESET}\n`);
      process.exit(1);
    }
  } else if (!opts.noMigrate) {
    console.log(`\n${YELLOW}No instance found at ${JINN_HOME}.${RESET} Skipping migrations.`);
    console.log(`Run ${DIM}ryoko setup${RESET} to create one.\n`);
  }

  // Offer the interactive (PTY, Max-subsidized) engine on first update after it
  // became available — only in a TTY, only when the user hasn't decided yet.
  // Must run BEFORE the restart so the choice is picked up by the new gateway.
  if (fs.existsSync(JINN_HOME)) {
    try {
      const { promptInteractive } = await import("./interactive-config.js");
      await promptInteractive();
    } catch (err) {
      console.error(`${YELLOW}interactive 設定のプロンプトをスキップしました:${RESET} ${err instanceof Error ? err.message : err}`);
    }
  }

  if (opts.restart) {
    console.log(`\n${YELLOW}Restarting gateway...${RESET}`);
    try {
      const { restartGateway } = await import("../gateway/lifecycle.js");
      const result = restartGateway(opts.service);
      switch (result.method) {
        case "systemd-user":
          console.log(`${GREEN}Restarted systemd --user unit '${result.service}'.${RESET}`);
          break;
        case "systemd-system":
          if (result.detail === "permission denied") {
            console.error(
              `${RED}Could not restart systemd unit '${result.service}' (permission denied).${RESET}`,
            );
            console.error(
              `Run manually: ${DIM}sudo systemctl restart ${result.service}${RESET}\n`,
            );
          } else {
            const via = result.detail ? ` ${DIM}(${result.detail})${RESET}` : "";
            console.log(`${GREEN}Restarted systemd unit '${result.service}'.${RESET}${via}`);
          }
          break;
        case "daemon":
          console.log(`${GREEN}Restarted background daemon.${RESET}`);
          break;
        case "none":
          console.log(`${DIM}Gateway was not running — nothing to restart.${RESET}`);
          break;
      }
    } catch (err) {
      console.error(`\n${RED}Gateway restart failed:${RESET} ${err}`);
      console.error(`The CLI update succeeded. Restart the gateway manually.\n`);
      process.exit(1);
    }
  }

  console.log(`\n${GREEN}OpenBanto update complete.${RESET}`);
  if (!opts.restart) {
    console.log(
      `${DIM}If the gateway is running, restart it (or re-run with --restart) to use the updated CLI code.${RESET}\n`,
    );
  } else {
    console.log("");
  }
}
