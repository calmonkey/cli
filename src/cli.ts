import { CLIENT_IDS } from "./clients/index.js";
import { ACCOUNT_COMMANDS } from "./commands/account.js";
import { API_COMMANDS } from "./commands/api.js";
import { runDoctor } from "./commands/doctor.js";
import { EVENT_COMMANDS } from "./commands/events.js";
import { FREEBUSY_COMMANDS } from "./commands/freebusy.js";
import { runInit } from "./commands/init.js";
import { LEARN_COMMANDS, setRegistry } from "./commands/learn.js";
import { runListen } from "./commands/listen.js";
import { LOG_COMMANDS } from "./commands/logs.js";
import { describeSession, registerMcp } from "./commands/shared.js";
import { SKILL_COMMANDS } from "./commands/skill.js";
import { getSession } from "./api.js";
import { COMMON, commandHelp, flag, list, on, parseFlags, str, type Command } from "./command.js";
import { CliError, createContext, type Context } from "./context.js";
import { credentialsPath } from "./credentials.js";
import { EXIT, Failure, failureJson, failureText, nearest } from "./fail.js";
import { login, logout } from "./oauth.js";
import { redact } from "./out.js";
import { createUi, type Ui } from "./ui.js";

// `calmonkey <command> [flags]`: one description per command (src/command.ts), and from it the
// parser, the help, the errors and the reference page.

/** Runs one of the setup commands, which talk to a person: questions, ticks, colour. */
const setup = (run: (ctx: Context, ui: Ui, input: Parameters<Command["run"]>[0], signal: AbortSignal) => Promise<number>): Command["run"] => async (input) => {
  const ui = createUi(input.ctx, { yes: on(input.flags, "yes") });
  const interrupt = new AbortController();
  const stop = () => interrupt.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    return await run(input.ctx, ui, input, interrupt.signal);
  } catch (error) {
    if (interrupt.signal.aborted) {
      ui.err("\nCancelled.");
      return EXIT.interrupted;
    }
    throw error;
  } finally {
    ui.close();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
};

const CLIENT = flag.list("client", "<tool>", `only these AI tools: ${CLIENT_IDS.join(", ")}`);

const SETUP_COMMANDS: Command[] = [
  {
    name: "init",
    group: "start",
    summary: "Set a project up: sign in through the browser, pick or create a test-mode application, write the env file (client id, secret, time zone), install the skill and the section in AGENTS.md. Shows what it will write first; never overwrites",
    flags: [
      flag.bool("yes", "ask nothing; take the safe answer to every question"),
      COMMON.dryRun,
      flag.value("app", "<id|name>", "use this test-mode application"),
      flag.value("name", "<name>", "name for a new test-mode application"),
      flag.value("tz", "<zone>", "the zone written as CALMONKEY_TZ (default: this machine's)"),
      flag.bool("no-secret", "never fetch a client secret"),
      flag.bool("rotate-secret", "replace an existing application's secret without asking"),
      flag.bool("no-skills", "skip the skill and AGENTS.md"),
      flag.bool("mcp", "also register the MCP server in the AI tools found (for tools that cannot run commands)"),
      CLIENT,
      flag.bool("no-browser", "print the sign-in address instead of opening a browser"),
      flag.bool("wait", "without a terminal: print the address and wait for the person to approve"),
    ],
    examples: ["npx calmonkey init", "npx calmonkey init --yes --tz Australia/Melbourne", "npx calmonkey init --dry-run"],
    seeAlso: "calmonkey status, calmonkey doctor",
    run: setup((ctx, ui, { flags }) =>
      runInit(ctx, ui, {
        yes: on(flags, "yes"),
        dryRun: on(flags, "dry-run"),
        clients: list(flags, "client"),
        app: str(flags, "app"),
        name: str(flags, "name"),
        envFile: str(flags, "env-file"),
        secret: !on(flags, "no-secret"),
        rotateSecret: on(flags, "rotate-secret"),
        mcp: on(flags, "mcp"),
        skills: !on(flags, "no-skills"),
        browser: !on(flags, "no-browser"),
        wait: on(flags, "wait"),
        tz: str(flags, "tz"),
      }),
    ),
  },
  {
    name: "login",
    group: "other",
    summary: "Sign in through the browser. The sign-in reaches test-mode applications; it is kept in a file only you can read and shows in the dashboard under AI clients as CalMonkey CLI",
    flags: [flag.bool("no-secret", "do not ask to fetch client secrets of test applications"), flag.bool("no-browser", "print the address instead of opening a browser"), flag.bool("wait", "without a terminal: print the address and wait 5 minutes for the person to approve")],
    examples: ["calmonkey login"],
    seeAlso: "calmonkey status, calmonkey logout",
    run: setup(async (ctx, ui, { flags }, signal) => {
      await login(ctx, ui, { secrets: !on(flags, "no-secret"), browser: !on(flags, "no-browser"), wait: on(flags, "wait"), signal });
      ui.ok(`Signed in to ${describeSession(await getSession(ctx))}.`);
      ui.detail(ui.paint("dim", `The sign-in is kept in ${credentialsPath(ctx)} (readable by you only). It shows in the dashboard under AI clients as “CalMonkey CLI”.`));
      return EXIT.ok;
    }),
  },
  {
    name: "logout",
    group: "other",
    summary: "End the connection at CalMonkey and remove the stored sign-in",
    flags: [],
    examples: ["calmonkey logout"],
    run: setup(async (ctx, ui) => {
      const result = await logout(ctx);
      if (!result.wasSignedIn) ui.info("Not signed in.");
      else ui.ok(result.revoked ? "Signed out. The connection was ended at CalMonkey and the stored sign-in removed." : "Signed out on this machine. CalMonkey could not be reached to end the connection; you can disconnect it in the dashboard under AI clients.");
      return EXIT.ok;
    }),
  },
  {
    name: "doctor",
    group: "debug",
    summary: "Check the env file, the client credentials, the sign-in, the skill and the AI tools. Changes nothing",
    flags: [],
    examples: ["calmonkey doctor"],
    seeAlso: "calmonkey status",
    run: setup((ctx, ui, { flags }) => runDoctor(ctx, ui, { envFile: str(flags, "env-file") })),
  },
  {
    name: "listen",
    group: "debug",
    summary: "Bring a test-mode application's webhook notifications to this machine: each one is posted to its callback URL on localhost with CalMonkey's own headers and signatures. Runs until stopped",
    flags: [flag.value("forward-to", "<url>", "send every notification to this address instead of each channel's own callback URL"), flag.value("app", "<id|name>", "the test-mode application (default: CALMONKEY_CLIENT_ID of this project)")],
    examples: ["calmonkey listen", "calmonkey listen --forward-to http://localhost:3000/webhooks/calmonkey"],
    seeAlso: "calmonkey logs webhooks, calmonkey docs get api#notifications",
    run: setup((ctx, ui, { flags }, signal) => runListen(ctx, ui, { forwardTo: str(flags, "forward-to"), app: str(flags, "app"), envFile: str(flags, "env-file") }, signal)),
  },
  {
    name: "mcp add",
    group: "other",
    summary: "Register the MCP server in AI tools that cannot run commands (or by choice): merges into each tool's own file, shows what it writes first",
    flags: [CLIENT, flag.bool("yes", "ask nothing"), COMMON.dryRun],
    examples: ["calmonkey mcp add --client cursor --yes"],
    seeAlso: "https://calmonkey.com/docs/ai",
    run: setup(async (ctx, ui, { flags }) => {
      ui.heading(`Register ${ctx.endpoints.mcp} in your AI tools`);
      const outcome = await registerMcp(ctx, ui, { clients: list(flags, "client"), dryRun: on(flags, "dry-run") });
      if (outcome.clients.length) {
        ui.out("");
        for (const c of outcome.clients) ui.detail(ui.paint("dim", c.next));
      }
      return EXIT.ok;
    }),
  },
];

export const COMMANDS: Command[] = [...SETUP_COMMANDS, ...ACCOUNT_COMMANDS, ...EVENT_COMMANDS, ...FREEBUSY_COMMANDS, ...LOG_COMMANDS, ...LEARN_COMMANDS, ...SKILL_COMMANDS, ...API_COMMANDS];
setRegistry(() => COMMANDS);

/** Other spellings people and agents reach for, where taking them does no harm. */
const ALIASES: Record<string, string> = {
  "events ls": "events list",
  "events show": "events get",
  "events view": "events get",
  "events rm": "events delete",
  "events remove": "events delete",
  "events patch": "events edit",
  "events occurrence": "events edit",
  "accounts ls": "accounts list",
  "calendars ls": "calendars list",
  "apps ls": "apps list",
  "channels ls": "channels list",
  "calendars create-test": "calendars open-test",
  "calendars create": "calendars open-test",
  "connect link": "accounts connect-link",
  "connect-link": "accounts connect-link",
  "free-busy": "freebusy",
  "freebusy list": "freebusy",
  whoami: "status",
  "docs find": "docs search",
  "docs show": "docs get",
  guide: "agent-guide",
  "logs request": "logs requests",
  "logs webhook": "logs webhooks",
};

/** Verbs that would be guesses with consequences: the answer teaches the right command instead of running something. */
function teach(words: string): Failure | null {
  if (words === "events update") {
    return new Failure({ code: "unknown_command", message: 'no command "events update". To change some fields and keep the rest use events edit; events put replaces the WHOLE event (a field left out is cleared)', exit: EXIT.usage, write: true, fix: ['calmonkey events edit <event_id> --title "New title"', "(whole event: calmonkey events get <event_id> --as-put > e.json, edit it, calmonkey events put <event_id> --from-file e.json)"] });
  }
  if (words === "events create" || words === "events add" || words === "events new") {
    return new Failure({ code: "unknown_command", message: `no command "${words}". Events are written with events put under an id you choose; writing the same id again replaces that event`, exit: EXIT.usage, write: true, fix: ["calmonkey events put <your_event_id> --title Meeting --start 2026-11-03T10:00 --duration 1h --tz Australia/Melbourne"] });
  }
  return null;
}

export function rootHelp(version: string): string {
  return `calmonkey <command> [flags]    CalMonkey calendar API from the terminal (${version})

Start
  status               who is signed in, this project's application, its accounts
  init                 set up a project: sign-in, test application, env file, skill
  agent-guide          the short guide for AI agents; read it once
Calendar data (test-mode applications, unless the sign-in included live ones)
  accounts list | connect-link
  calendars list | open-test
  events list | get | put | edit | delete
  freebusy             busy periods; free slots with --free
  channels list
Debug
  logs requests | webhooks    what the API received, what it sent to your webhook
  listen               bring a test application's webhooks to this machine
  doctor               check the env file, credentials and sign-in
Learn
  docs search <words> | docs get <page>
  schema <command>     the API call behind a command: fields, types, limits
  explain <code>       what an error code means, and the fix
Other: apps list | create, api <METHOD> <path>, skill install | print | status, mcp add, login, logout

Every command: --help (with examples), --json, --limit N; lists: --fields a,b; writes: --dry-run.
Times need a zone: --tz Australia/Melbourne, or CALMONKEY_TZ in the env file.
Output is capped. When there is more, the last line is the command that gets it.
`;
}

const NAMES = () => COMMANDS.map((c) => c.name);

/** The command a line names: its words, and what is left. */
function resolve(argv: string[]): { spec: Command; rest: string[] } | Failure {
  const words: string[] = [];
  for (const token of argv) {
    if (token.startsWith("-") || words.length === 2) break;
    words.push(token);
  }
  for (const n of [2, 1]) {
    if (words.length < n) continue;
    const typed = words.slice(0, n).join(" ");
    const taught = teach(typed);
    if (taught) return taught;
    const name = ALIASES[typed] ?? typed;
    const spec = COMMANDS.find((c) => c.name === name);
    if (spec) return { spec, rest: argv.slice(n) };
  }
  // A group named without its verb ("events", "logs"): say which verbs it has.
  const group = COMMANDS.filter((c) => c.name.startsWith(`${words[0]} `));
  if (group.length) {
    const guess = words[1] ? nearest(words[1], group.map((c) => c.name.split(" ")[1]!)) : null;
    return new Failure({ code: "unknown_command", message: words[1] ? `no command "${words.slice(0, 2).join(" ").slice(0, 60)}"${guess ? `. Did you mean: calmonkey ${words[0]} ${guess}` : ""}` : `"${words[0]}" needs a verb: ${group.map((c) => c.name.split(" ")[1]).join(", ")}`, exit: EXIT.usage, fix: [`calmonkey ${guess ? `${words[0]} ${guess}` : group[0]!.name} --help`] });
  }
  const typed = words.join(" ");
  const guess = nearest(typed, [...NAMES(), ...Object.keys(ALIASES)]) ?? nearest(words[0] ?? "", [...new Set(NAMES().map((n) => n.split(" ")[0]!))]);
  const meant = guess ? (ALIASES[guess] ?? guess) : null;
  const full = meant ? (NAMES().find((n) => n === meant) ?? NAMES().find((n) => n.startsWith(`${meant} `)) ?? meant) : null;
  return new Failure({ code: "unknown_command", message: `no command "${typed.slice(0, 60)}"${full ? `. Did you mean: calmonkey ${full}` : ""}`, exit: EXIT.usage, fix: [full ? `calmonkey ${full} --help` : "calmonkey --help"] });
}

function report(ctx: Context, error: unknown, json: boolean, hints: boolean): number {
  if (error instanceof Failure) {
    ctx.stderr.write(`${redact(json ? failureJson(error) : failureText(error, { hints }))}\n`);
    return error.exitCode;
  }
  if (error instanceof CliError) {
    // The setup commands' own errors: one message for a person.
    ctx.stderr.write(`${redact(error.message.startsWith("error ") ? error.message : `✗ ${error.message}`)}\n`);
    return error.exitCode;
  }
  ctx.stderr.write(`${redact(`error internal: ${error instanceof Error ? error.message : String(error)}`)}\nnothing more is known; calmonkey doctor checks the setup\n`);
  if (ctx.env.CALMONKEY_DEBUG && error instanceof Error && error.stack) ctx.stderr.write(`${redact(error.stack)}\n`);
  return EXIT.failed;
}

export async function main(argv: string[], ctx: Context = createContext()): Promise<number> {
  const json = argv.includes("--json");
  const hints = !argv.includes("--quiet") && !argv.includes("--no-hints");
  try {
    if (argv[0] === "--version" || argv[0] === "-v") {
      ctx.stdout.write(`${ctx.version}\n`);
      return EXIT.ok;
    }
    if (!argv.length || argv[0] === "--help" || argv[0] === "-h" || argv[0] === "help") {
      // `help events list` is `events list --help`.
      if (argv[0] === "help" && argv.length > 1) return await main([...argv.slice(1), "--help"], ctx);
      ctx.stdout.write(rootHelp(ctx.version));
      return argv.length ? EXIT.ok : EXIT.usage;
    }
    // `calmonkey events --help`: the verbs of a group, one line each.
    const group = COMMANDS.filter((c) => c.name.startsWith(`${argv[0]} `));
    if (group.length && (argv[1] === undefined || argv[1].startsWith("-")) && (argv.includes("--help") || argv.includes("-h"))) {
      const width = Math.max(...group.map((c) => c.name.length));
      ctx.stdout.write(`calmonkey ${argv[0]} <verb> [flags]\n\n${group.map((c) => `  calmonkey ${c.name.padEnd(width)}  ${c.summary.split(/[.:;(]/)[0]!.trim()}`).join("\n")}\n\nEach verb's flags and examples: calmonkey ${argv[0]} <verb> --help\n`);
      return EXIT.ok;
    }
    const found = resolve(argv);
    if (found instanceof Failure) throw found;
    const { spec, rest } = found;
    if (rest.includes("--help") || rest.includes("-h")) {
      ctx.stdout.write(commandHelp(spec));
      return EXIT.ok;
    }
    const { flags, args } = parseFlags(spec, rest);
    return await spec.run({ ctx, flags, args, argv, spec });
  } catch (error) {
    return report(ctx, error, json, hints);
  }
}
