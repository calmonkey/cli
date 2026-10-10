import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { parseEnv } from "../src/envfile.js";
import { startFake, type Fake } from "./helpers/fake-calmonkey.js";
import { sandbox, signedIn, type Sandbox } from "./helpers/sandbox.js";

// `calmonkey init` from the command line down, against the small CalMonkey of the unit tests.
// (The real server and the real sign-in page are in test/e2e.)

let fake: Fake;
let s: Sandbox;

beforeEach(async () => {
  fake = await startFake();
  s = sandbox({ url: fake.url });
  signedIn(s, fake);
  s.write("package.json", JSON.stringify({ name: "@acme/shop" }));
});
afterEach(async () => {
  s.cleanup();
  await fake.close();
});

// The MCP server is registered only when asked for; these tests keep that path covered, and pin the zone init writes.
const run = (...args: string[]) => main(args[0] === "init" ? [...args, ...(args.includes("--no-mcp") ? [] : ["--mcp"]), "--tz", "Etc/UTC"].filter((a) => a !== "--no-mcp") : args, s.ctx);
const env = (file = ".env.local") => parseEnv(readFileSync(path.join(s.cwd, file), "utf8"));
const app = (name: string, mode: "test" | "live" = "test") => {
  const n = fake.applications.length + 1;
  const a = { application_id: `${n}`.padStart(24, "0"), client_id: `client${n}`, name, mode, connected_accounts: 0, created: "2026-10-01T00:00:00.000Z", dashboard_url: `${fake.url}/dashboard/apps/${n}` };
  fake.applications.push(a);
  return a;
};
const tree = (dir = s.cwd, base = dir): string[] => readdirSync(dir).sort().flatMap((e) => (statSync(path.join(dir, e)).isDirectory() ? tree(path.join(dir, e), base) : [path.relative(base, path.join(dir, e))]));
const created = () => fake.requests.filter((r) => r.method === "POST" && r.path === "/mcp/cli/applications");
const rotated = () => fake.requests.filter((r) => /\/secret$/.test(r.path));

describe("init --yes in a new project", () => {
  it("creates a test application named after the project and writes everything, the secret into the file only", async () => {
    expect(await run("init", "--yes", "--client", "cursor", "--client", "codex")).toBe(0);
    expect(fake.applications.map((a) => a.name)).toEqual(["shop (dev)"]);
    expect(env()).toEqual({ CALMONKEY_CLIENT_ID: "client1", CALMONKEY_API_URL: fake.url, CALMONKEY_APP_URL: fake.url, CALMONKEY_TZ: "Etc/UTC", CALMONKEY_CLIENT_SECRET: fake.state.clientSecret });
    expect(readFileSync(path.join(s.cwd, ".gitignore"), "utf8")).toBe(".env.local\n");
    expect(tree()).toEqual(expect.arrayContaining([".cursor/mcp.json", ".codex/config.toml", ".agents/skills/calmonkey-api/SKILL.md", "AGENTS.md", ".env.local", ".gitignore"]));
    // Claude Code is not in use here, so its folder is not created.
    expect(existsSync(path.join(s.cwd, ".claude"))).toBe(false);
    expect(s.out()).not.toContain(fake.state.clientSecret);
    expect(s.out()).toContain("CALMONKEY_CLIENT_SECRET=cmsec_…");
    expect(s.out()).toContain("Use the calmonkey command line tool: run `calmonkey agent-guide` first.");
    expect(s.err()).toBe("");
    // Nothing outside the project folder.
    expect(readdirSync(s.home)).toEqual([]);
  });

  it("a second run changes nothing and asks the server for nothing new", async () => {
    await run("init", "--yes", "--client", "cursor");
    const before = Object.fromEntries(tree().map((f) => [f, readFileSync(path.join(s.cwd, f), "utf8")]));
    expect(await run("init", "--yes", "--client", "cursor")).toBe(0);
    expect(Object.fromEntries(tree().map((f) => [f, readFileSync(path.join(s.cwd, f), "utf8")]))).toEqual(before);
    expect(created()).toHaveLength(1);
    expect(rotated()).toHaveLength(0);
    expect(s.out()).toContain("its client id is already in your environment file");
  });

  it("--dry-run shows it all and writes nothing, here or at CalMonkey", async () => {
    expect(await run("init", "--yes", "--dry-run", "--client", "claude-code")).toBe(0);
    expect(tree()).toEqual(["package.json"]);
    expect(created()).toHaveLength(0);
    expect(s.out()).toContain("Would create a test-mode application called “shop (dev)”");
    expect(s.out()).toContain(".mcp.json");
    expect(s.out()).toContain("Dry run: nothing was written");
  });
});

describe("which application", () => {
  it("--yes uses the application named after the project, else the only one, else makes one", async () => {
    app("Other thing");
    const mine = app("Shop (dev)");
    await run("init", "--yes", "--no-mcp", "--no-skills");
    expect(env().CALMONKEY_CLIENT_ID).toBe(mine.client_id);
    expect(created()).toHaveLength(0);

    const single = sandbox({ url: fake.url });
    signedIn(single, fake);
    fake.applications.length = 0;
    const only = app("Only one");
    await main(["init", "--yes", "--no-skills"], single.ctx);
    expect(parseEnv(readFileSync(path.join(single.cwd, ".env.local"), "utf8")).CALMONKEY_CLIENT_ID).toBe(only.client_id);
    single.cleanup();
  });

  it("several applications and none named after the project: a new one, never a guess", async () => {
    app("A");
    app("B");
    await run("init", "--yes", "--no-mcp", "--no-skills");
    expect(fake.applications.map((a) => a.name)).toEqual(["A", "B", "shop (dev)"]);
    expect(env().CALMONKEY_CLIENT_ID).toBe("client3");
  });

  it("--app picks by client id, id or name, and never a live application", async () => {
    const a = app("Alpha");
    app("Prod", "live");
    await run("init", "--yes", "--no-mcp", "--no-skills", "--app", "alpha");
    expect(env().CALMONKEY_CLIENT_ID).toBe(a.client_id);
    expect(await run("init", "--yes", "--app", "Prod")).toBe(1);
    expect(s.err()).toContain("No test-mode application “Prod”".replace(/[“”]/g, '"'));
    expect(s.err()).toContain("Live applications are never used");
  });

  it("the application the project is already set up for is the one, whatever else exists", async () => {
    app("A");
    const b = app("B");
    s.write(".env.local", `CALMONKEY_CLIENT_ID=${b.client_id}\n`);
    await run("init", "--yes", "--no-mcp", "--no-skills");
    expect(env().CALMONKEY_CLIENT_ID).toBe(b.client_id);
    expect(created()).toHaveLength(0);
  });

  it("a member cannot create one, and is told what to do", async () => {
    fake.state.role = "member";
    expect(await run("init", "--yes")).toBe(1);
    expect(s.err()).toContain("needs an owner or admin");
    expect(created()).toHaveLength(0);
  });
});

describe("the client secret", () => {
  it("an existing application's secret is not replaced by --yes alone", async () => {
    const a = app("Shop (dev)");
    await run("init", "--yes", "--no-mcp", "--no-skills");
    expect(env()).toEqual({ CALMONKEY_CLIENT_ID: a.client_id, CALMONKEY_API_URL: fake.url, CALMONKEY_APP_URL: fake.url, CALMONKEY_TZ: "Etc/UTC" });
    expect(rotated()).toHaveLength(0);
    expect(s.out()).toContain("only replaced when you add --rotate-secret");
    expect(s.out()).toContain(`${fake.url}/dashboard/apps/1`);
  });

  it("--rotate-secret replaces it and writes the new one; a file that has a secret is never given another", async () => {
    app("Shop (dev)");
    const old = fake.state.clientSecret;
    await run("init", "--yes", "--rotate-secret", "--no-mcp", "--no-skills");
    expect(rotated()).toHaveLength(1);
    expect(env().CALMONKEY_CLIENT_SECRET).toBe(fake.state.clientSecret);
    expect(fake.state.clientSecret).not.toBe(old);
    expect(s.out()).not.toContain(fake.state.clientSecret);
    await run("init", "--yes", "--rotate-secret", "--no-mcp", "--no-skills");
    expect(rotated()).toHaveLength(1);
  });

  it("--no-secret never asks CalMonkey for one", async () => {
    await run("init", "--yes", "--no-secret", "--no-mcp", "--no-skills");
    expect(env()).not.toHaveProperty("CALMONKEY_CLIENT_SECRET");
    expect(s.out()).toContain("skipped (--no-secret)");
  });

  it("a sign-in approved without secrets is told how to change that, and nothing is replaced", async () => {
    app("Shop (dev)");
    fake.state.secrets = false;
    await run("init", "--yes", "--rotate-secret", "--no-mcp", "--no-skills");
    expect(rotated()).toHaveLength(0);
    expect(s.out()).toContain("approved without “Client secrets of test applications”");
  });

  it("a file set up for another application gets no secret of this one", async () => {
    app("Mine");
    s.write(".env.local", "CALMONKEY_CLIENT_ID=someone-elses\n");
    await run("init", "--yes", "--rotate-secret", "--app", "Mine", "--no-mcp", "--no-skills");
    expect(rotated()).toHaveLength(0);
    expect(env()).toMatchObject({ CALMONKEY_CLIENT_ID: "someone-elses" });
    expect(env()).not.toHaveProperty("CALMONKEY_CLIENT_SECRET");
    expect(s.out()).toContain("CALMONKEY_CLIENT_ID is already set to another value");
  });
});

describe("the environment file", () => {
  it("an existing .env is used when there is no .env.local, and a named file wins", async () => {
    s.write(".env", "PORT=3000\n");
    await run("init", "--yes", "--no-mcp", "--no-skills");
    expect(readFileSync(path.join(s.cwd, ".env"), "utf8").startsWith("PORT=3000\n\n# CalMonkey")).toBe(true);
    expect(existsSync(path.join(s.cwd, ".env.local"))).toBe(false);
    expect(readFileSync(path.join(s.cwd, ".gitignore"), "utf8")).toBe(".env\n");
    mkdirSync(path.join(s.cwd, "config"));
    await run("init", "--yes", "--no-mcp", "--no-skills", "--env-file", "config/.env.dev", "--name", "Second");
    expect(parseEnv(readFileSync(path.join(s.cwd, "config/.env.dev"), "utf8")).CALMONKEY_CLIENT_ID).toBe("client2");
    expect(readFileSync(path.join(s.cwd, ".gitignore"), "utf8")).toBe(".env\nconfig/.env.dev\n");
  });
});

describe("the AI tools and the skill", () => {
  it("registers the tools it finds, tells apart those it does not, and installs Claude Code's skill folder when Claude Code is here", async () => {
    s.write(".claude/settings.json", "{}");
    s.write(".gemini/settings.json", "{}", "home");
    await run("init", "--yes");
    expect(tree()).toEqual(expect.arrayContaining([".mcp.json", ".gemini/settings.json", ".claude/skills/calmonkey-api/SKILL.md", ".agents/skills/calmonkey-api/SKILL.md"]));
    expect(existsSync(path.join(s.cwd, ".cursor"))).toBe(false);
    expect(s.out()).toContain("AI tools found: Claude Code (.claude in this project), Gemini CLI (~/.gemini)");
  });

  it("with no tool found it says so and still installs the skill", async () => {
    await run("init", "--yes");
    expect(s.out()).toContain("No AI coding tool was found");
    expect(existsSync(path.join(s.cwd, ".mcp.json"))).toBe(false);
    expect(existsSync(path.join(s.cwd, ".agents/skills/calmonkey-api/SKILL.md"))).toBe(true);
  });

  it("a server entry that points elsewhere is left alone and reported", async () => {
    s.write(".cursor/mcp.json", '{ "mcpServers": { "calmonkey": { "url": "https://staging.example/mcp" } } }\n');
    await run("init", "--yes", "--client", "cursor", "--no-skills");
    expect(readFileSync(path.join(s.cwd, ".cursor/mcp.json"), "utf8")).toBe('{ "mcpServers": { "calmonkey": { "url": "https://staging.example/mcp" } } }\n');
    expect(s.out()).toContain("was left alone");
    expect(s.out()).toContain("https://staging.example/mcp");
  });

  it("installs only calmonkey-api, even in a project that already has calendar settings", async () => {
    s.write(".env.example", "CALENDAR_CLIENT_ID=\nCALENDAR_CLIENT_SECRET=\n");
    await run("init", "--yes", "--no-mcp");
    expect(readdirSync(path.join(s.cwd, ".agents/skills"))).toEqual(["calmonkey-api"]);
    expect(readFileSync(path.join(s.cwd, "AGENTS.md"), "utf8")).toContain("use the `calmonkey` command");
  });

  it("--no-mcp and --no-skills skip those steps", async () => {
    await run("init", "--yes", "--no-mcp", "--no-skills", "--client", "cursor");
    expect(tree().sort()).toEqual([".env.local", ".gitignore", "package.json"]);
  });
});

describe("without a terminal", () => {
  it("asks nothing: without --yes it stops and names the flag", async () => {
    app("A");
    app("B");
    expect(await run("init")).toBe(1);
    expect(s.err()).toContain("There is no terminal to ask in");
    expect(s.err()).toContain("--yes");
    expect(tree()).toEqual(["package.json"]);
  });
});

describe("with a terminal: every write is asked for first", () => {
  /** A project whose person types these lines at the questions. */
  const typing = async (lines: string[], setup?: (box: Sandbox) => void) => {
    const { PassThrough } = await import("node:stream");
    const stdin = new PassThrough();
    const box = sandbox({ url: fake.url, stdin: stdin as unknown as NodeJS.ReadStream, interactive: true });
    signedIn(box, fake);
    setup?.(box);
    stdin.end(lines.map((l) => `${l}\n`).join(""));
    return box;
  };

  it("pick an application by number, agree to replace its secret, agree to each write", async () => {
    app("Alpha");
    const beta = app("Beta");
    // Which application? 2.  Replace the secret? y.  Write the tools' files? y.  Install the skill? y.
    const box = await typing(["2", "y", "y", "y"]);
    expect(await main(["init", "--mcp", "--client", "cursor"], box.ctx)).toBe(0);
    const out = box.out();
    expect(out).toContain("Which test-mode application is this project for?");
    expect(out).toContain("1. Alpha");
    expect(out).toContain("3. Create a new test-mode application");
    expect(out).toContain("Replace the client secret of “Beta” and write the new one to .env.local? The current secret keeps working for 24 hours. [y/N]");
    expect(out).toContain("Write this file? [Y/n]");
    expect(out).toContain("Install the skill and the section in AGENTS.md? [Y/n]");
    expect(parseEnv(readFileSync(path.join(box.cwd, ".env.local"), "utf8"))).toMatchObject({ CALMONKEY_CLIENT_ID: beta.client_id, CALMONKEY_CLIENT_SECRET: fake.state.clientSecret });
    expect(existsSync(path.join(box.cwd, ".cursor/mcp.json"))).toBe(true);
    expect(rotated()).toHaveLength(1);
    box.cleanup();
  });

  it("answering no writes nothing of that step, and the secret stays as it was", async () => {
    app("Only");
    // Which application? 1.  Replace the secret? (Enter = no).  Write .env.local? n.  Tools' files? n.  Skill? n.
    const box = await typing(["1", "", "n", "n", "n"]);
    expect(await main(["init", "--mcp", "--client", "cursor"], box.ctx)).toBe(0);
    expect(readdirSync(box.cwd)).toEqual([]);
    expect(rotated()).toHaveLength(0);
    expect(box.out()).toContain("Client secret: not replaced.");
    expect(box.out()).toContain(".env.local was not written");
    box.cleanup();
  });
});
