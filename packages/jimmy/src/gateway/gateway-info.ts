import fs from "node:fs";
import crypto from "node:crypto";

export interface GatewayInfo { port: number; secret: string; pid: number; ptyPids?: number[]; }

export function writeGatewayInfo(file: string, opts: { port: number; pid: number; secret?: string }): GatewayInfo {
  const info: GatewayInfo = {
    port: opts.port,
    pid: opts.pid,
    secret: opts.secret ?? crypto.randomBytes(24).toString("hex"),
    ptyPids: [],
  };
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  // rename preserves the temp file's mode, but if the target already existed
  // with broader permissions some filesystems may not reset them — be explicit.
  fs.chmodSync(file, 0o600);
  return info;
}

export function readGatewayInfo(file: string): GatewayInfo | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as GatewayInfo;
  } catch {
    return null;
  }
}

export function updateGatewayPtyPids(file: string, ptyPids: number[]): void {
  const info = readGatewayInfo(file);
  if (!info) return;
  info.ptyPids = ptyPids;
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(info, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
