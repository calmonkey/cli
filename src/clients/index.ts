import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Context } from "../context.js";
import { hasJsonEntry, upsertJsonEntry, type JsonEdit } from "./json.js";
import { hasTomlServer, upsertTomlServer } from "./toml.js";

// The AI coding tools this command knows: how to tell one is in use, and where and how each
// keeps its list of MCP servers. Formats and locations are each vendor's, as documented in
// October 2026 (links in the README).
//
// Project scope wherever the tool has it, so the setting travels with the repository and
// nothing outside the project folder is changed. The one exception is the older Windsurf,
// which has a single file in the home directory.

export const SERVER_NAME = "calmonkey";

export type ClientId = "claude-code" | "cursor" | "vscode" | "codex" | "gemini" | "windsurf";

export const CLIENT_IDS: ClientId[] = ["claude-code", "cursor", "vscode", "codex", "gemini", "windsurf"];

export type Target = {
  /** Absolute path of the file. */
  file: string;
  scope: "project" | "user";
  format: "json" | "toml";
  /** JSON: the object the servers are listed in. */
  container?: string;
  /** JSON: the entry for this client. */
  entry?: Record<string, unknown>;
  /** JSON: which properties hold the address in this client's format. */
  urlKeys?: string[];
};

export type ClientDef = {
  id: ClientId;
  name: string;
  /** Evidence that the tool is in use here: a folder in the project, a folder in the home directory, a program on PATH. */
  detect(ctx: Context): string[];
  target(ctx: Context, url: string): Target;
  /** What the person does next in that tool, one line. */
  next: string;
};

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

/** Is a program with this name on PATH? Looked up in the file system: nothing is run. */
export function onPath(ctx: Pick<Context, "env" | "platform">, name: string): boolean {
  const dirs = (ctx.env.PATH ?? ctx.env.Path ?? "").split(path.delimiter).filter(Boolean);
  const names = ctx.platform === "win32" ? ["", ...(ctx.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";")].map((ext) => `${name}${ext.toLowerCase()}`) : [name];
  return dirs.some((dir) => names.some((n) => existsSync(path.join(dir, n))));
}

function evidence(ctx: Context, o: { project?: string[]; home?: string[]; bins?: string[] }): string[] {
  const found: string[] = [];
  for (const p of o.project ?? []) if (existsSync(path.join(ctx.cwd, p))) found.push(`${p} in this project`);
  for (const p of o.home ?? []) if (existsSync(path.join(ctx.home, p))) found.push(`~/${p}`);
  for (const b of o.bins ?? []) if (onPath(ctx, b)) found.push(`\`${b}\` on PATH`);
  return found;
}

const portable = (ctx: Context, url: string): Target => ({ file: path.join(ctx.cwd, ".mcp.json"), scope: "project", format: "json", container: "mcpServers", entry: { type: "http", url }, urlKeys: ["url"] });

export const CLIENTS: Record<ClientId, ClientDef> = {
  "claude-code": {
    id: "claude-code",
    name: "Claude Code",
    detect: (ctx) => evidence(ctx, { project: [".claude", "CLAUDE.md"], home: [".claude", ".claude.json"], bins: ["claude"] }),
    target: portable,
    // Checked with Claude Code 2.1: a server from .mcp.json waits for approval the first time.
    next: "Claude Code: start `claude` in this folder, approve the project's MCP server, then run /mcp and sign in to calmonkey.",
  },
  cursor: {
    id: "cursor",
    name: "Cursor",
    detect: (ctx) => evidence(ctx, { project: [".cursor"], home: [".cursor"], bins: ["cursor", "cursor-agent"] }),
    target: (ctx, url) => ({ file: path.join(ctx.cwd, ".cursor", "mcp.json"), scope: "project", format: "json", container: "mcpServers", entry: { url }, urlKeys: ["url"] }),
    next: "Cursor: open the project; under Settings → MCP, calmonkey asks you to sign in.",
  },
  vscode: {
    id: "vscode",
    name: "VS Code (GitHub Copilot)",
    detect: (ctx) => evidence(ctx, { project: [".vscode"], home: [".vscode", ".copilot"], bins: ["code", "code-insiders"] }),
    // VS Code reads the portable `.mcp.json` (the file Claude Code uses). A project that already
    // keeps its servers in VS Code's own `.vscode/mcp.json` gets the entry there instead.
    target: (ctx, url) => {
      const own = path.join(ctx.cwd, ".vscode", "mcp.json");
      return existsSync(own) ? { file: own, scope: "project", format: "json", container: "servers", entry: { type: "http", url }, urlKeys: ["url"] } : portable(ctx, url);
    },
    next: "VS Code: open the project; start the calmonkey server from the MCP servers list and sign in when the browser opens.",
  },
  codex: {
    id: "codex",
    name: "Codex",
    detect: (ctx) => evidence(ctx, { project: [".codex"], home: [".codex"], bins: ["codex"] }),
    target: (ctx) => ({ file: path.join(ctx.cwd, ".codex", "config.toml"), scope: "project", format: "toml" }),
    // Checked with Codex 0.155: a project's .codex/config.toml is read only once the project is trusted.
    next: "Codex: start `codex` in this folder and trust the project (it reads .codex/config.toml only then), then run `codex mcp login calmonkey`.",
  },
  gemini: {
    id: "gemini",
    name: "Gemini CLI",
    detect: (ctx) => evidence(ctx, { project: [".gemini"], home: [".gemini"], bins: ["gemini"] }),
    target: (ctx, url) => ({ file: path.join(ctx.cwd, ".gemini", "settings.json"), scope: "project", format: "json", container: "mcpServers", entry: { httpUrl: url }, urlKeys: ["httpUrl", "url"] }),
    // Checked with Gemini CLI 0.63: project servers stay disabled until the folder is trusted.
    next: "Gemini CLI: start `gemini` in this folder, trust the folder when it asks, then run /mcp auth calmonkey.",
  },
  windsurf: {
    id: "windsurf",
    name: "Windsurf (Devin Desktop)",
    detect: (ctx) => evidence(ctx, { project: [".devin", ".windsurf"], home: [path.join(".config", "devin"), path.join(".codeium", "windsurf")], bins: ["devin", "devin-desktop", "windsurf"] }),
    // Devin Desktop and the Devin CLI read a project file. A Windsurf from before the rename
    // only has one file, in the home directory, with its own name for the address.
    target: (ctx, url) => {
      const current = isDir(path.join(ctx.cwd, ".devin")) || isDir(path.join(ctx.home, ".config", "devin")) || onPath(ctx, "devin") || onPath(ctx, "devin-desktop");
      const legacy = isDir(path.join(ctx.home, ".codeium", "windsurf"));
      if (!current && legacy) return { file: path.join(ctx.home, ".codeium", "windsurf", "mcp_config.json"), scope: "user", format: "json", container: "mcpServers", entry: { serverUrl: url }, urlKeys: ["serverUrl", "url"] };
      return { file: path.join(ctx.cwd, ".devin", "mcp_config.json"), scope: "project", format: "json", container: "mcpServers", entry: { url }, urlKeys: ["url", "serverUrl"] };
    },
    next: "Windsurf / Devin: open the project; sign in when it first uses calmonkey (or run `devin mcp login calmonkey`).",
  },
};

export type Detected = { client: ClientDef; evidence: string[] };

/** The tools that are in use on this machine or in this project. */
export const detectClients = (ctx: Context): Detected[] => CLIENT_IDS.map((id) => ({ client: CLIENTS[id], evidence: CLIENTS[id].detect(ctx) })).filter((d) => d.evidence.length > 0);

export type FilePlan = {
  file: string;
  scope: "project" | "user";
  /** The tools this one file serves (Claude Code and VS Code share `.mcp.json`). */
  clients: ClientDef[];
  edit: JsonEdit;
  /** The entry as it is written, for showing. */
  snippet: string;
};

const read = (file: string): string | null => (existsSync(file) ? readFileSync(file, "utf8") : null);

function snippetOf(target: Target, url: string): string {
  if (target.format === "toml") return `[mcp_servers.${SERVER_NAME}]\nurl = "${url}"`;
  return JSON.stringify({ [target.container!]: { [SERVER_NAME]: target.entry } }, null, 2);
}

/** What registering the server for these tools would write: one plan per file, nothing written yet. */
export function planClients(ctx: Context, clients: ClientDef[], url: string): FilePlan[] {
  const plans = new Map<string, FilePlan>();
  for (const client of clients) {
    const target = client.target(ctx, url);
    const known = plans.get(target.file);
    if (known) {
      known.clients.push(client);
      continue;
    }
    const current = read(target.file);
    const edit = target.format === "toml" ? upsertTomlServer(current, SERVER_NAME, url) : upsertJsonEntry(current, target.container!, SERVER_NAME, target.entry!, url, target.urlKeys!);
    plans.set(target.file, { file: target.file, scope: target.scope, clients: [client], edit, snippet: snippetOf(target, url) });
  }
  return [...plans.values()];
}

/** Writes the plans that change something. Returns the files written. */
export function applyPlans(plans: FilePlan[]): string[] {
  const written: string[] = [];
  for (const plan of plans) {
    if (plan.edit.status !== "create" && plan.edit.status !== "update") continue;
    mkdirSync(path.dirname(plan.file), { recursive: true });
    writeFileSync(plan.file, plan.edit.content);
    written.push(plan.file);
  }
  return written;
}

/** Is the server registered for this tool, at this address? (`calmonkey doctor`.) */
export function isRegistered(ctx: Context, client: ClientDef, url: string): boolean {
  const target = client.target(ctx, url);
  const text = read(target.file);
  if (text === null) return false;
  return target.format === "toml" ? hasTomlServer(text, SERVER_NAME, url) : hasJsonEntry(text, target.container!, SERVER_NAME, url, target.urlKeys!);
}

/** A path as the person would write it: relative to the project, or `~/…`. */
export function displayPath(ctx: Pick<Context, "cwd" | "home">, file: string): string {
  const rel = path.relative(ctx.cwd, file);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel.split(path.sep).join("/");
  const fromHome = path.relative(ctx.home, file);
  if (!fromHome.startsWith("..") && !path.isAbsolute(fromHome)) return `~/${fromHome.split(path.sep).join("/")}`;
  return file;
}
