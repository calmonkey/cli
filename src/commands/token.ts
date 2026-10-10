import { ApiError, createMachineToken, listMachineTokens, revokeMachineToken } from "../api.js";
import { COMMON, checkId, flag, on, str, type Command, type Input } from "../command.js";
import { EXIT, Failure } from "../fail.js";
import { NetworkError } from "../http.js";
import { NotSignedInError, usesMachineToken } from "../oauth.js";
import { print, table } from "../out.js";
import { networkFailure, notSignedIn } from "../tools.js";

// Tokens for AI agents with no browser (CALMONKEY_TOKEN): a cloud coding agent or a CI job
// cannot sign in, so a person makes it a token. These commands are for that person, signed in
// with `calmonkey login`; a machine token cannot make, see or end machine tokens. The same can
// be done in the dashboard under AI clients.

const DAYS = [7, 30, 90] as const;

/** Runs a call of these commands with errors in the tool's own format. */
async function guarded<T>(input: Input, write: boolean, fn: () => Promise<T>): Promise<T> {
  if (usesMachineToken(input.ctx)) {
    throw new Failure({ code: "needs_person", message: "machine tokens are made, listed and revoked by a person who is signed in, not with CALMONKEY_TOKEN", exit: EXIT.notAllowed, write, fix: ["unset CALMONKEY_TOKEN and run it in your own terminal after calmonkey login", "(or use the dashboard: AI clients)"] });
  }
  try {
    return await fn();
  } catch (error) {
    if (error instanceof NotSignedInError) throw notSignedIn(input.ctx, write);
    if (error instanceof NetworkError) throw networkFailure(input.ctx, error, { write });
    if (error instanceof ApiError) throw new Failure({ code: error.code, message: error.message.replace(/\.$/, ""), http: error.status, exit: error.status === 403 ? EXIT.notAllowed : error.status === 404 ? EXIT.notFound : error.status === 422 ? EXIT.refused : EXIT.failed, write });
    throw error;
  }
}

const create: Command = {
  name: "token create",
  group: "other",
  summary: "Make a token for an AI agent or CI job with no browser, to set as CALMONKEY_TOKEN in its environment. Test-mode applications only; shown once; only in your own terminal",
  flags: [
    flag.value("name", "<name>", "what will use it, e.g. \"Codex cloud\" (shown under AI clients and in the request log)"),
    flag.value("days", "<n>", "how long it works: 7 (default), 30 or 90"),
    flag.value("app", "<id>", "only this test-mode application (default: every test-mode application)"),
    flag.bool("event-details", "may read event titles, descriptions and guests (default: free/busy only)"),
    flag.bool("may-write", "may change events (default: reads only); deletes and emails to guests always need a person"),
  ],
  examples: ['calmonkey token create --name "Codex cloud"', 'calmonkey token create --name "CI" --days 30 --app client1 --may-write'],
  seeAlso: "calmonkey token list, calmonkey token revoke <id>",
  write: true,
  async run(input) {
    const { ctx, flags } = input;
    const name = str(flags, "name")?.trim();
    if (!name) throw new Failure({ code: "missing_flag", message: "calmonkey token create needs --name", exit: EXIT.usage, write: true, fix: ['calmonkey token create --name "Codex cloud"'] });
    const days = str(flags, "days") === undefined ? 7 : Number(str(flags, "days"));
    if (!(DAYS as readonly number[]).includes(days)) throw new Failure({ code: "bad_flag", message: "--days is 7, 30 or 90", exit: EXIT.usage, write: true });
    // The token is shown once, and printing it into an AI agent's conversation would hand it to
    // the model and its vendor's logs: only a person at a terminal gets it.
    if (!ctx.interactive) {
      throw new Failure({ code: "needs_person", message: "a token is shown once, so it is made only in a person's own terminal, not under an AI agent, in CI or through a pipe", exit: EXIT.signIn, write: true, fix: ["ask the person to run this in their own terminal, or to make one in the dashboard: AI clients"] });
    }
    const made = await guarded(input, true, () =>
      createMachineToken(ctx, { name, days, ...(str(flags, "app") ? { application_id: str(flags, "app") } : {}), ...(on(flags, "event-details") ? { event_details: true } : {}), ...(on(flags, "may-write") ? { may_write: true } : {}) }),
    );
    const scope = [made.application ? `only ${JSON.stringify(made.application.name)}` : "every test-mode application", made.event_details ? "event details" : "free/busy only", made.may_write ? "may change events" : "reads only"];
    // Written past the redaction on purpose: this is the one copy of the token there will ever be.
    ctx.stdout.write(
      [
        `made machine token ${JSON.stringify(made.name)} (${made.connection_id}) | expires ${made.expires_at.slice(0, 10)} | ${scope.join(", ")}`,
        "",
        `  ${made.token}`,
        "",
        "Copy it now: it is shown only once. Set it as CALMONKEY_TOKEN in the agent's secret settings (never in a file in the repository).",
        `End it at once with: calmonkey token revoke ${made.connection_id}   (or Disconnect in the dashboard: AI clients)`,
        "",
      ].join("\n"),
    );
    return EXIT.ok;
  },
};

const list: Command = {
  name: "token list",
  group: "other",
  summary: "The organization's machine tokens that still work: name, who made it, expiry, last use. Never the tokens",
  flags: [COMMON.json],
  examples: ["calmonkey token list"],
  seeAlso: "calmonkey token create, calmonkey token revoke <id>",
  async run(input) {
    const { tokens } = await guarded(input, false, () => listMachineTokens(input.ctx));
    if (on(input.flags, "json")) print(input.ctx, JSON.stringify({ tokens }), { explicit: true });
    else
      print(
        input.ctx,
        [
          `machine tokens ${tokens.length}`,
          ...(tokens.length
            ? table([["ID", "EXPIRES", "LAST USED", "MAY", "MADE BY", "NAME"], ...tokens.map((t) => [t.connection_id, t.expires_at.slice(0, 10), t.last_used_at ? t.last_used_at.slice(0, 10) : "never", [t.may_write ? "write" : "read", t.event_details ? "details" : "free/busy", ...(t.application_id ? ["one app"] : [])].join(","), t.made_by, JSON.stringify(t.name)])])
            : ['none: calmonkey token create --name "Codex cloud"']),
        ].join("\n"),
      );
    return EXIT.ok;
  },
};

const revoke: Command = {
  name: "token revoke",
  group: "other",
  summary: "End a machine token at once (your own, or anyone's if you manage the team)",
  usage: "<id>",
  write: true,
  flags: [],
  examples: ["calmonkey token revoke mcg_5ba21743f408617d1269ea1e"],
  seeAlso: "calmonkey token list",
  async run(input) {
    const id = checkId("the token's id (mcg_…, from calmonkey token list)", input.args[0], input.spec, "mcg_5ba21743f408617d1269ea1e");
    await guarded(input, true, () => revokeMachineToken(input.ctx, id));
    print(input.ctx, `revoked machine token ${id}: it stops working now`);
    return EXIT.ok;
  },
};

export const TOKEN_COMMANDS: Command[] = [create, list, revoke];
