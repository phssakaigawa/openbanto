import fs from "node:fs";
import { loadInstances, saveInstances } from "./instances.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export async function runRemove(name: string, opts: { force?: boolean }): Promise<void> {
  if (name === "jinn") {
    console.error(`${RED}Error:${RESET} Cannot remove the default "jinn" instance.`);
    process.exit(1);
  }

  const instances = loadInstances();
  const index = instances.findIndex((i) => i.name === name);

  if (index === -1) {
    console.error(`${RED}Error:${RESET} Instance "${name}" not found.`);
    process.exit(1);
  }

  const instance = instances[index];

  // Check if running
  const pidFile = `${instance.home}/gateway.pid`;
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      process.kill(pid, 0);
      console.error(`${RED}Error:${RESET} Instance "${name}" is still running. Stop it first with: jinn -i ${name} stop`);
      process.exit(1);
    } catch {
      // Process not alive, continue
    }
  }

  // Remove from registry
  instances.splice(index, 1);
  saveInstances(instances);

  if (opts.force && fs.existsSync(instance.home)) {
    fs.rmSync(instance.home, { recursive: true, force: true });
    console.log(`${GREEN}Instance "${name}" removed.${RESET} Home directory ${DIM}${instance.home}${RESET} deleted.`);
  } else {
    console.log(`${GREEN}Instance "${name}" removed from registry.${RESET}`);
    if (fs.existsSync(instance.home)) {
      console.log(`  ${YELLOW}Note:${RESET} Home directory ${DIM}${instance.home}${RESET} still exists. Use --force to delete it.`);
    }
  }
}
