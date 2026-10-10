import path from "node:path";
import type { Context } from "./context.js";
import { findInEnvFiles } from "./envfile.js";
import { EXIT, Failure } from "./fail.js";
import { printable } from "./quote.js";
import { isZone, machineZone } from "./time.js";

// What a command takes from the project it is run in: the application (CALMONKEY_CLIENT_ID)
// and the time zone (CALMONKEY_TZ), from the environment or the project's environment file.
// The machine's own zone is never used silently: it is only ever offered in a `fix:` line.

export type Setting = { value: string; from: string };

export function projectSetting(ctx: Pick<Context, "env" | "cwd">, name: string, envFile?: string): Setting | null {
  const direct = ctx.env[name]?.trim();
  if (direct) return { value: direct, from: "the environment" };
  const found = findInEnvFiles(ctx.cwd, name, envFile ? [envFile] : []);
  return found ? { value: found.value, from: path.relative(ctx.cwd, found.file) || found.file } : null;
}

/** The application a command is about: `--app`, else the project's CALMONKEY_CLIENT_ID, else left to the server (which takes the only one). */
export const applicationOf = (ctx: Pick<Context, "env" | "cwd">, flags: { app?: string; "env-file"?: string }): string | undefined => flags.app ?? projectSetting(ctx, "CALMONKEY_CLIENT_ID", flags["env-file"])?.value;

/** The zone of a command: `--tz`, else CALMONKEY_TZ. undefined when neither is set. */
export function zoneOf(ctx: Pick<Context, "env" | "cwd">, flags: { tz?: string; "env-file"?: string }): string | undefined {
  const tz = flags.tz ?? projectSetting(ctx, "CALMONKEY_TZ", flags["env-file"])?.value;
  if (tz === undefined) return undefined;
  if (!isZone(tz)) throw new Failure({ code: "invalid_zone", message: `${JSON.stringify(tz.slice(0, 40))} is not a time zone. Use an IANA name such as Australia/Melbourne or Europe/London`, exit: EXIT.usage });
  return tz;
}

/** The zone, or the error that says how to give one. `argv` is the command as typed. */
export function requireZone(ctx: Pick<Context, "env" | "cwd">, flags: { tz?: string; "env-file"?: string }, argv: readonly string[], why: string, write = false): string {
  const tz = zoneOf(ctx, flags);
  if (tz) return tz;
  const machine = machineZone();
  throw new Failure({
    code: "invalid_local_time",
    message: `${why}, and CALMONKEY_TZ is not set`,
    exit: EXIT.usage,
    write,
    fix: [printable([...argv, "--tz", machine]), `(${machine} is this machine's zone; use the zone of the calendar's owner)`],
  });
}
