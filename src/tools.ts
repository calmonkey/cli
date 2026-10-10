import { codexNetworkOff } from "./agent.js";
import type { Context } from "./context.js";
import { EXIT, Failure, type FailureInit } from "./fail.js";
import { NetworkError, request } from "./http.js";
import { ConfigNotWritableError, NotSignedInError, accessToken } from "./oauth.js";
import { printable } from "./quote.js";

// Data commands reach CalMonkey through one route: POST <mcp>/cli/tools/<tool>, which runs the
// MCP server's own tool functions for the person who signed in. So what a command may read or
// change, what needs confirming and how third-party text is marked are decided by the server,
// by the same code as for an MCP client; nothing here can widen it.

export type Resolved = { application?: { application_id: string; client_id: string; name: string; mode: "test" | "live" }; account_id?: string; calendar_id?: string };
export type Untrusted = { untrusted_text: string; truncated?: true };
export type ToolAnswer<T> = { result: T; resolved: Resolved };

/** The server described the call and changed nothing: it is carried out with `--confirm <token>`. */
export class ConfirmationNeeded extends Error {
  constructor(
    readonly will: string,
    readonly token: string,
    readonly expiresInSeconds: number,
    readonly resolved: Resolved,
  ) {
    super("confirmation needed");
    this.name = "ConfirmationNeeded";
  }
}

type ErrorBody = { code?: string; message?: string; field?: string; key?: string; applications?: { client_id: string; name: string; mode: string }[]; accounts?: { account_id: string; kind: string }[]; calendars?: { calendar_id: string; provider_name: string; primary: boolean }[]; matches?: string[] };

export type CallOptions = {
  /** The command as it was typed, to print a corrected one. */
  argv: readonly string[];
  /** The command changes things. */
  write?: boolean;
  /** Not safe to send twice (creating an application). */
  once?: boolean;
  /** What to run to see whether a write that timed out went through. */
  check?: string;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const notSignedIn = (ctx: Pick<Context, "endpoints" | "agent" | "interactive">, write = false): Failure =>
  new Failure({
    code: "not_signed_in",
    message: `no sign-in on this machine for ${new URL(ctx.endpoints.app).host}`,
    exit: EXIT.signIn,
    write,
    // Signing in needs a person and a browser: an agent is told to ask, never left waiting for one.
    fix: ctx.interactive ? ["calmonkey login"] : ["ask the person to run this in their own terminal: calmonkey login", "(it opens a browser; nothing here waits for it)"],
  });

export function networkFailure(ctx: Pick<Context, "env">, error: NetworkError, opts: Pick<CallOptions, "write" | "check">): Failure {
  if (codexNetworkOff(ctx.env)) {
    return new Failure({
      code: "network_blocked",
      message: "the Codex sandbox has no network, so CalMonkey cannot be reached from this command",
      exit: EXIT.network,
      write: opts.write,
      fix: ["ask the person to allow network for this command, or to start Codex with network access:", "codex -c sandbox_workspace_write.network_access=true"],
    });
  }
  if (error.timedOut && opts.write) return new Failure({ code: "timeout", message: error.message.replace(/\.$/, ""), exit: EXIT.network, done: "maybe", check: opts.check, write: true });
  return new Failure({ code: error.timedOut ? "timeout" : "network", message: error.message.replace(/\.$/, ""), exit: EXIT.network, write: opts.write, fix: ["calmonkey doctor"] });
}

const withFlag = (argv: readonly string[], flag: string, value: string) => printable([...argv, flag, value]);

/** A refusal of the server as an error with the command that puts it right. */
function refusal(status: number, e: ErrorBody, opts: CallOptions, requestId: string | null): Failure {
  const code = e.code ?? `http_${status}`;
  const base: FailureInit = { code, message: (e.message ?? `CalMonkey answered ${status}`).replace(/\s+/g, " ").replace(/\.$/, ""), http: status, write: opts.write, ...(e.field ? { field: e.field } : {}) };
  const exit = status === 404 ? EXIT.notFound : status === 403 ? EXIT.notAllowed : status === 422 ? EXIT.refused : status === 429 ? EXIT.rateLimited : status === 409 ? EXIT.usage : EXIT.failed;
  const log = requestId && status !== 429 ? `request ${requestId}: calmonkey logs requests --id ${requestId}` : undefined;
  switch (code) {
    case "application_required":
      return new Failure({ ...base, exit: EXIT.usage, message: e.applications?.length ? "this organization has more than one application: name one with --app" : "this sign-in can use no application yet", fix: e.applications?.length ? [withFlag(opts.argv, "--app", e.applications[0]!.client_id), ...e.applications.slice(0, 6).map((a) => `${a.client_id}  ${JSON.stringify(a.name)} (${a.mode})`)] : ['calmonkey apps create "My app (dev)"'] });
    case "account_required":
      return new Failure({ ...base, exit: EXIT.usage, message: e.accounts?.length ? "the application has more than one account: name one with --account" : "the application has no account yet", fix: e.accounts?.length ? [withFlag(opts.argv, "--account", e.accounts[0]!.account_id), `accounts: ${e.accounts.slice(0, 8).map((a) => `${a.account_id} (${a.kind === "connected" ? "connected" : "application calendar"})`).join(", ")}`] : ["calmonkey calendars open-test", "(an application calendar needs no Google or Microsoft account)"] });
    case "calendar_required":
      return new Failure({ ...base, exit: EXIT.usage, message: e.calendars?.length ? "the account has more than one calendar that can be written to: name one with --calendar" : "the account has no calendar that can be written to", fix: e.calendars?.length ? [withFlag(opts.argv, "--calendar", e.calendars[0]!.calendar_id), `calendars: ${e.calendars.slice(0, 8).map((c) => `${c.calendar_id} (${c.provider_name}${c.primary ? ", primary" : ""})`).join(", ")}`] : ["calmonkey calendars list"] });
    case "ambiguous_id":
      return new Failure({ ...base, exit: EXIT.usage, fix: [`use the whole id: ${(e.matches ?? []).slice(0, 6).join(", ")}`] });
    case "account_not_found":
      return new Failure({ ...base, exit, fix: ["calmonkey accounts list"] });
    case "calendar_not_found":
      return new Failure({ ...base, exit, fix: ["calmonkey calendars list"] });
    case "event_not_found":
      return new Failure({ ...base, exit, fix: ["calmonkey events list --ours", "(only events this application wrote can be changed or deleted)"] });
    case "confirmation_invalid":
      return new Failure({ ...base, exit: EXIT.failed, message: "that --confirm token does not fit this command: it works once, for 10 minutes, for exactly the command that was described", fix: [printable(dropConfirm(opts.argv)), "(run it without --confirm to get a new description)"] });
    case "rate_limited":
      return new Failure({ ...base, exit, fix: ["wait a few seconds and run the same command again"] });
    case "invalid_event":
    case "invalid_arguments":
    case "invalid":
      return new Failure({ ...base, exit, fix: [`calmonkey ${opts.argv.slice(0, 2).join(" ")} --help`], more: log });
    default:
      return new Failure({ ...base, exit, ...(status === 422 || status >= 500 ? { more: log } : {}) });
  }
}

export function dropConfirm(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--confirm") i++;
    else if (!argv[i]!.startsWith("--confirm=")) out.push(argv[i]!);
  }
  return out;
}

/** One tool call. Throws Failure for anything that went wrong and ConfirmationNeeded when the call was only described. */
export async function callTool<T = Record<string, unknown>>(ctx: Context, tool: string, args: Record<string, unknown>, opts: CallOptions): Promise<ToolAnswer<T>> {
  const url = `${ctx.endpoints.mcp}/cli/tools/${tool}`;
  const body = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
  let token: string;
  const signIn = async (force = false) => {
    try {
      return await accessToken(ctx, { forceRefresh: force });
    } catch (error) {
      if (error instanceof NotSignedInError) throw notSignedIn(ctx, opts.write);
      if (error instanceof ConfigNotWritableError) throw new Failure({ code: "config_not_writable", message: error.message.split("\n")[0]!.replace(/^error config_not_writable: /, ""), exit: EXIT.signIn, write: opts.write, fix: error.message.split("\n").slice(2).map((l) => l.replace(/^fix: /, "").trim()) });
      if (error instanceof NetworkError) throw networkFailure(ctx, error, opts);
      throw error;
    }
  };
  token = await signIn();
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await request(ctx, url, { json: body, headers: { Authorization: `Bearer ${token}` } });
    } catch (error) {
      if (error instanceof NetworkError) throw networkFailure(ctx, error, opts);
      throw error;
    }
    // The token may have been ended a moment ago by another sign-in: one fresh token, one more try.
    if (res.status === 401 && attempt === 0) {
      token = await signIn(true);
      continue;
    }
    if (res.status === 401) throw notSignedIn(ctx, opts.write);
    const json = res.json as { result?: T; resolved?: Resolved; confirmation?: { will: string; confirmation_token: string; expires_in_seconds: number }; error?: ErrorBody } | undefined;
    if (res.status === 200 && json?.result) return { result: json.result, resolved: json.resolved ?? {} };
    if (res.status === 202 && json?.confirmation) throw new ConfirmationNeeded(json.confirmation.will, json.confirmation.confirmation_token, json.confirmation.expires_in_seconds, json.resolved ?? {});
    // Reads and event writes are safe to repeat (an event is keyed by its id): twice more, waiting as told when that is short.
    if ((res.status === 429 || res.status >= 500) && !opts.once && attempt < 2) {
      const wait = Number(res.headers.get("retry-after") ?? "1");
      if (Number.isFinite(wait) && wait <= 10) {
        await sleep(Math.max(0.2, wait) * 1000);
        continue;
      }
      throw new Failure({ code: "rate_limited", message: `too many requests: retry after ${Math.ceil(wait)} s`, http: 429, exit: EXIT.rateLimited, write: opts.write });
    }
    if (res.status === 404 && !json?.error) throw new Failure({ code: "no_such_route", message: `${new URL(ctx.endpoints.mcp).host} does not know this command's address (HTTP 404): check CALMONKEY_MCP_URL, or the server is older than this tool`, exit: EXIT.failed, write: opts.write });
    throw refusal(res.status, json?.error ?? {}, opts, res.headers.get("calmonkey-request-id"));
  }
}
