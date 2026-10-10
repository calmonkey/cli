import readline from "node:readline/promises";
import { CliError, type Context } from "./context.js";

// What a person sees and is asked. One place, so colour follows NO_COLOR, and so no command
// can ask a question where nobody can answer (CI, a pipe): there `--yes` is required instead.

const CODES = { bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], cyan: [36, 39] } as const;
export type Style = keyof typeof CODES;

/** NO_COLOR (any non-empty value) wins; FORCE_COLOR turns colour on without a terminal; otherwise colour needs a terminal. */
export function colourEnabled(env: NodeJS.ProcessEnv, stream: { isTTY?: boolean }): boolean {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return false;
  if (env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "") return env.FORCE_COLOR !== "0" && env.FORCE_COLOR !== "false";
  if (env.TERM === "dumb") return false;
  return Boolean(stream.isTTY);
}

export type Ui = ReturnType<typeof createUi>;

export function createUi(ctx: Context, opts: { yes?: boolean } = {}) {
  const colour = colourEnabled(ctx.env, ctx.stdout);
  const paint = (style: Style, text: string) => (colour ? `\u001b[${CODES[style][0]}m${text}\u001b[${CODES[style][1]}m` : text);
  const out = (text = "") => void ctx.stdout.write(`${text}\n`);
  const err = (text = "") => void ctx.stderr.write(`${text}\n`);

  // One reader for the whole run, opened at the first question: lines typed ahead of a question
  // are kept for it, and the end of the input answers every later question with its default.
  let reader: readline.Interface | undefined;
  const typed: string[] = [];
  let waiting: ((line: string | null) => void) | undefined;
  let ended = false;
  const ask = (question: string): Promise<string | null> => {
    if (!reader) {
      reader = readline.createInterface({ input: ctx.stdin });
      reader.on("line", (line) => {
        if (waiting) {
          const give = waiting;
          waiting = undefined;
          give(line.trim());
        } else typed.push(line.trim());
      });
      reader.on("close", () => {
        ended = true;
        waiting?.(null);
        waiting = undefined;
      });
    }
    ctx.stdout.write(question);
    if (typed.length) return Promise.resolve(typed.shift()!);
    if (ended) return Promise.resolve(null);
    return new Promise((resolve) => (waiting = resolve));
  };

  /** Why nothing can be asked, as an error naming the flag that answers instead. */
  const cannotAsk = (what: string, flag: string) => new CliError(`${what}\nThere is no terminal to ask in (or this is CI). Run it again with ${flag}.`);

  return {
    colour,
    paint,
    out,
    err,
    heading: (text: string) => out(`\n${paint("bold", text)}`),
    ok: (text: string) => out(`${paint("green", "✓")} ${text}`),
    info: (text: string) => out(`${paint("cyan", "•")} ${text}`),
    warn: (text: string) => out(`${paint("yellow", "!")} ${text}`),
    fail: (text: string) => out(`${paint("red", "✗")} ${text}`),
    detail: (text: string) => out(text.replace(/^/gm, "  ")),
    /** Lets go of the input, so the program can end. */
    close: () => reader?.close(),
    /** Shown file content: indented and dimmed, never altered. */
    block: (text: string) => out(text.replace(/\n$/, "").replace(/^/gm, "    ")),

    /**
     * A yes/no question. `--yes` answers `whenYes` (default yes) without asking; with no terminal
     * and no `--yes` it is an error rather than a guess.
     */
    async confirm(question: string, o: { default?: boolean; whenYes?: boolean; flag?: string } = {}): Promise<boolean> {
      if (opts.yes) return o.whenYes ?? true;
      if (!ctx.interactive) throw cannotAsk(question, o.flag ?? "--yes");
      const fallback = o.default ?? true;
      for (;;) {
        const answer = (await ask(`${paint("bold", "?")} ${question} ${paint("dim", fallback ? "[Y/n]" : "[y/N]")} `))?.toLowerCase();
        if (!answer) return fallback;
        if (answer === "y" || answer === "yes") return true;
        if (answer === "n" || answer === "no") return false;
      }
    },

    /** One of a short list, by number. `--yes` (or no terminal with `--yes`) takes `whenYes`. */
    async select<T>(question: string, choices: { label: string; value: T; hint?: string }[], o: { whenYes: T; flag?: string }): Promise<T> {
      if (opts.yes) return o.whenYes;
      if (!ctx.interactive) throw cannotAsk(question, o.flag ?? "--yes");
      out(`${paint("bold", "?")} ${question}`);
      choices.forEach((c, i) => out(`  ${paint("cyan", String(i + 1))}. ${c.label}${c.hint ? paint("dim", `  ${c.hint}`) : ""}`));
      for (;;) {
        const answer = await ask(`  ${paint("dim", `1-${choices.length}`)}: `);
        // The input ended: the first choice, as Enter would give.
        if (answer === null) return choices[0]!.value;
        const n = Number(answer || "1");
        const picked = Number.isInteger(n) ? choices[n - 1] : undefined;
        if (picked) return picked.value;
      }
    },

    /** A line of text with a default. */
    async input(question: string, o: { default: string; flag?: string }): Promise<string> {
      if (opts.yes) return o.default;
      if (!ctx.interactive) throw cannotAsk(question, o.flag ?? "--yes");
      return (await ask(`${paint("bold", "?")} ${question} ${paint("dim", `(${o.default})`)} `)) || o.default;
    },
  };
}
