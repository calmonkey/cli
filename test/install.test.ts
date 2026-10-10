import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { addToProject, declaredIn, detectPackageManager, installCommand, type Runner } from "../src/install.js";
import { startFake, type Fake } from "./helpers/fake-calmonkey.js";
import { sandbox, signedIn, uiOf, type Sandbox } from "./helpers/sandbox.js";

// `init` adds the tool to a project with a package.json, with the project's own package
// manager. No test here runs a package manager: the runner is recorded (one end-to-end test
// in test/e2e runs a real `npm install` of a packed copy).

type Call = { command: string; args: string[]; cwd: string };

let fake: Fake;
let s: Sandbox;
let calls: Call[];
let answer: { code: number; output: string };

const recorder: Runner = async (command, args, opts) => {
  calls.push({ command, args, cwd: opts.cwd });
  return answer;
};

beforeEach(async () => {
  fake = await startFake();
  calls = [];
  answer = { code: 0, output: "added 1 package" };
  s = sandbox({ url: fake.url, run: recorder });
  signedIn(s, fake);
});
afterEach(async () => {
  s.cleanup();
  await fake.close();
});

const init = (...extra: string[]) => main(["init", "--yes", "--tz", "Etc/UTC", "--no-secret", ...extra], s.ctx);
const agentsMd = () => readFileSync(path.join(s.cwd, "AGENTS.md"), "utf8");

describe("which package manager", () => {
  const cases: [lockfile: string | null, extra: Record<string, unknown>, pm: string, command: string][] = [
    ["package-lock.json", {}, "npm", "npm install --save-dev --save-exact calmonkey@1.2.3"],
    ["npm-shrinkwrap.json", {}, "npm", "npm install --save-dev --save-exact calmonkey@1.2.3"],
    ["pnpm-lock.yaml", {}, "pnpm", "pnpm add --save-dev --save-exact calmonkey@1.2.3"],
    ["yarn.lock", {}, "yarn", "yarn add --dev --exact calmonkey@1.2.3"],
    ["bun.lock", {}, "bun", "bun add --dev --exact calmonkey@1.2.3"],
    ["bun.lockb", {}, "bun", "bun add --dev --exact calmonkey@1.2.3"],
    [null, { packageManager: "pnpm@9.12.0" }, "pnpm", "pnpm add --save-dev --save-exact calmonkey@1.2.3"],
    [null, {}, "npm", "npm install --save-dev --save-exact calmonkey@1.2.3"],
  ];
  for (const [lockfile, extra, pm, command] of cases) {
    it(`${lockfile ?? (extra.packageManager ? "the packageManager field" : "nothing")} → ${pm}`, () => {
      s.write("package.json", JSON.stringify({ name: "shop", ...extra }));
      if (lockfile) s.write(lockfile, "");
      const found = detectPackageManager(s.cwd);
      expect(found.pm).toBe(pm);
      const { command: c, args } = installCommand(found.pm, "calmonkey@1.2.3");
      expect([c, ...args].join(" ")).toBe(command);
    });
  }
});

describe("init in a project with a package.json", () => {
  it("--yes adds calmonkey at this version with the project's package manager, in the project folder, and the section says npx runs the project's copy", async () => {
    s.write("package.json", JSON.stringify({ name: "shop", dependencies: { next: "16.0.0" } }));
    s.write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
    expect(await init()).toBe(0);
    expect(calls).toEqual([{ command: "pnpm", args: ["add", "--save-dev", "--save-exact", "calmonkey@9.9.9-test"], cwd: s.cwd }]);
    expect(s.out()).toContain("Added calmonkey@9.9.9-test to devDependencies.");
    expect(agentsMd()).toContain("run `npx calmonkey …`: a devDependency here, so it runs the project's copy");
    // The tool itself never writes package.json: only the package manager does.
    expect(JSON.parse(readFileSync(path.join(s.cwd, "package.json"), "utf8"))).toEqual({ name: "shop", dependencies: { next: "16.0.0" } });
  });

  it("a project that already lists it keeps its version, and nothing is run", async () => {
    s.write("package.json", JSON.stringify({ name: "shop", devDependencies: { calmonkey: "^0.2.0" } }));
    expect(declaredIn(s.cwd)).toEqual({ field: "devDependencies", range: "^0.2.0" });
    expect(await init()).toBe(0);
    expect(calls).toEqual([]);
    expect(s.out()).toContain("package.json already lists calmonkey (devDependencies: ^0.2.0)");
    expect(agentsMd()).toContain("a devDependency here");
  });

  it("--no-install skips it, and the section keeps today's wording", async () => {
    s.write("package.json", JSON.stringify({ name: "shop" }));
    expect(await init("--no-install")).toBe(0);
    expect(calls).toEqual([]);
    expect(s.out()).toContain("Not added to package.json (--no-install).");
    expect(agentsMd()).toContain("use the `calmonkey` command (`npx calmonkey` if it is not installed)");
  });

  it("--dry-run prints the command and runs nothing", async () => {
    s.write("package.json", JSON.stringify({ name: "shop" }));
    s.write("yarn.lock", "");
    expect(await init("--dry-run")).toBe(0);
    expect(calls).toEqual([]);
    expect(s.out()).toContain("yarn add --dev --exact calmonkey@9.9.9-test");
  });

  it("a failed install is reported with its last lines; init still finishes, and the section does not claim a local copy", async () => {
    s.write("package.json", JSON.stringify({ name: "shop" }));
    answer = { code: 1, output: "npm error code E403\nnpm error 403 Forbidden" };
    expect(await init()).toBe(0);
    expect(s.out()).toContain("npm failed (exit code 1)");
    expect(s.out()).toContain("npm error 403 Forbidden");
    expect(agentsMd()).toContain("`npx calmonkey` if it is not installed");
  });

  it("without --yes and without a terminal, it does not guess", async () => {
    s.write("package.json", JSON.stringify({ name: "shop" }));
    const ui = uiOf(s);
    await expect(addToProject(s.ctx, ui, { install: true, dryRun: false })).rejects.toThrow(/--yes/);
    ui.close();
    expect(calls).toEqual([]);
  });
});

describe("init without a package.json", () => {
  it("does what it always did: no step, nothing run, today's wording", async () => {
    expect(await init()).toBe(0);
    expect(calls).toEqual([]);
    expect(s.out()).not.toContain("package.json");
    expect(agentsMd()).toContain("use the `calmonkey` command (`npx calmonkey` if it is not installed)");
  });
});
