import fs from "node:fs";
import readline from "node:readline";
import { loadInstances, saveInstances } from "./instances.js";

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function runNuke(name?: string): Promise<void> {
  const instances = loadInstances().filter((i) => i.name !== "jinn");

  if (instances.length === 0) {
    console.log("削除可能なインスタンスがありません。デフォルトの \"jinn\" インスタンスは削除できません。");
    return;
  }

  // If no name provided, show list and let user pick
  if (!name) {
    console.log("\n利用可能なインスタンス:\n");
    for (let i = 0; i < instances.length; i++) {
      const inst = instances[i];
      const homeDisplay = inst.home.replace(process.env.HOME || process.env.USERPROFILE || "", "~");
      console.log(`  ${DIM}${i + 1}.${RESET} ${inst.name} ${DIM}(${homeDisplay})${RESET}`);
    }
    console.log("");

    const choice = await ask("削除するインスタンスを選択（番号または名前）: ");

    // Try as number first
    const num = parseInt(choice, 10);
    if (!isNaN(num) && num >= 1 && num <= instances.length) {
      name = instances[num - 1].name;
    } else {
      name = choice;
    }
  }

  if (name === "jinn") {
    console.error(`${RED}エラー:${RESET} デフォルトの "jinn" インスタンスは削除できません。`);
    process.exit(1);
  }

  const allInstances = loadInstances();
  const index = allInstances.findIndex((i) => i.name === name);

  if (index === -1) {
    console.error(`${RED}エラー:${RESET} インスタンス "${name}" は存在しません。`);
    process.exit(1);
  }

  const instance = allInstances[index];
  const homeDisplay = instance.home.replace(process.env.HOME || process.env.USERPROFILE || "", "~");

  // Check if running and stop it
  const pidFile = `${instance.home}/gateway.pid`;
  if (fs.existsSync(pidFile)) {
    try {
      const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      process.kill(pid, 0);
      console.log(`\n${YELLOW}インスタンス "${name}" は実行中です。先に停止します...${RESET}`);
      process.kill(pid, "SIGTERM");
      // Wait briefly for graceful shutdown
      await new Promise((resolve) => setTimeout(resolve, 1000));
      console.log(`  停止しました。`);
    } catch {
      // Process not alive, continue
    }
  }

  // Show warning
  console.log(`\n${RED}${BOLD}⚠  警告: この操作は取り消せません${RESET}\n`);
  console.log(`  以下を完全に削除します:`);
  console.log(`    • レジストリ上の "${name}" インスタンス`);
  console.log(`    • ${DIM}${homeDisplay}${RESET} 内のすべてのデータ`);
  console.log(`      ${DIM}(config・sessions・skills・org・logs — 全て)${RESET}\n`);

  const confirmation = await ask(`確認のため "${BOLD}${name}${RESET}" と入力: `);

  if (confirmation !== name) {
    console.log("\n中止しました。何も削除されていません。");
    return;
  }

  // Remove from registry
  allInstances.splice(index, 1);
  saveInstances(allInstances);

  // Delete home directory
  if (fs.existsSync(instance.home)) {
    fs.rmSync(instance.home, { recursive: true, force: true });
  }

  console.log(`\n${RED}インスタンス "${name}" を削除しました。${RESET} ${DIM}${homeDisplay}${RESET} を削除しました。`);
}
