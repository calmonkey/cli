import { CliError } from "./context.js";

// An error as an agent (or a person) needs it: what went wrong in one sentence, whether
// anything changed, and the command that puts it right. Printed on stderr, stdout stays empty.
//
//   error invalid_local_time: --start 2026-11-03T10:00 has no time zone, and CALMONKEY_TZ is not set
//   nothing was written
//   fix: calmonkey events put booking-1042 --start … --tz Australia/Melbourne
//   more: calmonkey explain invalid_local_time
//
// The whole thing stays under 120 tokens (test/budgets.test.ts).

/** Exit codes. 0, 1, 2 and 130 are what they have always been. */
export const EXIT = { ok: 0, failed: 1, usage: 2, signIn: 3, notFound: 4, notAllowed: 5, refused: 6, rateLimited: 7, network: 8, confirm: 10, interrupted: 130 } as const;

export type FailureInit = {
  code: string;
  message: string;
  exit?: number;
  /** HTTP status and the field at fault, when the API said so. */
  http?: number;
  field?: string;
  /** "maybe": a write may have gone through (a timeout); `check` is the command that tells. */
  done?: false | "maybe";
  check?: string;
  /** Lines after `fix:`. The first is a command, or says what to do. */
  fix?: string[];
  more?: string;
  /** The command changes things: "nothing was written" instead of "nothing was changed". */
  write?: boolean;
};

export class Failure extends CliError {
  readonly code: string;
  readonly init: FailureInit;
  constructor(init: FailureInit) {
    super(init.message, init.exit ?? EXIT.failed);
    this.name = "Failure";
    this.code = init.code;
    this.init = init;
  }
}

const KNOWN_CODES = new Set<string>();
export const registerCodes = (codes: Iterable<string>) => {
  for (const code of codes) KNOWN_CODES.add(code);
};

export function failureText(f: Failure, opts: { hints: boolean }): string {
  const { init } = f;
  const where = init.http ? ` (HTTP ${init.http}${init.field ? `, ${init.field}` : ""})` : "";
  const lines = [`error ${init.code}${where}: ${init.message}`];
  lines.push(init.done === "maybe" ? `it may have been written; check: ${init.check ?? "calmonkey events list --ours"}` : init.write ? "nothing was written" : "nothing was changed");
  if (init.fix?.length) lines.push(`fix: ${init.fix[0]}`, ...init.fix.slice(1).map((l) => `     ${l}`));
  const more = init.more ?? (opts.hints && KNOWN_CODES.has(init.code) ? `calmonkey explain ${init.code}` : undefined);
  if (more && opts.hints) lines.push(`more: ${more}`);
  return lines.join("\n");
}

export function failureJson(f: Failure): string {
  const { init } = f;
  const error: Record<string, unknown> = { code: init.code, message: init.message, done: init.done === "maybe" ? "maybe" : false };
  if (init.http) error.http = init.http;
  if (init.field) error.field = init.field;
  if (init.fix?.length) error.fix = init.fix[0];
  if (init.check) error.check = init.check;
  if (KNOWN_CODES.has(init.code)) error.explain = `calmonkey explain ${init.code}`;
  return JSON.stringify({ error });
}

/** The nearest of `candidates` to a mistyped word, when one is near enough to be meant. */
export function nearest(word: string, candidates: readonly string[]): string | null {
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = distance(word.toLowerCase(), candidate.toLowerCase());
    if (d < bestDistance) [best, bestDistance] = [candidate, d];
  }
  return best && bestDistance <= Math.max(2, Math.floor(best.length / 3)) ? best : null;
}

function distance(a: string, b: string): number {
  if (b.startsWith(a) || a.startsWith(b)) return Math.min(1, Math.abs(a.length - b.length));
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length]!;
}
