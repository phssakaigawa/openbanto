import { getInteractiveSetting, setInteractiveSetting } from "./interactive-config.js";

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const ON_VALUES = new Set(["on", "true", "yes", "1", "enable", "enabled"]);
const OFF_VALUES = new Set(["off", "false", "no", "0", "disable", "disabled"]);

/**
 * `ryoko config interactive [value]`
 *  - no value → print the current setting
 *  - on|off (and synonyms) → set engines.claude.interactive and persist
 */
export async function runConfigInteractive(value?: string): Promise<void> {
  if (value === undefined) {
    const cur = getInteractiveSetting();
    if (cur === undefined) {
      console.log(`interactive: ${DIM}未設定（既定: headless 'claude -p'）${RESET}`);
    } else {
      console.log(`interactive: ${cur ? `${GREEN}on${RESET}` : "off"}`);
    }
    return;
  }

  const v = value.trim().toLowerCase();
  const enabled = ON_VALUES.has(v) ? true : OFF_VALUES.has(v) ? false : null;
  if (enabled === null) {
    console.error(`${RED}不正な値: ${value}${RESET}（on / off）`);
    process.exit(1);
  }

  let changed: boolean;
  try {
    changed = setInteractiveSetting(enabled);
  } catch (err) {
    console.error(`${RED}設定の更新に失敗しました:${RESET} ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  if (changed) {
    console.log(`${GREEN}interactive を ${enabled ? "on" : "off"} に設定しました。${RESET}`);
    console.log(`${DIM}ゲートウェイ再起動で反映: ryoko stop && ryoko start（または ryoko update --restart）${RESET}`);
  } else {
    console.log(`${DIM}interactive は既に ${enabled ? "on" : "off"} です。${RESET}`);
  }
}
