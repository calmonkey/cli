import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { Context } from "./context.js";
import type { Ui } from "./ui.js";

// `init` in a project with a package.json adds this tool to it as a devDependency, at the
// version that is running, with the project's own package manager. Then `npx calmonkey`
// resolves to the project's copy (no download, no cache to write, the same version for
// everyone on the project) and package scripts can call `calmonkey`.
//
// Rules: only `calmonkey` is added, nothing else is changed by us (the package manager's own
// install command for one package); a project that already lists it keeps its version; it is
// offered first and skipped with --no-install; --dry-run prints the command only. Without a
// package.json nothing happens here.

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

/** Lock files, in the order they decide: the first found names the package manager. */
const LOCKFILES: [file: string, pm: PackageManager][] = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

type PackageJson = { packageManager?: unknown; dependencies?: Record<string, unknown>; devDependencies?: Record<string, unknown>; optionalDependencies?: Record<string, unknown> };

function readPackageJson(cwd: string): PackageJson | null {
  const file = path.join(cwd, "package.json");
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as PackageJson) : {};
  } catch {
    return {};
  }
}

/** Which package manager the project uses: its lock file, else the `packageManager` field, else npm. */
export function detectPackageManager(cwd: string): { pm: PackageManager; why: string } {
  for (const [file, pm] of LOCKFILES) if (existsSync(path.join(cwd, file))) return { pm, why: file };
  const field = readPackageJson(cwd)?.packageManager;
  if (typeof field === "string") {
    const name = field.split("@")[0]!.trim() as PackageManager;
    if (["npm", "pnpm", "yarn", "bun"].includes(name)) return { pm: name, why: `"packageManager" in package.json` };
  }
  return { pm: "npm", why: "no lock file" };
}

/** The command that adds exactly one package as a devDependency at an exact version. */
export function installCommand(pm: PackageManager, spec: string): { command: string; args: string[] } {
  switch (pm) {
    case "pnpm":
      return { command: "pnpm", args: ["add", "--save-dev", "--save-exact", spec] };
    case "yarn":
      return { command: "yarn", args: ["add", "--dev", "--exact", spec] };
    case "bun":
      return { command: "bun", args: ["add", "--dev", "--exact", spec] };
    default:
      return { command: "npm", args: ["install", "--save-dev", "--save-exact", spec] };
  }
}

/** Where package.json already lists this tool, if it does. */
export function declaredIn(cwd: string): { field: string; range: string } | null {
  const pkg = readPackageJson(cwd);
  if (!pkg) return null;
  for (const field of ["devDependencies", "dependencies", "optionalDependencies"] as const) {
    const range = pkg[field]?.calmonkey;
    if (typeof range === "string") return { field, range };
  }
  return null;
}

export const hasPackageJson = (cwd: string): boolean => existsSync(path.join(cwd, "package.json"));

export type RunResult = { code: number; output: string };
export type Runner = (command: string, args: string[], opts: { cwd: string; platform: NodeJS.Platform; env: NodeJS.ProcessEnv }) => Promise<RunResult>;

/** Runs a command without a shell (except on Windows, where npm and the others are `.cmd` files), collecting its output. */
export const runCommand: Runner = (command, args, opts) =>
  new Promise((resolve) => {
    let output = "";
    let child;
    try {
      child = spawn(command, args, { cwd: opts.cwd, env: opts.env, shell: opts.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ code: 127, output: error instanceof Error ? error.message : String(error) });
      return;
    }
    child.stdout?.on("data", (d: Buffer) => (output += d.toString()));
    child.stderr?.on("data", (d: Buffer) => (output += d.toString()));
    child.on("error", (error) => resolve({ code: 127, output: `${output}${error.message}` }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });

export type AddOutcome = {
  /** The project lists the tool now (or already did): the AGENTS.md section can say `npx calmonkey` runs the project's copy. */
  local: boolean;
  status: "no_package_json" | "already" | "skipped" | "dry_run" | "declined" | "added" | "failed" | "no_version";
};

/** Offers to add the tool to the project's devDependencies, and does it on a yes. */
export async function addToProject(ctx: Context, ui: Ui, opts: { install: boolean; dryRun: boolean; spec?: string; run?: Runner }): Promise<AddOutcome> {
  if (!hasPackageJson(ctx.cwd)) return { local: false, status: "no_package_json" };
  const declared = declaredIn(ctx.cwd);
  if (declared) {
    ui.ok(`package.json already lists calmonkey (${declared.field}: ${declared.range}). Left as it is.`);
    return { local: true, status: "already" };
  }
  if (!opts.install) {
    ui.info("Not added to package.json (--no-install).");
    return { local: false, status: "skipped" };
  }
  // A copy built from source has no version on the registry to pin.
  if (!opts.spec && /dev/.test(ctx.version)) {
    ui.info(`Not added to package.json: this copy of the tool (${ctx.version}) is not a published version.`);
    return { local: false, status: "no_version" };
  }
  const spec = opts.spec ?? `calmonkey@${ctx.version}`;
  const { pm, why } = detectPackageManager(ctx.cwd);
  const { command, args } = installCommand(pm, spec);
  const line = [command, ...args].join(" ");
  if (opts.dryRun) {
    ui.info(`Would add ${spec} to devDependencies with ${pm} (${why}):`);
    ui.block(line);
    return { local: false, status: "dry_run" };
  }
  ui.info(`Add ${spec} to devDependencies with ${pm} (${why}), so \`npx calmonkey\` runs this project's copy:`);
  ui.block(ui.paint("dim", line));
  if (!(await ui.confirm(`Run ${command} ${args[0]} now? Nothing else in package.json is changed.`))) {
    ui.info("Not added. `npx calmonkey` still works; it fetches the tool each time.");
    return { local: false, status: "declined" };
  }
  const result = await (opts.run ?? ctx.run)(command, args, { cwd: ctx.cwd, platform: ctx.platform, env: ctx.env });
  if (result.code !== 0) {
    ui.warn(`${command} failed (exit code ${result.code}). package.json is as ${command} left it; nothing else was changed by this tool.`);
    const tail = result.output.trim().split("\n").slice(-5).join("\n");
    if (tail) ui.block(ui.paint("dim", tail));
    ui.detail(`Run it yourself when ready: ${line}`);
    return { local: false, status: "failed" };
  }
  ui.ok(`Added ${spec} to devDependencies.`);
  return { local: true, status: "added" };
}
