import { existsSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Context } from "./context.js";
import { EXIT, Failure } from "./fail.js";

// What every command's answer goes through on its way out: secrets are removed whatever
// produced the text, sizes are capped where the agents' own cut-offs would otherwise cut
// silently, and a file is written only inside the project.

/** The byte caps the tool enforces at run time (it has no tokenizer): about 2,000 and 6,000 tokens. */
export const CAP = { standard: 8 * 1024, explicit: 24 * 1024 } as const;

// Client secrets, access and refresh tokens, authorization codes, link tokens, channel secrets.
// A confirmation token (cmmcf_) is not a secret: printing it is the point.
const SECRET = /\b(?:cmsec|cmat|cmrt|cmac|cmlt|whsec|cmmat|cmmrt|cmmac|cmmar)_[A-Za-z0-9_-]{8,}/g;
const SECRET_KEYS = new Set(["client_secret", "access_token", "refresh_token", "secret", "signing_secret", "authorization", "code_verifier", "link_token"]);

export const redact = (text: string): string => text.replace(SECRET, "[redacted]");

/** A JSON value with secret-bearing keys blanked, whatever their values look like. */
export function redactJson(value: unknown, depth = 0): unknown {
  if (depth > 20) return null;
  if (Array.isArray(value)) return value.map((v) => redactJson(v, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, SECRET_KEYS.has(k.toLowerCase()) && v ? "[redacted]" : redactJson(v, depth + 1)]));
  return typeof value === "string" ? redact(value) : value;
}

/** Null, empty and false values left out, at every level: they cost tokens and say nothing. */
export function compact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(compact);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === null || v === undefined || v === false || v === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      const inner = compact(v);
      if (inner && typeof inner === "object" && !Array.isArray(inner) && Object.keys(inner).length === 0) continue;
      out[k] = inner;
    }
    return out;
  }
  return value;
}

export type PrintOptions = {
  /** The person asked for more than the default (--limit, --full, --json, --fields): the larger cap applies, and going over it is an error, not a cut. */
  explicit?: boolean;
  /** The command as typed, for the error that says to use --output. */
  argv?: readonly string[];
};

/** Writes a result to stdout. A default answer over the cap is cut and says so; an explicit one is refused. */
export function print(ctx: Pick<Context, "stdout">, text: string, opts: PrintOptions = {}): void {
  const clean = redact(text.endsWith("\n") ? text : `${text}\n`);
  const size = Buffer.byteLength(clean);
  if (opts.explicit && size > CAP.explicit) {
    throw new Failure({ code: "too_large", message: `the answer is ${Math.round(size / 1024)} KB, more than fits in one reply (24 KB)`, exit: EXIT.usage, fix: ["add --output <file> to write it to a file, or narrow it with --limit, --fields or --from/--to"] });
  }
  if (!opts.explicit && size > CAP.standard) {
    const cut = Buffer.from(clean).subarray(0, CAP.standard - 200).toString("utf8").replace(/\n[^\n]*$/, "\n");
    ctx.stdout.write(`${cut}…cut at 8 KB (${Math.round(size / 1024)} KB in all). Ask for less: --limit, --fields, a narrower --from/--to; or --output <file>\n`);
    return;
  }
  ctx.stdout.write(clean);
}

export const printJson = (ctx: Pick<Context, "stdout">, value: unknown, opts: PrintOptions = {}): void => print(ctx, JSON.stringify(compact(redactJson(value))), { explicit: true, ...opts });

/** `--output <file>`: JSON into a file in the working folder, and one line about it on stdout. */
export function writeOutput(ctx: Pick<Context, "cwd" | "stdout">, file: string, value: unknown, what: string, keys: string[], force: boolean): void {
  const target = path.resolve(ctx.cwd, file);
  const inside = path.relative(ctx.cwd, target);
  if (inside.startsWith("..") || path.isAbsolute(inside)) throw new Failure({ code: "output_outside_project", message: "--output must be a file inside the working folder", exit: EXIT.usage, fix: [`use a relative path, e.g. --output ${path.basename(file) || "out.json"}`] });
  if (existsSync(target)) {
    if (statSync(target).isDirectory()) throw new Failure({ code: "output_is_a_folder", message: `${inside} is a folder`, exit: EXIT.usage });
    if (!force) throw new Failure({ code: "output_exists", message: `${inside} exists and was left as it is`, exit: EXIT.usage, fix: ["add --force to replace it, or name another file"] });
  }
  const text = `${JSON.stringify(compact(redactJson(value)))}\n`;
  writeFileSync(target, text);
  const bytes = Buffer.byteLength(text);
  ctx.stdout.write(`wrote ${what} (${bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`}) to ${inside}; keys: ${keys.join(",")}\n`);
}

/** Third-party text for a list: JSON-quoted on one line and cut, so it can neither start a new row nor pass for the tool's own last line. */
export function quoted(text: string | undefined, max = 80): string {
  const clean = (text ?? "").replace(/\s+/g, " ").trim();
  return JSON.stringify(clean.length > max ? `${clean.slice(0, max - 1)}…` : clean);
}

/** Our own ids, shortened for reading: prefix and eight characters (the last eight of an event uid, the first of the others). */
export function shortId(id: string | undefined): string {
  if (!id) return "-";
  const m = /^(acc|apc|cal|pro|chn|evt)_([0-9a-f]{24})$/.exec(id);
  if (!m) return id;
  return `${m[1]}_${m[1] === "evt" ? m[2]!.slice(-8) : m[2]!.slice(0, 8)}`;
}

/** Columns padded to the widest cell, two spaces apart; the last column is left as it is. */
export function table(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.slice(0, -1).forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) => row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i]!))).join("  ").trimEnd());
}
