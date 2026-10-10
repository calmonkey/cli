import type { JsonEdit } from "./json.js";

// Codex keeps its settings in TOML (`config.toml`), often with the person's own comments. This
// adds one table, `[mcp_servers.<name>]` with its `url`, by editing the text: no line that
// exists is rewritten, so comments and layout stay exactly as they were.
//
// It deliberately understands only as much TOML as that needs. Where the server is already
// written in a form it does not edit (an inline table, dotted keys), it says so and leaves
// the file alone.

export type TomlEdit = JsonEdit;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A TOML basic string. */
const tomlString = (value: string) => `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The value of `key = "…"` on a line, when the line is that. */
function stringValueOf(line: string, key: string): string | null {
  const match = new RegExp(`^\\s*${escapeRe(key)}\\s*=\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'([^']*)')\\s*(?:#.*)?$`).exec(line);
  if (!match) return null;
  return match[2] ?? match[1]!.replace(/\\(["\\])/g, "$1");
}

const isHeader = (line: string) => /^\s*\[/.test(line);

export function upsertTomlServer(current: string | null, name: string, url: string): TomlEdit {
  const text = current ?? "";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const table = `[mcp_servers.${name}]${eol}url = ${tomlString(url)}${eol}`;
  if (!text.trim()) return { status: current === null ? "create" : "update", content: table };

  const lines = text.split(/\r?\n/);
  const header = new RegExp(`^\\s*\\[\\s*mcp_servers\\s*\\.\\s*(?:${escapeRe(name)}|"${escapeRe(name)}"|'${escapeRe(name)}')\\s*\\]\\s*(?:#.*)?$`);
  const at = lines.findIndex((l) => header.test(l));
  if (at >= 0) {
    // The table's own lines: up to the next header.
    let end = at + 1;
    while (end < lines.length && !isHeader(lines[end]!)) end++;
    const address = lines.slice(at + 1, end).map((l) => stringValueOf(l, "url")).find((v) => v !== null);
    if (address === url) return { status: "unchanged", content: text };
    return { status: "conflict", content: text, reason: `[mcp_servers.${name}] already ${address ? `points at ${address}` : "exists without a url"}` };
  }
  // Written another way (`mcp_servers.calmonkey.url = …`, `calmonkey = { url = … }` under [mcp_servers], or an inline `mcp_servers = { … }`).
  const dotted = new RegExp(`^\\s*mcp_servers\\s*\\.\\s*${escapeRe(name)}\\b`);
  const inline = /^\s*mcp_servers\s*=/;
  const parent = lines.findIndex((l) => /^\s*\[\s*mcp_servers\s*\]\s*(?:#.*)?$/.test(l));
  let underParent = false;
  if (parent >= 0) {
    for (let i = parent + 1; i < lines.length && !isHeader(lines[i]!); i++) if (new RegExp(`^\\s*${escapeRe(name)}\\s*[=.]`).test(lines[i]!)) underParent = true;
  }
  if (lines.some((l) => dotted.test(l) || inline.test(l)) || underParent) {
    return { status: "conflict", content: text, reason: `mcp_servers is written in a form this tool does not edit; add the server by hand` };
  }
  // A new table goes at the end: appending never changes which table an existing key belongs to.
  const lead = text.endsWith("\n") ? eol : `${eol}${eol}`;
  return { status: "update", content: `${text}${lead}${table}` };
}

export function hasTomlServer(text: string, name: string, url: string): boolean {
  return upsertTomlServer(text, name, url).status === "unchanged";
}
