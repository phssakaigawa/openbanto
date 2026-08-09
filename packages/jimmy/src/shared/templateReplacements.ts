import fs from "node:fs";
import yaml from "js-yaml";
import { CONFIG_PATH } from "./paths.js";

/**
 * File extensions that are treated as text templates and undergo
 * placeholder replacement. Other files are copied byte-for-byte.
 */
const TEMPLATE_FILE_EXTS = new Set([".md", ".yaml", ".yml"]);

/**
 * Apply template placeholder replacements to file content.
 * Pure string substitution; safe for any text content.
 */
export function applyTemplateReplacements(
  content: string,
  replacements: Record<string, string>,
): string {
  let result = content;
  for (const [placeholder, value] of Object.entries(replacements)) {
    result = result.replaceAll(placeholder, value);
  }
  return result;
}

/**
 * Whether the given file extension should have placeholder replacements
 * applied during copy. Markdown and YAML files are templates; everything
 * else is binary-safe copy.
 */
export function isTemplateFile(filename: string): boolean {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return false;
  return TEMPLATE_FILE_EXTS.has(filename.slice(dot).toLowerCase());
}

/**
 * Read portalName from the instance config.yaml, falling back to "Banto".
 * Used to build replacement maps for template files.
 */
export function readPortalName(): string {
  if (!fs.existsSync(CONFIG_PATH)) return "Banto";
  try {
    const cfg = yaml.load(fs.readFileSync(CONFIG_PATH, "utf-8")) as any;
    return cfg?.portal?.portalName || "Banto";
  } catch {
    return "Banto";
  }
}

/**
 * Build the standard placeholder replacement map for a given portal name.
 * Centralises the placeholder vocabulary so setup and migrate stay in sync.
 */
export function buildTemplateReplacements(portalName: string): Record<string, string> {
  const portalSlug = portalName.toLowerCase().replace(/\s+/g, "-");
  return {
    "{{portalName}}": portalName,
    "{{portalSlug}}": portalSlug,
  };
}
