import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { INSTANCES_REGISTRY, TEMPLATE_DIR } from "../shared/paths.js";

export interface Instance {
  name: string;
  port: number;
  home: string;
  createdAt: string;
}

export function loadInstances(): Instance[] {
  if (!fs.existsSync(INSTANCES_REGISTRY)) return [];
  try {
    return JSON.parse(fs.readFileSync(INSTANCES_REGISTRY, "utf-8"));
  } catch {
    return [];
  }
}

export function saveInstances(instances: Instance[]): void {
  fs.mkdirSync(path.dirname(INSTANCES_REGISTRY), { recursive: true });
  fs.writeFileSync(INSTANCES_REGISTRY, JSON.stringify(instances, null, 2) + "\n");
}

/** Find the next available port starting from 7777, skipping ports already used by instances. */
export function nextAvailablePort(instances: Instance[]): number {
  const usedPorts = new Set(instances.map((i) => i.port));
  let port = 7777;
  while (usedPorts.has(port)) port++;
  return port;
}

/** Ensure the default "jinn" instance is registered. */
export function ensureDefaultInstance(): void {
  const instances = loadInstances();
  if (instances.some((i) => i.name === "jinn")) return;
  instances.unshift({
    name: "jinn",
    port: 7777,
    home: path.join(os.homedir(), ".jinn"),
    createdAt: new Date().toISOString(),
  });
  saveInstances(instances);
}

export function findInstance(name: string): Instance | undefined {
  return loadInstances().find((i) => i.name === name);
}
