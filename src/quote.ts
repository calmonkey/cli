// Commands the tool prints for someone (or some agent) to run next: after `fix:`, after
// `N more:`, in a NOT DONE block. They must work when pasted into sh, bash, zsh, cmd.exe and
// PowerShell alike, so:
//   - a plain word is printed as it is;
//   - anything else goes in double quotes (single quotes mean nothing to cmd.exe), with a
//     double quote inside written \" ;
//   - a value with characters the shells disagree about ($ ` \ % ! ^ or a line break) is not
//     printed at all: its place is taken by a marker and the line says to type it again. A
//     command that runs differently in two shells is worse than one that asks.

const PLAIN = /^[A-Za-z0-9_@+=:,./-]+$/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what must not reach a shell
const UNSAFE = /[$`\\%!^\r\n\u0000-\u001f]/;

export type Quoted = { text: string; retype: string[] };

export function quoteArg(value: string): { text: string; safe: boolean } {
  if (value !== "" && PLAIN.test(value)) return { text: value, safe: true };
  if (UNSAFE.test(value)) return { text: "", safe: false };
  return { text: `"${value.replace(/"/g, '\\"')}"`, safe: true };
}

/** `calmonkey` and its arguments as one line. A flag's value that cannot be printed safely becomes `<same --flag as before>`. */
export function commandLine(args: readonly string[]): Quoted {
  const out: string[] = ["calmonkey"];
  const retype: string[] = [];
  let flag = "";
  for (const arg of args) {
    const quoted = quoteArg(arg);
    if (quoted.safe) out.push(quoted.text);
    else {
      const name = flag || "value";
      out.push(`"<same ${name} as before>"`);
      retype.push(name);
    }
    flag = arg.startsWith("--") && !arg.includes("=") ? arg : "";
  }
  return { text: out.join(" "), retype };
}

/** The line, with a note when part of it has to be typed again. */
export function printable(args: readonly string[]): string {
  const { text, retype } = commandLine(args);
  return retype.length ? `${text}\n     (type ${retype.join(", ")} again: the value has characters that shells read differently)` : text;
}

/** The arguments of a run without one flag (and its value), e.g. to print the same command with another --cursor. */
export function without(args: readonly string[], ...flags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const name = arg.split("=")[0]!;
    if (flags.includes(name)) {
      if (!arg.includes("=") && args[i + 1] !== undefined && !args[i + 1]!.startsWith("--")) i++;
      continue;
    }
    out.push(arg);
  }
  return out;
}
