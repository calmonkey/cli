import { on, str, type Input } from "../command.js";
import { EXIT, Failure } from "../fail.js";
import { print, printJson, shortId } from "../out.js";
import { applicationOf, requireZone } from "../project.js";
import { printable } from "../quote.js";
import { confirmationText } from "../render.js";
import { TimeError, addDays, parseWhen, startOfDay, wallOf } from "../time.js";
import { ConfirmationNeeded, callTool, dropConfirm, type CallOptions, type Resolved, type ToolAnswer, type Untrusted } from "../tools.js";
import { createUi } from "../ui.js";

// What the data commands share: which application and account a command is about, the window
// of a read, how an answer is printed, and what happens when the server wants a yes first.

export const hints = (input: Input): boolean => !on(input.flags, "quiet") && !on(input.flags, "no-hints");

/** The application and account a command names, for the server to check or fill in. */
export const target = (input: Input): { application_id?: string; account_id?: string } => ({
  application_id: applicationOf(input.ctx, input.flags as { app?: string }),
  ...(str(input.flags, "account") ? { account_id: str(input.flags, "account") } : {}),
});

type AccountRow = { account_id: string; kind: string; name?: Untrusted; email?: Untrusted; application_calendar_id?: Untrusted };
type AppRow = { client_id: string; application_id: string; name: string; mode: string };

const ACCOUNT_ID = /^(acc|apc)_[0-9a-f]{8,24}$/;

/** What an account is called: its application calendar id, else its person's name, else the email. Other people's text, so only quoted. */
export const accountName = (a: AccountRow): string => a.application_calendar_id?.untrusted_text ?? a.name?.untrusted_text ?? a.email?.untrusted_text ?? "";
const accountList = (rows: AccountRow[]) => rows.slice(0, 8).map((a) => `${JSON.stringify(accountName(a).replace(/\s+/g, " ").slice(0, 40))} ${shortId(a.account_id)}`).join(", ");

/** The accounts of the command's application (one call; used to turn a name into an id, and to name them in an error). */
async function accountsOf(input: Input, applicationId: string | undefined): Promise<AccountRow[]> {
  const { result } = await callTool<{ accounts: AccountRow[] }>(input.ctx, "list_accounts", { application_id: applicationId }, { argv: input.argv });
  return result.accounts;
}

/** `--account alice`, `--account grace@example.com`: the account whose application calendar id, name or email it is. */
async function accountByName(input: Input, applicationId: string | undefined, wanted: string): Promise<string> {
  const rows = await accountsOf(input, applicationId);
  const low = wanted.toLowerCase();
  const hits = rows.filter((a) => [a.application_calendar_id, a.name, a.email].some((t) => t?.untrusted_text.toLowerCase() === low));
  if (hits.length === 1) return hits[0]!.account_id;
  throw new Failure({ code: hits.length ? "ambiguous_id" : "account_not_found", message: hits.length ? `more than one account is called ${JSON.stringify(wanted.slice(0, 40))}` : `no account ${JSON.stringify(wanted.slice(0, 40))} in this application`, exit: hits.length ? EXIT.usage : EXIT.notFound, write: input.spec.write, fix: [`accounts: ${accountList(hits.length ? hits : rows)}`, "(--account takes an account id, an application calendar's id, or a person's name or email)"] });
}

/** `--app "Shop (dev)"`: the application of that name. */
async function appByName(input: Input, wanted: string): Promise<string> {
  const { result } = await callTool<{ applications: AppRow[]; live_applications_not_included: number }>(input.ctx, "list_applications", {}, { argv: input.argv });
  const hits = result.applications.filter((a) => a.name.toLowerCase() === wanted.toLowerCase());
  if (hits.length === 1) return hits[0]!.client_id;
  const hidden = result.live_applications_not_included;
  throw new Failure({
    code: hits.length ? "ambiguous_id" : "not_found",
    message: hits.length ? `more than one application is called ${JSON.stringify(wanted.slice(0, 60))}` : `no application ${JSON.stringify(wanted.slice(0, 60))} that this sign-in can use${hidden ? `; ${hidden} live application${hidden === 1 ? " is" : "s are"} not included in it (live applications are only reached when the person included them when signing in)` : ""}`,
    exit: hits.length ? EXIT.usage : EXIT.notFound,
    write: input.spec.write,
    fix: [`applications: ${result.applications.slice(0, 6).map((a) => `${JSON.stringify(a.name)} ${a.client_id} (${a.mode})`).join(", ") || "none"}`],
  });
}

/**
 * One tool call of a command. Names given for an account or an application are turned into
 * ids first, and a refusal that asks which account is meant names the accounts.
 */
export async function call<T = Record<string, unknown>>(input: Input, tool: string, args: Record<string, unknown>, opts: Partial<CallOptions> = {}): Promise<ToolAnswer<T>> {
  const sent = { ...args };
  // A name with a space cannot be an id: look it up at once. Any other value is tried as an id first.
  if (typeof sent.application_id === "string" && /\s/.test(sent.application_id)) sent.application_id = await appByName(input, sent.application_id);
  if (typeof sent.account_id === "string" && !ACCOUNT_ID.test(sent.account_id)) sent.account_id = await accountByName(input, sent.application_id as string | undefined, sent.account_id);
  try {
    return await callTool<T>(input.ctx, tool, sent, { argv: input.argv, write: input.spec.write, ...opts });
  } catch (error) {
    if (error instanceof Failure && error.code === "not_found" && typeof sent.application_id === "string" && /^No application with the id/.test(error.message)) {
      return call<T>(input, tool, { ...args, application_id: await appByName(input, sent.application_id) }, opts);
    }
    if (!(error instanceof Failure) || error.code !== "account_required") throw error;
    const rows = await accountsOf(input, sent.application_id as string | undefined).catch(() => null);
    if (!rows?.length) throw error;
    const first = accountName(rows[0]!);
    const usable = /^[A-Za-z0-9._@+-]{1,64}$/.test(first) ? first : rows[0]!.account_id;
    throw new Failure({ ...error.init, fix: [printable([...input.argv, "--account", usable]), `accounts: ${accountList(rows)}`] });
  }
}

/** Text by default, one line of JSON with --json. Nothing else decides the format. */
export function emit(input: Input, text: () => string, json: () => unknown, explicit = false): void {
  if (on(input.flags, "json")) printJson(input.ctx, json(), { argv: input.argv });
  else print(input.ctx, text(), { explicit, argv: input.argv });
}

export type Window = { tz: string; from: string; to: string; fromLabel: string; toLabel: string; startOf: (day: string) => number };

/** --from / --to of a read, in the command's zone. Days are sent as days (the server reads them in the zone); the first line of the answer shows the window as given. */
export function readWindow(input: Input, defaults: { from: string; days: number }): Window {
  const { ctx, flags, argv, spec } = input;
  const tz = requireZone(ctx, flags as { tz?: string }, argv, `calmonkey ${spec.name} needs a time zone to know which days are meant`);
  const startOf = (day: string): number => startOfDay(day, tz);
  const parse = (name: string, value: string) => {
    try {
      return parseWhen(`--${name}`, value, tz, { relative: true });
    } catch (error) {
      if (error instanceof TimeError) throw new Failure({ code: error.code, message: error.message, exit: EXIT.usage });
      throw error;
    }
  };
  const from = parse("from", str(flags, "from") ?? defaults.from);
  const fromDay = from.kind === "day" ? from.day : wallOf(from.instant, tz).day;
  const to = str(flags, "to") !== undefined ? parse("to", str(flags, "to")!) : ({ kind: "day", day: addDays(fromDay, defaults.days) } as const);
  const fromValue = from.kind === "day" ? from.day : from.instant.toISOString().replace(/\.\d{3}Z$/, "Z");
  const toValue = to.kind === "day" ? to.day : to.instant.toISOString().replace(/\.\d{3}Z$/, "Z");
  const fromAt = from.kind === "day" ? startOf(from.day) : from.instant.getTime();
  const toAt = to.kind === "day" ? startOf(to.day) : to.instant.getTime();
  if (toAt <= fromAt) throw new Failure({ code: "invalid_time", message: `--to ${toValue} must be after --from ${fromValue} (--to is exclusive: the day after the last day)`, exit: EXIT.usage });
  return { tz, from: fromValue, to: toValue, fromLabel: from.kind === "day" ? from.day : from.local ?? fromValue, toLabel: to.kind === "day" ? to.day : to.local ?? toValue, startOf };
}

/**
 * Runs a write. When the server only describes it (a delete, a write that emails guests, a
 * live application), nothing has changed: the description and the exact command to run after
 * the person agreed go to stderr, exit code 10. `--yes` does not exist for this, on purpose.
 * With a terminal and a person at it, the tool asks and makes the second call itself.
 */
export async function write<T>(input: Input, tool: string, args: Record<string, unknown>, opts: { check?: string; about?: () => Promise<string | null>; done: (answer: ToolAnswer<T>, confirmed: boolean) => void }): Promise<number> {
  const token = str(input.flags, "confirm");
  const send = (confirmation?: string) => call<T>(input, tool, { ...args, ...(confirmation ? { confirm: true, confirmation_token: confirmation } : {}) }, { write: true, check: opts.check });
  try {
    opts.done(await send(token), Boolean(token));
    return EXIT.ok;
  } catch (error) {
    if (!(error instanceof ConfirmationNeeded)) throw error;
    const about = opts.about ? await opts.about().catch(() => null) : null;
    const minutes = Math.round(error.expiresInSeconds / 60);
    if (input.ctx.interactive && !on(input.flags, "dry-run")) {
      const ui = createUi(input.ctx);
      try {
        input.ctx.stderr.write(`${confirmationText(error.will, about, "(asked here)", minutes).split("\n").slice(1, -2).join("\n")}\n`);
        if (!(await ui.confirm("Go ahead?", { default: false }))) {
          input.ctx.stderr.write("nothing was changed\n");
          return EXIT.confirm;
        }
      } finally {
        ui.close();
      }
      opts.done(await send(error.token), true);
      return EXIT.ok;
    }
    const again = printable([...dropConfirm(input.argv).filter((a) => a !== "--dry-run"), "--confirm", error.token]);
    input.ctx.stderr.write(`${confirmationText(error.will, about, again, minutes)}\n`);
    return EXIT.confirm;
  }
}

export const resolvedLine = (r: Resolved): string => (r.application ? `${r.application.mode} application ${JSON.stringify(r.application.name)}` : "application");
