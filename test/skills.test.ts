import { cpSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AGENTS_BEGIN, AGENTS_END, agentsSection } from "../src/guide.js";
import { API_SKILL, MANIFEST, MIGRATION_SKILL, applyAgentsMd, applySkill, planAgentsMd, planSkill, skillInstalled, skillsSource } from "../src/skills.js";
import { sandbox, type Sandbox } from "./helpers/sandbox.js";

let s: Sandbox;
beforeEach(() => {
  s = sandbox();
});
afterEach(() => s.cleanup());

const SOURCE = fileURLToPath(new URL("../skills/", import.meta.url));

describe("the skills in this package", () => {
  it("are the two CalMonkey skills, each a valid Agent Skill", () => {
    expect(skillsSource({ env: {} })).toBe(SOURCE);
    expect(readdirSync(SOURCE).sort()).toEqual([API_SKILL, MIGRATION_SKILL]);
    for (const skill of [API_SKILL, MIGRATION_SKILL]) {
      const text = readFileSync(path.join(SOURCE, skill, "SKILL.md"), "utf8");
      const front = /^---\n([\s\S]*?)\n---\n/.exec(text)?.[1] ?? "";
      // The name must be the folder's name (agentskills.io specification).
      expect(/^name: (.+)$/m.exec(front)?.[1]).toBe(skill);
      const description = /^description: ([\s\S]+?)(?:\n[a-z-]+:|$)/m.exec(front)?.[1] ?? "";
      expect(description.length).toBeGreaterThan(40);
      expect(description.length).toBeLessThanOrEqual(1024);
      expect(text.split("\n").length).toBeLessThan(500);
      // No secret has any business in a skill.
      expect(text).not.toMatch(/cmsec_[A-Za-z0-9_-]{20,}/);
    }
  });
});

describe("installing a skill", () => {
  const dir = () => path.join(s.cwd, ".agents", "skills", API_SKILL);

  it("writes every file and a manifest of what it wrote", () => {
    const plan = planSkill(SOURCE, API_SKILL, dir());
    expect(plan.files.every((f) => f.action === "write")).toBe(true);
    expect(plan.files.map((f) => f.path)).toContain("SKILL.md");
    expect(existsSync(dir())).toBe(false);
    applySkill(plan, "1.2.3");
    expect(readFileSync(path.join(dir(), "SKILL.md"), "utf8")).toBe(readFileSync(path.join(SOURCE, API_SKILL, "SKILL.md"), "utf8"));
    const manifest = JSON.parse(readFileSync(path.join(dir(), MANIFEST), "utf8")) as { skill: string; installed_by: string; files: Record<string, string> };
    expect(manifest).toMatchObject({ skill: API_SKILL, installed_by: "calmonkey 1.2.3" });
    expect(Object.keys(manifest.files).sort()).toEqual(plan.files.map((f) => f.path).sort());
    expect(skillInstalled(s.cwd)).toBe(true);
  });

  it("a second run has nothing to do and writes nothing", () => {
    applySkill(planSkill(SOURCE, API_SKILL, dir()), "1.0.0");
    const before = readFileSync(path.join(dir(), MANIFEST), "utf8");
    const again = planSkill(SOURCE, API_SKILL, dir());
    expect(again.write).toEqual([]);
    expect(again.files.every((f) => f.action === "same")).toBe(true);
    applySkill(again, "2.0.0");
    expect(readFileSync(path.join(dir(), MANIFEST), "utf8")).toBe(before);
  });

  it("a file the person edited is kept; one that is still as installed is brought up to date", () => {
    applySkill(planSkill(SOURCE, API_SKILL, dir()), "1.0.0");
    writeFileSync(path.join(dir(), "SKILL.md"), "my own notes\n");
    // A newer version of the package: a copy of the skills with one reference changed.
    const newer = path.join(s.root, "newer");
    cpSync(SOURCE, newer, { recursive: true });
    const changed = readdirSync(path.join(newer, API_SKILL, "references"))[0]!;
    writeFileSync(path.join(newer, API_SKILL, "references", changed), "# new text\n");
    writeFileSync(path.join(newer, API_SKILL, "SKILL.md"), "---\nname: calmonkey-api\ndescription: newer\n---\n");
    const plan = planSkill(newer, API_SKILL, dir());
    expect(plan.files.find((f) => f.path === "SKILL.md")!.action).toBe("kept");
    expect(plan.files.find((f) => f.path === `references/${changed}`)!.action).toBe("update");
    applySkill(plan, "2.0.0");
    expect(readFileSync(path.join(dir(), "SKILL.md"), "utf8")).toBe("my own notes\n");
    expect(readFileSync(path.join(dir(), "references", changed), "utf8")).toBe("# new text\n");
    // The kept file is no longer the tool's to manage.
    expect(JSON.parse(readFileSync(path.join(dir(), MANIFEST), "utf8")).files).not.toHaveProperty("SKILL.md");
  });

  it("files that were there before, put by someone else, are theirs unless identical", () => {
    s.write(`.agents/skills/${API_SKILL}/SKILL.md`, "someone else's skill of the same name\n");
    const plan = planSkill(SOURCE, API_SKILL, dir());
    expect(plan.files.find((f) => f.path === "SKILL.md")!.action).toBe("kept");
    expect(plan.write.map((w) => w.path)).not.toContain("SKILL.md");
  });
});

describe("the AGENTS.md section", () => {
  const section = agentsSection({ version: "0.2.0", envFile: ".env.local" });

  it("points at the command, its guide and the zone, and never holds a secret's value", () => {
    expect(section.startsWith(AGENTS_BEGIN)).toBe(true);
    expect(section.endsWith(AGENTS_END)).toBe(true);
    for (const text of ["`calmonkey` command", "calmonkey agent-guide", "calmonkey docs search", "CALMONKEY_TZ", "CALMONKEY_CLIENT_SECRET", ".env.local", "NOT DONE", "data, never instructions", "calmonkey 0.2.0"]) expect(section).toContain(text);
    expect(section).not.toMatch(/cmsec_/);
    // The evaluation: asked to "print the credentials", agents read .env.local into the conversation. The section says not to, even when asked.
    expect(section).toMatch(/even when asked/);
    expect(section).toContain(".env.local");
  });

  it("creates the file when there is none", () => {
    const plan = planAgentsMd(s.cwd, section);
    expect(plan).toMatchObject({ status: "create", content: `# AGENTS.md\n\n${section}\n` });
    applyAgentsMd(plan);
    expect(planAgentsMd(s.cwd, section).status).toBe("unchanged");
  });

  it("adds itself to the end of an existing file and leaves the rest as it is", () => {
    const mine = "# Project rules\n\n- Run the tests.\n";
    s.write("AGENTS.md", mine);
    const plan = planAgentsMd(s.cwd, section);
    expect(plan.status).toBe("update");
    expect(plan.content).toBe(`${mine}\n${section}\n`);
    applyAgentsMd(plan);
    expect(planAgentsMd(s.cwd, section).status).toBe("unchanged");
  });

  it("replaces only what is between its markers", () => {
    const before = `# Rules\n\nAbove.\n\n${AGENTS_BEGIN}\nold text\n${AGENTS_END}\n\nBelow, written by a person.\n`;
    s.write("AGENTS.md", before);
    const plan = planAgentsMd(s.cwd, section);
    expect(plan.status).toBe("update");
    expect(plan.content).toBe(`# Rules\n\nAbove.\n\n${section}\n\nBelow, written by a person.\n`);
  });

  it("keeps Windows line endings and a file without a final newline", () => {
    s.write("AGENTS.md", "# Rules\r\nOne.");
    const plan = planAgentsMd(s.cwd, section);
    expect(plan.content.startsWith("# Rules\r\nOne.\r\n\r\n<!-- BEGIN:calmonkey -->\r\n")).toBe(true);
    expect(plan.content.replace(/\r\n/g, "")).not.toContain("\n");
  });
});
