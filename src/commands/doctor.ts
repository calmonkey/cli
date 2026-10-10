import { existsSync } from "node:fs";
import { getSession, listApplications } from "../api.js";
import { CLIENTS, CLIENT_IDS, displayPath, isRegistered } from "../clients/index.js";
import type { Context } from "../context.js";
import { loadSession } from "../credentials.js";
import { findInEnvFiles } from "../envfile.js";
import { request } from "../http.js";
import { NotSignedInError } from "../oauth.js";
import { API_SKILL, skillInstalled } from "../skills.js";
import type { Ui } from "../ui.js";

// `calmonkey doctor`: what is set up and what is not, one line each. It changes nothing.

type Check = { state: "ok" | "warn" | "fail"; text: string; hint?: string };

const MIN_NODE = [20, 12];

export async function runDoctor(ctx: Context, ui: Ui, opts: { envFile?: string }): Promise<number> {
  const checks: Check[] = [];
  const add = (state: Check["state"], text: string, hint?: string) => checks.push({ state, text, hint });

  // Node.
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  if (major > MIN_NODE[0]! || (major === MIN_NODE[0] && minor >= MIN_NODE[1]!)) add("ok", `Node ${process.versions.node}`);
  else add("fail", `Node ${process.versions.node} is older than this tool supports`, "Use Node 20.12 or later.");

  // The environment file.
  const extra = opts.envFile ? [opts.envFile] : [];
  const id = ctx.env.CALMONKEY_CLIENT_ID ? { file: "the environment", value: ctx.env.CALMONKEY_CLIENT_ID } : findInEnvFiles(ctx.cwd, "CALMONKEY_CLIENT_ID", extra);
  const secret = ctx.env.CALMONKEY_CLIENT_SECRET ? { file: "the environment", value: ctx.env.CALMONKEY_CLIENT_SECRET } : findInEnvFiles(ctx.cwd, "CALMONKEY_CLIENT_SECRET", extra);
  const where = (f: { file: string }) => (f.file === "the environment" ? f.file : displayPath(ctx, f.file));
  if (id) add("ok", `CALMONKEY_CLIENT_ID is set in ${where(id)}`);
  else add("fail", "CALMONKEY_CLIENT_ID is not set in this project", "Run: npx calmonkey init");
  if (secret) add("ok", `CALMONKEY_CLIENT_SECRET is set in ${where(secret)}`);
  else add("warn", "CALMONKEY_CLIENT_SECRET is not set in this project", "Your server needs it to call the API. Run npx calmonkey init, or take it from the application's page in the dashboard.");

  // The credentials, by asking for a token that cannot be given: the answer tells good
  // credentials (invalid_grant) from bad ones (invalid_client), and nothing is created or changed.
  if (id && secret) {
    try {
      const res = await request(ctx, `${ctx.endpoints.api}/oauth/token`, { json: { client_id: id.value, client_secret: secret.value, grant_type: "refresh_token", refresh_token: "calmonkey-doctor-check" }, timeoutMs: 15_000 });
      const error = (res.json as { error?: string } | undefined)?.error;
      if (res.status === 400 && error === "invalid_grant") add("ok", `The client credentials are accepted by ${new URL(ctx.endpoints.api).host}`);
      else if (res.status === 400 && error === "invalid_client") add("fail", "The client id and secret are not accepted", "Check both values, or replace the secret: npx calmonkey init --rotate-secret");
      else if (res.status === 429) add("warn", "The API is rate-limiting this address; the credentials were not checked", "Try again in a minute.");
      else add("warn", `The API answered ${res.status} to the credentials check`);
    } catch (error) {
      add("fail", `The API could not be reached: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  // The MCP server: its metadata is public, and a call without a token must be refused with a pointer to the sign-in.
  try {
    const origin = new URL(ctx.endpoints.mcp).origin;
    const meta = await request(ctx, `${origin}/.well-known/oauth-protected-resource${new URL(ctx.endpoints.mcp).pathname}`, { timeoutMs: 15_000 });
    const unauthenticated = await request(ctx, ctx.endpoints.mcp, { json: { jsonrpc: "2.0", id: 1, method: "ping" }, timeoutMs: 15_000 });
    if (meta.status === 200 && unauthenticated.status === 401) add("ok", `The MCP server answers at ${ctx.endpoints.mcp}`);
    else add("fail", `The MCP server at ${ctx.endpoints.mcp} did not answer as expected (metadata ${meta.status}, endpoint ${unauthenticated.status})`, "Check CALMONKEY_MCP_URL.");
  } catch (error) {
    add("fail", `The MCP server could not be reached: ${error instanceof Error ? error.message : "unknown error"}`);
  }

  // The sign-in.
  if (!loadSession(ctx)) add("warn", "Not signed in", "Run: calmonkey login");
  else {
    try {
      const session = await getSession(ctx);
      add("ok", `Signed in to ${session.organization} as ${session.role}${session.access.test_client_secrets ? "" : " (without client secrets of test applications)"}`);
      if (id) {
        const apps = (await listApplications(ctx)).applications;
        const app = apps.find((a) => a.client_id === id.value);
        if (app) add("ok", `CALMONKEY_CLIENT_ID is the test-mode application “${app.name}”`);
        else add("warn", "CALMONKEY_CLIENT_ID is not one of this organization's test-mode applications", "It may be a live application or belong to another organization. `calmonkey listen` and the MCP tools work on test-mode applications.");
      }
    } catch (error) {
      if (error instanceof NotSignedInError) add("warn", "The sign-in has run out or was disconnected", "Run: calmonkey login");
      else add("fail", `The sign-in could not be checked: ${error instanceof Error ? error.message : "unknown error"}`);
    }
  }

  // The AI tools.
  const registered = CLIENT_IDS.map((cid) => CLIENTS[cid]).filter((c) => isRegistered(ctx, c, ctx.endpoints.mcp));
  const inUse = CLIENT_IDS.map((cid) => CLIENTS[cid]).filter((c) => c.detect(ctx).length);
  if (registered.length) add("ok", `The MCP server is registered for: ${registered.map((c) => c.name).join(", ")}`);
  const missing = inUse.filter((c) => !registered.includes(c));
  if (missing.length) add("warn", `Not registered for: ${missing.map((c) => c.name).join(", ")}`, "Run: npx calmonkey mcp add");
  if (!registered.length && !inUse.length) add("warn", "No AI coding tool was found", "Run: npx calmonkey mcp add --client <tool>");

  // The skill.
  if (skillInstalled(ctx.cwd, API_SKILL)) add("ok", `The ${API_SKILL} skill is installed in this project`);
  else add("warn", `The ${API_SKILL} skill is not installed in this project`, "Run: npx calmonkey init");
  if (existsSync(`${ctx.cwd}/AGENTS.md`)) add("ok", "AGENTS.md is there");

  for (const c of checks) {
    (c.state === "ok" ? ui.ok : c.state === "warn" ? ui.warn : ui.fail)(c.text);
    if (c.hint) ui.detail(ui.paint("dim", c.hint));
  }
  const failed = checks.filter((c) => c.state === "fail").length;
  const warned = checks.filter((c) => c.state === "warn").length;
  ui.out("");
  ui.out(failed ? `${failed} thing${failed === 1 ? "" : "s"} to fix${warned ? `, ${warned} to look at` : ""}.` : warned ? `Nothing broken; ${warned} thing${warned === 1 ? "" : "s"} to look at.` : "Everything is in place.");
  return failed ? 1 : 0;
}
