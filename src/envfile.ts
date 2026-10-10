import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

// The project's environment file: read it, add what is missing, never change what is there.

export type EnvValues = Record<string, string>;

/** KEY=value pairs of a dotenv file: `export` prefixes, quotes and trailing comments are understood; nothing is expanded. */
export function parseEnv(text: string): EnvValues {
  const out: EnvValues = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2]!.trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'" || quote === "`") && value.lastIndexOf(quote) > 0) value = value.slice(1, value.lastIndexOf(quote));
    else value = value.replace(/\s+#.*$/, "");
    out[match[1]!] = value;
  }
  return out;
}

/** Which file the variables go into: the one named, else `.env.local`, else an existing `.env` when there is no `.env.local`. */
export function chooseEnvFile(cwd: string, named?: string): string {
  if (named) return path.resolve(cwd, named);
  if (existsSync(path.join(cwd, ".env.local"))) return path.join(cwd, ".env.local");
  if (existsSync(path.join(cwd, ".env"))) return path.join(cwd, ".env");
  return path.join(cwd, ".env.local");
}

/** The first of the project's environment files that sets `name` to something, with the value. */
export function findInEnvFiles(cwd: string, name: string, extra: string[] = []): { file: string; value: string } | null {
  for (const file of [...extra, ".env.local", ".env.development.local", ".env.development", ".env"]) {
    const full = path.resolve(cwd, file);
    if (!existsSync(full)) continue;
    const value = parseEnv(readFileSync(full, "utf8"))[name];
    if (value) return { file: full, value };
  }
  return null;
}

export type EnvPlan = {
  file: string;
  exists: boolean;
  /** Variables to append, in order. */
  add: [name: string, value: string][];
  /** Already there with the same value. */
  same: string[];
  /** Already there with another value: left as they are. */
  kept: { name: string; existing: string }[];
  /** The file's content afterwards (equal to the current content when nothing is added). */
  content: string;
};

const HEADER = "# CalMonkey (added by `npx calmonkey init`)";

const quoted = (value: string) => (/^[A-Za-z0-9_./:@+=-]*$/.test(value) ? value : `"${value.replace(/(["\\$`])/g, "\\$1")}"`);

/** Works out what to append so that `wanted` holds, without touching a line that exists. An empty existing value counts as missing. */
export function planEnv(file: string, wanted: EnvValues): EnvPlan {
  const exists = existsSync(file);
  const current = exists ? readFileSync(file, "utf8") : "";
  const have = parseEnv(current);
  const plan: EnvPlan = { file, exists, add: [], same: [], kept: [], content: current };
  for (const [name, value] of Object.entries(wanted)) {
    const existing = have[name];
    if (existing === undefined || existing === "") plan.add.push([name, value]);
    else if (existing === value) plan.same.push(name);
    else plan.kept.push({ name, existing });
  }
  if (plan.add.length) {
    const eol = current.includes("\r\n") ? "\r\n" : "\n";
    const lead = current === "" ? "" : current.endsWith("\n") ? eol : `${eol}${eol}`;
    const header = current.includes(HEADER) ? [] : [HEADER];
    plan.content = `${current}${lead}${[...header, ...plan.add.map(([n, v]) => `${n}=${quoted(v)}`)].join(eol)}${eol}`;
  }
  return plan;
}

/** Writes the planned content. A new file is created readable by its owner only: it may hold a client secret. */
export function writeEnv(plan: EnvPlan): void {
  if (!plan.add.length) return;
  writeFileSync(plan.file, plan.content, plan.exists ? {} : { mode: 0o600 });
}

// --- .gitignore -----------------------------------------------------------------------------

export type IgnorePlan = { status: "ignored" | "add"; gitignore: string; entry: string; content: string };

/** Is the file ignored by git? null when git cannot say (no git, not a repository). */
function gitSaysIgnored(cwd: string, file: string): boolean | null {
  try {
    const res = spawnSync("git", ["check-ignore", "-q", "--", file], { cwd, stdio: "ignore", timeout: 5000 });
    if (res.status === 0) return true;
    if (res.status === 1) return false;
  } catch {
    // No git on this machine.
  }
  return null;
}

/** A plain reading of .gitignore for when git cannot be asked: exact names and the usual `.env*` patterns. */
function listedInGitignore(text: string, name: string): boolean {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  if (lines.some((l) => l === `!${name}` || l === `!/${name}`)) return false;
  return lines.some((l) => {
    const p = l.replace(/^\//, "");
    if (p === name) return true;
    if (!p.includes("*")) return false;
    return new RegExp(`^${p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(name);
  });
}

/** Makes sure the environment file is git-ignored: nothing to do when it is, else one line for the project's .gitignore. */
export function planIgnore(cwd: string, envFile: string): IgnorePlan {
  const gitignore = path.join(cwd, ".gitignore");
  const current = existsSync(gitignore) ? readFileSync(gitignore, "utf8") : "";
  const relative = path.relative(cwd, envFile).split(path.sep).join("/");
  const entry = relative.startsWith("..") ? "" : relative;
  // A file outside the project is not this project's .gitignore's business.
  if (!entry) return { status: "ignored", gitignore, entry, content: current };
  const ignored = gitSaysIgnored(cwd, envFile) ?? listedInGitignore(current, entry);
  if (ignored) return { status: "ignored", gitignore, entry, content: current };
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const lead = current === "" || current.endsWith("\n") ? "" : eol;
  return { status: "add", gitignore, entry, content: `${current}${lead}${entry}${eol}` };
}

export function writeIgnore(plan: IgnorePlan): void {
  if (plan.status === "add") writeFileSync(plan.gitignore, plan.content);
}
