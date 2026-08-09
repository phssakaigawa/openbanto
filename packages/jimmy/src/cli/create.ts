import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  loadInstances,
  saveInstances,
  nextAvailablePort,
  type Instance,
} from "./instances.js";

const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

export async function runCreate(name: string, port?: number): Promise<void> {
  // Validate name
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    console.error(`${RED}エラー:${RESET} インスタンス名は小文字英数字とハイフンのみ使用可能です（例: "atlas", "my-bot"）。`);
    process.exit(1);
  }

  if (name === "jinn") {
    console.error(`${RED}エラー:${RESET} "jinn" はデフォルトインスタンス名です。代わりに "ryoko setup" を使用してください。`);
    process.exit(1);
  }

  const instances = loadInstances();

  if (instances.some((i) => i.name === name)) {
    console.error(`${RED}エラー:${RESET} インスタンス "${name}" は既に存在します。`);
    process.exit(1);
  }

  const assignedPort = port ?? nextAvailablePort(instances);
  const home = path.join(os.homedir(), `.${name}`);

  // Check if home dir already exists
  if (fs.existsSync(home)) {
    console.error(`${RED}エラー:${RESET} ディレクトリ ${home} は既に存在します。削除するか別の名前を指定してください。`);
    process.exit(1);
  }

  // Run setup in a subprocess with JINN_HOME set so paths.ts resolves correctly.
  // This avoids Node module caching issues — paths.ts evaluates fresh in the child.
  const jinnBin = process.argv[1];
  try {
    execFileSync(process.execPath, [jinnBin, "setup"], {
      env: { ...process.env, JINN_HOME: home, JINN_INSTANCE: name },
      stdio: "inherit",
    });
  } catch {
    console.error(`${RED}エラー:${RESET} インスタンス "${name}" のセットアップに失敗しました。`);
    process.exit(1);
  }

  // Patch the config with the correct port and portal name
  const configPath = path.join(home, "config.yaml");
  if (fs.existsSync(configPath)) {
    let config = fs.readFileSync(configPath, "utf-8");
    config = config.replace(/port:\s*\d+/, `port: ${assignedPort}`);
    // Set portal name to capitalized instance name
    const displayName = name.charAt(0).toUpperCase() + name.slice(1);
    if (config.includes("portal: {}")) {
      config = config.replace("portal: {}", `portal:\n  portalName: "${displayName}"`);
    }
    fs.writeFileSync(configPath, config);
  }

  // Register the instance
  const instance: Instance = {
    name,
    port: assignedPort,
    home,
    createdAt: new Date().toISOString(),
  };
  instances.push(instance);
  saveInstances(instances);

  console.log(`\n${GREEN}インスタンス "${name}" を作成しました。${RESET}`);
  console.log(`  ホーム: ${DIM}${home}${RESET}`);
  console.log(`  ポート: ${DIM}${assignedPort}${RESET}`);
  console.log(`\n起動: ${DIM}ryoko -i ${name} start${RESET}`);
  console.log(`または: ${DIM}ryoko -i ${name} start --daemon${RESET}\n`);
}
