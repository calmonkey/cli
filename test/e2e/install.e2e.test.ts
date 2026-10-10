import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { addToProject, runCommand } from "../../src/install.js";
import { sandbox } from "../helpers/sandbox.js";
import { createUi } from "../../src/ui.js";

// The one test that runs a real package manager: `npm install` of this package, packed, in a
// throw-away project. Needs `npm run build` first (npm run test:e2e does it) and npm on PATH.

const root = path.resolve(import.meta.dirname, "../..");
let work: string;
let tarball: string;

beforeAll(() => {
  work = mkdtempSync(path.join(os.tmpdir(), "calmonkey-install-e2e-"));
  const packed = execFileSync("npm", ["pack", "--pack-destination", work, "--silent"], { cwd: root, encoding: "utf8" }).trim().split("\n").pop()!;
  tarball = path.join(work, packed);
}, 120_000);
afterAll(() => rmSync(work, { recursive: true, force: true }));

describe("init's install step with a real npm", () => {
  it("adds exactly calmonkey to devDependencies, and npx calmonkey runs the project's copy", async () => {
    const s = sandbox({ run: runCommand, env: { PATH: process.env.PATH, HOME: process.env.HOME, npm_config_cache: path.join(work, "npm-cache") } });
    const pkg = { name: "shop", version: "1.0.0", private: true, scripts: { start: "node index.js" } };
    writeFileSync(path.join(s.cwd, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    const ui = createUi(s.ctx, { yes: true });
    const outcome = await addToProject(s.ctx, ui, { install: true, dryRun: false, spec: tarball });
    ui.close();
    expect(outcome).toEqual({ local: true, status: "added" });
    const after = JSON.parse(readFileSync(path.join(s.cwd, "package.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(after.devDependencies as object)).toEqual(["calmonkey"]);
    expect(after.dependencies).toBeUndefined();
    expect(after.scripts).toEqual(pkg.scripts);
    const version = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")).version as string;
    expect(execFileSync("npx", ["--no-install", "calmonkey", "--version"], { cwd: s.cwd, encoding: "utf8", env: { ...process.env, npm_config_cache: path.join(work, "npm-cache") } }).trim()).toBe(version);
    s.cleanup();
  }, 180_000);
});
