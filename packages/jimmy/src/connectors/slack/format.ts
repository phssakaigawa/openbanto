import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SLACK_MAX_LENGTH = 3000;

/** A Markdown table separator row — cells of dashes with optional colons/spaces
 *  (e.g. `|---|:--:|`). Every cell must be dashes-only for it to count. */
function isTableSeparator(line: string): boolean {
  const t = line.trim();
  if (!t.includes("-") || !t.includes("|")) return false;
  const cells = t.replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((c) => /^\s*:?-{1,}:?\s*$/.test(c));
}

/** Split a `| a | b |` row into trimmed cells, dropping the outer pipes. */
function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** Strip inline markdown from a cell so monospace column widths line up. */
function plainTableCell(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/__(.+?)__/g, "$1")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1");
}

/** Render a parsed table as an aligned monospace block inside a ``` fence —
 *  Slack has no table support, but renders fenced code fixed-width so columns
 *  line up and stay readable. */
function renderMonospaceTable(header: string[], rows: string[][]): string {
  const cols = Math.max(header.length, ...rows.map((r) => r.length));
  const norm = (r: string[]) => Array.from({ length: cols }, (_, i) => plainTableCell(r[i] ?? ""));
  const h = norm(header);
  const body = rows.map(norm);
  const widths = Array.from({ length: cols }, (_, i) =>
    Math.max(h[i].length, ...body.map((r) => r[i].length), 3),
  );
  const pad = (r: string[]) => r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd();
  const lines = [pad(h), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(pad)];
  return "```\n" + lines.join("\n") + "\n```";
}

/** Convert GitHub-flavoured Markdown tables to aligned monospace ``` blocks.
 *  Runs BEFORE the mrkdwn conversion so the generated code fence is then
 *  protected from bold/bullet rewriting. Existing code fences are left as-is. */
function convertMarkdownTables(text: string): string {
  return text
    .split(/(```[\s\S]*?```)/g)
    .map((part, idx) => {
      if (idx % 2 === 1) return part; // existing fenced code block — untouched
      const lines = part.split("\n");
      const out: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const next = lines[i + 1];
        if (lines[i].includes("|") && next !== undefined && isTableSeparator(next)) {
          const header = splitTableRow(lines[i]);
          const rows: string[][] = [];
          let j = i + 2;
          while (j < lines.length && lines[j].includes("|") && lines[j].trim() !== "") {
            rows.push(splitTableRow(lines[j]));
            j++;
          }
          out.push(renderMonospaceTable(header, rows));
          i = j - 1;
        } else {
          out.push(lines[i]);
        }
      }
      return out.join("\n");
    })
    .join("");
}

/**
 * Convert standard markdown to Slack mrkdwn format.
 * Handles headings, bold, strikethrough, links, bullet lists, and tables
 * (rendered as aligned monospace, since Slack mrkdwn has no table support).
 * Preserves code blocks and inline code untouched.
 */
export function markdownToSlackMrkdwn(text: string): string {
  // Tables first → ``` blocks, which the split below then protects.
  const withTables = convertMarkdownTables(text);
  // Split text into code and non-code segments to protect code from conversion
  const segments = withTables.split(/(```[\s\S]*?```|`[^`]+`)/g);

  return segments
    .map((segment, i) => {
      // Odd indices are code matches — leave them untouched
      if (i % 2 === 1) return segment;

      return (
        segment
          // Headings: ## text → *text* (must be at start of line)
          .replace(/^(#{1,6})\s+(.+)$/gm, (_match, _hashes, content) => `*${content}*`)
          // Bold: **text** or __text__ → *text*
          .replace(/\*\*(.+?)\*\*/g, "*$1*")
          .replace(/__(.+?)__/g, "*$1*")
          // Strikethrough: ~~text~~ → ~text~
          .replace(/~~(.+?)~~/g, "~$1~")
          // Links: [text](url) → <url|text>
          .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<$2|$1>")
          // Bullet lists: - item or * item → • item (with optional indentation)
          .replace(/^(\s*)[-*]\s+/gm, "$1• ")
          // A bare URL wrapped in emphasis (`*url*` / `_url_`, incl. from `**url**`
          // above) breaks Slack auto-linking — the `*` glued to the URL stops it
          // from linkifying (a common LLM habit is to bold the link it hands out).
          // Unwrap emphasis that directly hugs a URL so it becomes a live link.
          // Explicit `<url|text>` links are untouched (the char class excludes <>|).
          .replace(/[*_]+(https?:\/\/[^\s*_<>|]+)[*_]+/g, "$1")
      );
    })
    .join("");
}

/**
 * Split text into chunks that fit within Slack's message length limit.
 * Converts markdown to Slack mrkdwn format before chunking.
 */
export function formatResponse(text: string): string[] {
  const converted = markdownToSlackMrkdwn(text);

  if (converted.length <= SLACK_MAX_LENGTH) {
    return [converted];
  }

  const chunks: string[] = [];
  let remaining = converted;

  while (remaining.length > 0) {
    if (remaining.length <= SLACK_MAX_LENGTH) {
      chunks.push(remaining);
      break;
    }

    // Try to split at a newline boundary within the limit
    let splitIndex = remaining.lastIndexOf("\n", SLACK_MAX_LENGTH);
    if (splitIndex <= 0) {
      // Fall back to splitting at a space
      splitIndex = remaining.lastIndexOf(" ", SLACK_MAX_LENGTH);
    }
    if (splitIndex <= 0) {
      // Hard split if no good boundary found
      splitIndex = SLACK_MAX_LENGTH;
    }

    chunks.push(remaining.slice(0, splitIndex));
    remaining = remaining.slice(splitIndex).trimStart();
  }

  return chunks;
}

/**
 * Download a Slack file attachment to a local directory.
 * Returns the local file path.
 */
export async function downloadAttachment(
  url: string,
  token: string,
  destDir: string,
): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true });

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to download attachment: ${response.status} ${response.statusText}`);
  }

  // Generate unique filename preserving extension from URL if possible
  const urlPath = new URL(url).pathname;
  const ext = path.extname(urlPath) || "";
  const filename = `${randomUUID()}${ext}`;
  const localPath = path.join(destDir, filename);

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(localPath, buffer);

  return localPath;
}
