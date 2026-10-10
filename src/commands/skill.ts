import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { CLIENTS, displayPath } from "../clients/index.js";
import { COMMON, flag, on, type Command } from "../command.js";
import type { Context } from "../context.js";
import { EXIT, Failure } from "../fail.js";
import { agentsSection } from "../guide.js";
import { print } from "../out.js";
import { API_SKILL, applyAgentsMd, applySkill, installedBy, planAgentsMd, planClaudeMd, planSkill, skillsSource, type SkillPlan } from "../skills.js";
import { createUi, type Ui } from "../ui.js";

// The skill and the always-loaded section, installed into a project: a step of `init`, and
// `calmonkey skill install` on its own.

/** Shows what installing would write, asks, and writes. Returns true when anything was written. */
export async function installSkills(ctx: Context, ui: Ui, opts: { dryRun: boolean; envFile: string }): Promise<boolean> {
  const source = skillsSource(ctx);
  const skills = [API_SKILL];
  // Claude Code reads its own folder; every other tool reads the shared one.
  const roots = [".agents", ...(existsSync(path.join(ctx.cwd, ".claude")) || existsSync(path.join(ctx.cwd, "CLAUDE.md")) || CLIENTS["claude-code"].detect(ctx).length ? [".claude"] : [])];
  const plans: SkillPlan[] = [];
  for (const skill of skills) for (const root of roots) plans.push(planSkill(source, skill, path.join(ctx.cwd, root, "skills", skill)));
  for (const plan of plans) {
    const count = (action: string) => plan.files.filter((f) => f.action === action).length;
    const where = displayPath(ctx, plan.dir);
    const [fresh, updated, kept] = [count("write"), count("update"), count("kept")];
    if (!fresh && !updated) ui.ok(`${plan.skill} is already in ${where}${kept ? ` (${kept} file${kept === 1 ? "" : "s"} you changed left as ${kept === 1 ? "it is" : "they are"})` : ""}.`);
    else ui.info(`${opts.dryRun ? "Would install" : "Install"} ${plan.skill} in ${where}: ${[fresh ? `${fresh} new` : "", updated ? `${updated} updated` : "", kept ? `${kept} of yours kept` : ""].filter(Boolean).join(", ")}.`);
  }
  const section = agentsSection({ version: ctx.version, envFile: opts.envFile });
  const agents = planAgentsMd(ctx.cwd, section);
  const claude = planClaudeMd(ctx.cwd, section);
  const between = "(between <!-- BEGIN:calmonkey --> and its END marker; the rest of the file is not touched)";
  if (agents.status === "unchanged") ui.ok("AGENTS.md already has the CalMonkey section.");
  else ui.info(`${agents.status === "create" ? "Create AGENTS.md with the CalMonkey section" : "Add the CalMonkey section to AGENTS.md"} ${between}.`);
  if (claude?.status === "imports") ui.ok("CLAUDE.md imports AGENTS.md, so Claude Code reads the section from there.");
  else if (claude?.status === "unchanged") ui.ok("CLAUDE.md already has the CalMonkey section.");
  else if (claude) ui.info(`Add the same section to CLAUDE.md ${between}: Claude Code reads CLAUDE.md, and AGENTS.md only in a project without one.`);
  const changes = plans.some((p) => p.write.length) || agents.status !== "unchanged" || claude?.status === "update";
  if (!changes || opts.dryRun) return false;
  if (!(await ui.confirm(`Install the skill and the section in AGENTS.md${claude?.status === "update" ? " and CLAUDE.md" : ""}?`))) return false;
  for (const plan of plans) applySkill(plan, ctx.version);
  applyAgentsMd(agents);
  if (claude) applyAgentsMd(claude);
  ui.ok("Installed.");
  return true;
}

const installCommand: Command = {
  name: "skill install",
  group: "other",
  summary: "Install the calmonkey-api skill into this project (.agents/skills, and .claude/skills for Claude Code) and the short section in AGENTS.md (and CLAUDE.md when there is one)",
  flags: [flag.bool("yes", "ask nothing"), COMMON.dryRun],
  examples: ["calmonkey skill install --yes"],
  seeAlso: "calmonkey skill status, calmonkey agent-guide",
  async run(input) {
    const ui = createUi(input.ctx, { yes: on(input.flags, "yes") });
    try {
      await installSkills(input.ctx, ui, { dryRun: on(input.flags, "dry-run"), envFile: ".env.local" });
    } finally {
      ui.close();
    }
    return EXIT.ok;
  },
};

const printCommand: Command = {
  name: "skill print",
  group: "other",
  summary: "Print the bundled skill's SKILL.md: the workflows for writing code against the API",
  flags: [],
  examples: ["calmonkey skill print"],
  seeAlso: "calmonkey agent-guide (the nine rules for using this tool)",
  async run(input) {
    const file = path.join(skillsSource(input.ctx), API_SKILL, "SKILL.md");
    if (!existsSync(file)) throw new Failure({ code: "skill_missing", message: "this copy of the tool has no skill bundled", exit: EXIT.failed });
    print(input.ctx, readFileSync(file, "utf8"), { explicit: true });
    return EXIT.ok;
  },
};

const statusCommand: Command = {
  name: "skill status",
  group: "other",
  summary: "Whether the skill is installed in this project, and by which version of the tool",
  flags: [COMMON.json],
  examples: ["calmonkey skill status"],
  seeAlso: "calmonkey skill install",
  async run(input) {
    const { ctx } = input;
    const rows = [".agents", ".claude"].map((root) => {
      const dir = path.join(ctx.cwd, root, "skills", API_SKILL);
      const installed = existsSync(path.join(dir, "SKILL.md"));
      return { where: `${root}/skills/${API_SKILL}`, installed, by: installed ? installedBy(dir) : null };
    });
    const block = (file: string) => existsSync(path.join(ctx.cwd, file)) && readFileSync(path.join(ctx.cwd, file), "utf8").includes("<!-- BEGIN:calmonkey -->");
    const stale = rows.some((r) => r.installed && r.by !== null && r.by !== ctx.version);
    if (on(input.flags, "json")) print(ctx, JSON.stringify({ tool: ctx.version, skills: rows, agents_md: block("AGENTS.md"), claude_md: block("CLAUDE.md"), stale }), { explicit: true });
    else
      print(
        ctx,
        [
          `skill ${API_SKILL} | this tool is calmonkey ${ctx.version}`,
          ...rows.map((r) => `${r.where.padEnd(34)} ${r.installed ? `installed${r.by ? ` by calmonkey ${r.by}${r.by !== ctx.version ? " (older than this tool)" : ""}` : " (not by this tool: left alone)"}` : "not installed"}`),
          `AGENTS.md section                  ${block("AGENTS.md") ? "there" : "missing"}`,
          ...(existsSync(path.join(ctx.cwd, "CLAUDE.md")) ? [`CLAUDE.md section                  ${block("CLAUDE.md") ? "there" : /^[ \t]*@(?:\.\/)?AGENTS\.md[ \t]*$/m.test(readFileSync(path.join(ctx.cwd, "CLAUDE.md"), "utf8")) ? "imports AGENTS.md" : "missing: Claude Code does not read AGENTS.md here"}`] : []),
          ...(stale || rows.every((r) => !r.installed) || !block("AGENTS.md") ? ["fix: calmonkey skill install --yes"] : []),
        ].join("\n"),
      );
    return EXIT.ok;
  },
};

export const SKILL_COMMANDS: Command[] = [installCommand, printCommand, statusCommand];
