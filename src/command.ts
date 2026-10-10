import type { Context } from "./context.js";
import { EXIT, Failure, nearest } from "./fail.js";

// Every data command is described once, here in shape: its name, what it calls, its flags and
// examples. The parser, `--help`, the unknown-flag error, `schema` and the reference page on
// the docs site (scripts/reference.mjs) are all made from that one description, so help cannot
// name a flag the command does not take.

export type Flag = {
  name: string;
  /** value: takes one value. list: may be given more than once. bool: no value. */
  kind: "value" | "list" | "bool";
  /** How the value is written in help: `<when>`, `<id>`. */
  arg?: string;
  help: string;
};

export type Flags = Record<string, string | string[] | boolean | undefined>;

export type Input = {
  ctx: Context;
  flags: Flags;
  /** What follows the command's name that is not a flag. */
  args: string[];
  /** Everything after `calmonkey`, as typed: used to print the same command again with one thing changed. */
  argv: string[];
  spec: Command;
};

export type Command = {
  /** "events list" */
  name: string;
  group: "start" | "data" | "debug" | "learn" | "other";
  summary: string;
  /** The tool and API operation behind it, for the help's first line and `schema`. */
  operation?: string;
  /** OpenAPI operationId, when one API call corresponds to the command. */
  operationId?: string;
  /** Positional arguments as help shows them: `<event_id>`. */
  usage?: string;
  flags: Flag[];
  /** The flags as help shows them, when a list of one per line would not fit the budget (a test checks every flag is named). */
  flagHelp?: string[];
  examples: string[];
  seeAlso?: string;
  /** Changes something: errors say "nothing was written". */
  write?: boolean;
  run(input: Input): Promise<number>;
};

export const flag = {
  value: (name: string, arg: string, help: string): Flag => ({ name, kind: "value", arg, help }),
  list: (name: string, arg: string, help: string): Flag => ({ name, kind: "list", arg, help }),
  bool: (name: string, help: string): Flag => ({ name, kind: "bool", help }),
};

/** Flags many commands share, spelled once. */
export const COMMON = {
  app: flag.value("app", "<client id>", "the application (default: CALMONKEY_CLIENT_ID of this project)"),
  account: flag.value("account", "<id>", "the account (default: the application's only one)"),
  tz: flag.value("tz", "<zone>", "time zone, e.g. Australia/Melbourne (default: CALMONKEY_TZ)"),
  json: flag.bool("json", "one line of JSON instead of text"),
  limit: (n: number, max: number) => flag.value("limit", "<n>", `rows (default ${n}, most ${max})`),
  output: flag.value("output", "<file>", "write all of it to a JSON file"),
  force: flag.bool("force", "with --output: replace the file"),
  dryRun: flag.bool("dry-run", "check and describe; change nothing"),
  confirm: flag.value("confirm", "<token>", "the token a held command printed, once the person agreed"),
  envFile: flag.value("env-file", "<path>", "the environment file to read (default .env.local, .env)"),
};

/** Flags every command takes without listing them. */
const ALWAYS: Flag[] = [flag.bool("help", "this text"), flag.bool("quiet", "no hints"), flag.bool("no-hints", "no next-step lines"), COMMON.envFile];

export const allFlags = (spec: Command): Flag[] => [...spec.flags, ...ALWAYS.filter((f) => !spec.flags.some((own) => own.name === f.name))];

/** Splits what follows a command's name into flags and positional arguments. An unknown flag is an error that names the nearest real one. */
export function parseFlags(spec: Command, tokens: string[]): { flags: Flags; args: string[] } {
  const known = allFlags(spec);
  const flags: Flags = {};
  const args: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token === "-h") {
      flags.help = true;
      continue;
    }
    if (!token.startsWith("--") || token === "--") {
      // A bare "-x" is not something this tool has; an id that starts with "-" is refused where ids are checked.
      args.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = token.slice(2, eq === -1 ? undefined : eq);
    const found = known.find((f) => f.name === name);
    if (!found) {
      const guess = nearest(name, known.map((f) => f.name));
      throw new Failure({ code: "unknown_flag", message: `calmonkey ${spec.name} has no flag --${name.slice(0, 40)}${guess ? `. Did you mean --${guess}` : ""}`, exit: EXIT.usage, write: spec.write, fix: [`calmonkey ${spec.name} --help`] });
    }
    if (found.kind === "bool") {
      if (eq !== -1) throw new Failure({ code: "bad_flag", message: `--${name} takes no value`, exit: EXIT.usage, write: spec.write });
      flags[name] = true;
      continue;
    }
    const value = eq !== -1 ? token.slice(eq + 1) : tokens[++i];
    if (value === undefined) throw new Failure({ code: "bad_flag", message: `--${name} needs a value: --${name} ${found.arg ?? "<value>"}`, exit: EXIT.usage, write: spec.write, fix: [`calmonkey ${spec.name} --help`] });
    if (found.kind === "list") flags[name] = [...((flags[name] as string[] | undefined) ?? []), value];
    else if (flags[name] !== undefined) throw new Failure({ code: "bad_flag", message: `--${name} was given twice`, exit: EXIT.usage, write: spec.write });
    else flags[name] = value;
  }
  return { flags, args };
}

export const str = (flags: Flags, name: string): string | undefined => (typeof flags[name] === "string" ? (flags[name] as string) : undefined);
export const list = (flags: Flags, name: string): string[] => (Array.isArray(flags[name]) ? (flags[name] as string[]) : []);
export const on = (flags: Flags, name: string): boolean => flags[name] === true;

/** A whole number flag within bounds. */
export function int(flags: Flags, name: string, fallback: number, min: number, max: number, spec: Command): number {
  const raw = str(flags, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Failure({ code: "bad_flag", message: `--${name} must be a whole number from ${min} to ${max}`, exit: EXIT.usage, write: spec.write });
  return n;
}

const ID = /^[A-Za-z0-9._:-]{1,64}$/;

/** An id given on the command line: letters, digits, `.`, `_`, `:`, `-`. Nothing that could be a path, a query or a flag. */
export function checkId(what: string, value: string | undefined, spec: Command, example: string): string {
  if (value === undefined || value === "") throw new Failure({ code: "missing_argument", message: `calmonkey ${spec.name} needs ${what}`, exit: EXIT.usage, write: spec.write, fix: [`calmonkey ${spec.name} ${example}`] });
  if (!ID.test(value) || value.startsWith("-") || value.includes("..")) {
    throw new Failure({ code: "invalid_id", message: `${what} may hold 1 to 64 letters, digits, dots, underscores, colons and dashes, and must not start with a dash`, exit: EXIT.usage, write: spec.write });
  }
  return value;
}

/** A command's own help: what it does and calls, its flags, examples, and where to look next. */
export function commandHelp(spec: Command): string {
  const usage = `calmonkey ${spec.name}${spec.usage ? ` ${spec.usage}` : ""}${spec.flags.length ? " [flags]" : ""}`;
  const lines = [usage, `${spec.summary}${spec.operation ? ` (${spec.operation})` : ""}`];
  if (spec.flagHelp) lines.push("", ...spec.flagHelp);
  else if (spec.flags.length) {
    const names = spec.flags.map((f) => `--${f.name}${f.kind === "bool" ? "" : ` ${f.arg ?? "<value>"}`}`);
    const width = Math.min(26, Math.max(...names.map((n) => n.length)));
    lines.push("", ...spec.flags.map((f, i) => `  ${names[i]!.padEnd(width)}  ${f.help}${f.kind === "list" ? " (repeatable)" : ""}`));
  }
  if (spec.examples.length) lines.push("", "Examples", ...spec.examples.map((e) => `  ${e}`));
  if (spec.seeAlso) lines.push("", `See also: ${spec.seeAlso}`);
  return `${lines.join("\n")}\n`;
}
