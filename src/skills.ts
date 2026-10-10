import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "./context.js";
import { AGENTS_BEGIN, AGENTS_END } from "./guide.js";

// The CalMonkey skills (https://github.com/calmonkey/skills), installed into a project.
//
// They ship inside this package, so installing them needs no network and the skill always
// matches the tool that installed it. Where they go:
//   .agents/skills/<name>/   the shared location Codex, Cursor, GitHub Copilot, Gemini CLI
//                            and Windsurf read
//   .claude/skills/<name>/   Claude Code, which reads its own folder
// plus a short marked section in AGENTS.md, for tools that read instructions but not skills.
//
// A file the person has edited is never replaced. Each installed folder carries a small
// manifest (`.calmonkey-skill.json`) of what was written; on a later run a file is updated
// only if it still is what this tool wrote.

export const API_SKILL = "calmonkey-api";
/** Bundled, but installed only on request (`npx skills add calmonkey/skills --skill calmonkey-migration`). */
export const MIGRATION_SKILL = "calmonkey-migration";
export const MANIFEST = ".calmonkey-skill.json";

/** The skills bundled with this package (or CALMONKEY_SKILLS_DIR, for development). */
export function skillsSource(ctx: Pick<Context, "env">): string {
  if (ctx.env.CALMONKEY_SKILLS_DIR?.trim()) return path.resolve(ctx.env.CALMONKEY_SKILLS_DIR.trim());
  // dist/cli.js and src/skills.ts are both one level below the package root.
  return fileURLToPath(new URL("../skills/", import.meta.url));
}

const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");

function filesUnder(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...filesUnder(full, base));
    else if (entry !== MANIFEST && entry !== ".DS_Store") out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

export type SkillFile = { path: string; action: "write" | "update" | "same" | "kept" };
export type SkillPlan = { skill: string; dir: string; files: SkillFile[]; write: { path: string; data: Buffer }[]; manifest: Record<string, string> };

type Manifest = { skill: string; installed_by: string; files: Record<string, string> };

function readManifest(dir: string): Manifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path.join(dir, MANIFEST), "utf8")) as Manifest;
    return parsed && typeof parsed.files === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/** What installing one skill into one folder would do. Nothing is written. */
export function planSkill(source: string, skill: string, dir: string): SkillPlan {
  const from = path.join(source, skill);
  if (!existsSync(path.join(from, "SKILL.md"))) throw new Error(`The skill ${skill} is missing from this package (${from}).`);
  const before = readManifest(dir)?.files ?? {};
  const plan: SkillPlan = { skill, dir, files: [], write: [], manifest: {} };
  for (const rel of filesUnder(from)) {
    const data = readFileSync(path.join(from, rel));
    const wanted = sha(data);
    const dest = path.join(dir, rel);
    if (!existsSync(dest)) {
      plan.files.push({ path: rel, action: "write" });
      plan.write.push({ path: rel, data });
      plan.manifest[rel] = wanted;
      continue;
    }
    const have = sha(readFileSync(dest));
    if (have === wanted) {
      plan.files.push({ path: rel, action: "same" });
      plan.manifest[rel] = wanted;
    } else if (before[rel] === have) {
      // Still exactly what an earlier run wrote: safe to bring up to date.
      plan.files.push({ path: rel, action: "update" });
      plan.write.push({ path: rel, data });
      plan.manifest[rel] = wanted;
    } else {
      // Changed by someone, or never ours: it stays, and stays out of the manifest.
      plan.files.push({ path: rel, action: "kept" });
    }
  }
  return plan;
}

export function applySkill(plan: SkillPlan, version: string): void {
  for (const file of plan.write) {
    const dest = path.join(plan.dir, file.path);
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, file.data);
  }
  if (!plan.write.length && existsSync(path.join(plan.dir, MANIFEST))) return;
  mkdirSync(plan.dir, { recursive: true });
  const manifest: Manifest = { skill: plan.skill, installed_by: `calmonkey ${version}`, files: plan.manifest };
  writeFileSync(path.join(plan.dir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
}

/** Is the skill installed in the project, in either place? */
export const skillInstalled = (cwd: string, skill = API_SKILL): boolean => [".agents", ".claude"].some((root) => existsSync(path.join(cwd, root, "skills", skill, "SKILL.md")));

// --- AGENTS.md and CLAUDE.md -----------------------------------------------------------------
//
// The short section that is loaded into every session (src/guide.ts has its text). Where it
// goes, checked against the real tools:
//   AGENTS.md   read by Codex, Cursor, GitHub Copilot, Gemini CLI (with context.fileName),
//               Windsurf, and by Claude Code ONLY when the project has no CLAUDE.md.
//   CLAUDE.md   when a project has one, Claude Code reads it and not AGENTS.md (tried with
//               Claude Code 2.1.289: a fact given only in AGENTS.md was unknown to it once a
//               CLAUDE.md existed, and known again through an `@AGENTS.md` line or the section
//               itself). So a project with a CLAUDE.md gets the section there too, unless
//               that file already imports AGENTS.md. A CLAUDE.md is never created.

export type AgentsPlan = { file: string; status: "create" | "update" | "unchanged" | "imports"; content: string };

const IMPORTS_AGENTS = /^[ \t]*@(?:\.\/)?AGENTS\.md[ \t]*$/m;

/** Adds the section to one file, or replaces the one between the markers. Everything else in the file is left as it is. */
function planSection(file: string, section: string, create: boolean): AgentsPlan | null {
  if (!existsSync(file)) return create ? { file, status: "create", content: `# ${path.basename(file)}\n\n${section}\n` } : null;
  const current = readFileSync(file, "utf8");
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const body = section.split("\n").join(eol);
  const start = current.indexOf(AGENTS_BEGIN);
  const end = current.indexOf(AGENTS_END);
  let content: string;
  if (start >= 0 && end > start) content = `${current.slice(0, start)}${body}${current.slice(end + AGENTS_END.length)}`;
  else content = `${current}${current.endsWith("\n") || current === "" ? "" : eol}${current.trim() ? eol : ""}${body}${eol}`;
  return { file, status: content === current ? "unchanged" : "update", content };
}

export const planAgentsMd = (cwd: string, section: string): AgentsPlan => planSection(path.join(cwd, "AGENTS.md"), section, true)!;

/** The section for a project's CLAUDE.md: null when there is none, "imports" when it already pulls AGENTS.md in. */
export function planClaudeMd(cwd: string, section: string): AgentsPlan | null {
  const file = path.join(cwd, "CLAUDE.md");
  if (!existsSync(file)) return null;
  const current = readFileSync(file, "utf8");
  // An import already brings the section in; a section of ours that is there anyway is still kept up to date.
  if (IMPORTS_AGENTS.test(current) && !current.includes(AGENTS_BEGIN)) return { file, status: "imports", content: current };
  return planSection(file, section, false);
}

export function applyAgentsMd(plan: AgentsPlan): void {
  if (plan.status === "create" || plan.status === "update") writeFileSync(plan.file, plan.content);
}

/** The version of the tool that installed the skill in a folder, from its manifest; null when it was not installed by this tool. */
export function installedBy(dir: string): string | null {
  const by = readManifest(dir)?.installed_by;
  return typeof by === "string" ? by.replace(/^calmonkey\s+/, "") : null;
}
