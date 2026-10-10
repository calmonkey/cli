import { readFileSync } from "node:fs";
import path from "node:path";
import { getSession, type Session } from "../api.js";
import { CLIENTS, CLIENT_IDS, applyPlans, detectClients, displayPath, planClients, type ClientDef, type ClientId, type FilePlan } from "../clients/index.js";
import { CliError, type Context } from "../context.js";
import { loadSession } from "../credentials.js";
import { NotSignedInError, login } from "../oauth.js";
import type { Ui } from "../ui.js";

// Steps more than one command takes.

/** The sign-in to use: the stored one when it still works, otherwise a new one through the browser. */
export async function ensureSignedIn(ctx: Context, ui: Ui, opts: { secrets?: boolean; browser?: boolean; fresh?: boolean; wait?: boolean } = {}): Promise<Session> {
  if (!opts.fresh && loadSession(ctx)) {
    try {
      return await getSession(ctx);
    } catch (error) {
      if (!(error instanceof NotSignedInError)) throw error;
    }
  }
  await login(ctx, ui, { secrets: opts.secrets, browser: opts.browser, wait: opts.wait });
  return getSession(ctx);
}

export const describeSession = (session: Session) => `${session.organization} (you are ${session.role === "member" ? "a member, read only" : session.role === "owner" ? "an owner" : "an admin"})`;

/** `--client` values as known tools. An unknown name is an error that lists the names. */
export function clientsNamed(names: string[]): ClientDef[] {
  const out: ClientDef[] = [];
  for (const raw of names.flatMap((n) => n.split(","))) {
    const id = raw.trim().toLowerCase();
    if (!id) continue;
    const alias: Record<string, ClientId> = { claude: "claude-code", "claude-code": "claude-code", cursor: "cursor", vscode: "vscode", "vs-code": "vscode", code: "vscode", copilot: "vscode", "github-copilot": "vscode", codex: "codex", gemini: "gemini", "gemini-cli": "gemini", windsurf: "windsurf", devin: "windsurf" };
    const known = alias[id];
    if (!known) throw new CliError(`Unknown --client "${raw}". Use one of: ${CLIENT_IDS.join(", ")}.`);
    if (!out.includes(CLIENTS[known])) out.push(CLIENTS[known]);
  }
  return out;
}

const STATUS_WORD: Record<FilePlan["edit"]["status"], string> = { create: "create", update: "add to", unchanged: "already there", conflict: "left alone", invalid: "left alone" };

/** Shows, file by file, exactly what registering the MCP server would write. */
export function showPlans(ctx: Context, ui: Ui, plans: FilePlan[]): void {
  for (const plan of plans) {
    const where = `${displayPath(ctx, plan.file)}${plan.scope === "user" ? ui.paint("dim", "  (in your home folder: this tool has no project file)") : ""}`;
    const who = plan.clients.map((c) => c.name).join(", ");
    const { status } = plan.edit;
    if (status === "unchanged") ui.ok(`${who}: ${where} already has the calmonkey server.`);
    else if (status === "conflict" || status === "invalid") ui.warn(`${who}: ${where} was ${STATUS_WORD[status]}: ${plan.edit.reason}.`);
    else {
      ui.info(`${who}: ${STATUS_WORD[status]} ${where}`);
      ui.block(ui.paint("dim", plan.snippet));
    }
  }
}

export type McpOutcome = { plans: FilePlan[]; clients: ClientDef[]; written: string[] };

/**
 * Registers the MCP server in the tools named, or in the ones found: shows what it will write,
 * asks, writes. With `dryRun` it stops after showing.
 */
export async function registerMcp(ctx: Context, ui: Ui, opts: { clients: string[]; dryRun: boolean }): Promise<McpOutcome> {
  const url = ctx.endpoints.mcp;
  let clients = clientsNamed(opts.clients);
  if (!clients.length) {
    const found = detectClients(ctx);
    clients = found.map((d) => d.client);
    if (found.length) ui.info(`AI tools found: ${found.map((d) => `${d.client.name} ${ui.paint("dim", `(${d.evidence[0]})`)}`).join(", ")}`);
  }
  if (!clients.length) {
    ui.warn("No AI coding tool was found on this machine or in this project, so the MCP server was not registered anywhere.");
    ui.detail(`Name one with --client (${CLIENT_IDS.join(", ")}), or add ${url} to your tool as a remote MCP server.`);
    return { plans: [], clients: [], written: [] };
  }
  const plans = planClients(ctx, clients, url);
  showPlans(ctx, ui, plans);
  const changing = plans.filter((p) => p.edit.status === "create" || p.edit.status === "update");
  if (!changing.length) return { plans, clients, written: [] };
  if (opts.dryRun) return { plans, clients, written: [] };
  const go = await ui.confirm(changing.length === 1 ? "Write this file?" : `Write these ${changing.length} files?`);
  if (!go) {
    ui.info("Left as it is. Nothing was written for the MCP server.");
    return { plans, clients, written: [] };
  }
  const written = applyPlans(plans);
  for (const file of written) ui.ok(`Wrote ${displayPath(ctx, file)}`);
  return { plans, clients, written };
}

/** A name for the project: its package name, else its folder's name. */
export function projectName(cwd: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(cwd, "package.json"), "utf8")) as { name?: unknown };
    if (typeof pkg.name === "string" && pkg.name.trim()) return pkg.name.replace(/^@[^/]+\//, "").trim();
  } catch {
    // No package.json.
  }
  return path.basename(cwd) || "My app";
}
