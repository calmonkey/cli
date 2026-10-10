import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chooseEnvFile, findInEnvFiles, parseEnv, planEnv, planIgnore, writeEnv, writeIgnore } from "../src/envfile.js";
import { sandbox, type Sandbox } from "./helpers/sandbox.js";

let s: Sandbox;
beforeEach(() => {
  s = sandbox();
});
afterEach(() => s.cleanup());

const WANTED = { CALMONKEY_CLIENT_ID: "abc123", CALMONKEY_API_URL: "https://api.calmonkey.com", CALMONKEY_CLIENT_SECRET: "cmsec_s3cret" };

describe("reading an environment file", () => {
  it("understands the usual spellings", () => {
    expect(parseEnv(['A=1', 'export B="two words"', "C='single'", "D=plain # a comment", "  E = spaced ", "# F=commented", "G=", 'H="has # inside"', "not a line"].join("\n"))).toEqual({ A: "1", B: "two words", C: "single", D: "plain", E: "spaced", G: "", H: "has # inside" });
  });
});

describe("which file", () => {
  it(".env.local unless the project only has .env; a named file wins", () => {
    expect(path.basename(chooseEnvFile(s.cwd))).toBe(".env.local");
    s.write(".env", "A=1\n");
    expect(path.basename(chooseEnvFile(s.cwd))).toBe(".env");
    s.write(".env.local", "A=1\n");
    expect(path.basename(chooseEnvFile(s.cwd))).toBe(".env.local");
    expect(chooseEnvFile(s.cwd, "config/.env.dev")).toBe(path.join(s.cwd, "config/.env.dev"));
  });

  it("finds a variable in the project's environment files, the local one first", () => {
    s.write(".env", "CALMONKEY_CLIENT_ID=from-env\n");
    expect(findInEnvFiles(s.cwd, "CALMONKEY_CLIENT_ID")).toEqual({ file: path.join(s.cwd, ".env"), value: "from-env" });
    s.write(".env.local", "CALMONKEY_CLIENT_ID=from-local\n");
    expect(findInEnvFiles(s.cwd, "CALMONKEY_CLIENT_ID")?.value).toBe("from-local");
    expect(findInEnvFiles(s.cwd, "CALMONKEY_CLIENT_SECRET")).toBeNull();
  });
});

describe("adding variables", () => {
  it("creates the file, for its owner only", () => {
    const plan = planEnv(path.join(s.cwd, ".env.local"), WANTED);
    expect(plan).toMatchObject({ exists: false, same: [], kept: [] });
    expect(plan.content).toBe("# CalMonkey (added by `npx calmonkey init`)\nCALMONKEY_CLIENT_ID=abc123\nCALMONKEY_API_URL=https://api.calmonkey.com\nCALMONKEY_CLIENT_SECRET=cmsec_s3cret\n");
    writeEnv(plan);
    expect(readFileSync(plan.file, "utf8")).toBe(plan.content);
    expect(statSync(plan.file).mode & 0o777).toBe(0o600);
  });

  it("appends what is missing and never touches what is there", () => {
    const before = "# my settings\nDATABASE_URL=postgres://localhost/app\nCALMONKEY_CLIENT_ID=someone-elses\nCALMONKEY_API_URL=https://api.calmonkey.com";
    const file = s.write(".env.local", before);
    const plan = planEnv(file, WANTED);
    expect(plan.add).toEqual([["CALMONKEY_CLIENT_SECRET", "cmsec_s3cret"]]);
    expect(plan.same).toEqual(["CALMONKEY_API_URL"]);
    expect(plan.kept).toEqual([{ name: "CALMONKEY_CLIENT_ID", existing: "someone-elses" }]);
    expect(plan.content).toBe(`${before}\n\n# CalMonkey (added by \`npx calmonkey init\`)\nCALMONKEY_CLIENT_SECRET=cmsec_s3cret\n`);
    writeEnv(plan);
    // A second run has nothing to add and writes nothing.
    const again = planEnv(file, WANTED);
    expect(again.add).toEqual([]);
    expect(again.content).toBe(readFileSync(file, "utf8"));
  });

  it("fills a variable that is there but empty, keeps Windows line endings, and writes the heading once", () => {
    const file = s.write(".env", "CALMONKEY_CLIENT_SECRET=\r\nOTHER=1\r\n");
    const plan = planEnv(file, { CALMONKEY_CLIENT_SECRET: "cmsec_x" });
    expect(plan.content).toBe("CALMONKEY_CLIENT_SECRET=\r\nOTHER=1\r\n\r\n# CalMonkey (added by `npx calmonkey init`)\r\nCALMONKEY_CLIENT_SECRET=cmsec_x\r\n");
    writeEnv(plan);
    expect(parseEnv(readFileSync(file, "utf8")).CALMONKEY_CLIENT_SECRET).toBe("cmsec_x");
    const more = planEnv(file, { CALMONKEY_CLIENT_SECRET: "cmsec_x", CALMONKEY_CLIENT_ID: "id" });
    expect(more.content.match(/# CalMonkey/g)).toHaveLength(1);
    expect(more.content.endsWith("CALMONKEY_CLIENT_ID=id\r\n")).toBe(true);
  });

  it("quotes a value that needs it, so it reads back as written", () => {
    const plan = planEnv(path.join(s.cwd, ".env.local"), { NAME: 'My "app" (dev) $1' });
    expect(parseEnv(plan.content.replace(/\\(["\\$`])/g, "$1")).NAME).toBe('My "app" (dev) $1');
    expect(plan.content).toContain('NAME="My \\"app\\" (dev) \\$1"');
  });
});

describe("keeping the file out of git", () => {
  it("adds the file to .gitignore when git does not ignore it, and not twice", () => {
    spawnSync("git", ["init", "-q"], { cwd: s.cwd });
    const env = path.join(s.cwd, ".env.local");
    const plan = planIgnore(s.cwd, env);
    expect(plan).toMatchObject({ status: "add", entry: ".env.local", content: ".env.local\n" });
    writeIgnore(plan);
    expect(planIgnore(s.cwd, env).status).toBe("ignored");
  });

  it("leaves .gitignore alone when a pattern already covers the file, and appends cleanly when it does not", () => {
    spawnSync("git", ["init", "-q"], { cwd: s.cwd });
    s.write(".gitignore", "node_modules\n.env*\n");
    expect(planIgnore(s.cwd, path.join(s.cwd, ".env.local")).status).toBe("ignored");
    s.write(".gitignore", "node_modules");
    expect(planIgnore(s.cwd, path.join(s.cwd, ".env.local")).content).toBe("node_modules\n.env.local\n");
  });

  it("without git, reads .gitignore itself", () => {
    // Not a repository: git cannot say, so the file's own lines decide.
    expect(planIgnore(s.cwd, path.join(s.cwd, ".env")).status).toBe("add");
    s.write(".gitignore", "/.env\n");
    expect(planIgnore(s.cwd, path.join(s.cwd, ".env")).status).toBe("ignored");
    s.write(".gitignore", ".env*\n!.env\n");
    expect(planIgnore(s.cwd, path.join(s.cwd, ".env")).status).toBe("add");
    // A file outside the project is not this .gitignore's business.
    expect(planIgnore(s.cwd, path.join(s.root, "elsewhere.env")).status).toBe("ignored");
  });
});
