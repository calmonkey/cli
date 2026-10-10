import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { configDirFrom, endpointsFrom, isCi } from "../src/context.js";
import { proxyDecision, supportsEnvProxy } from "../src/proxy.js";
import { colourEnabled, createUi } from "../src/ui.js";
import { startFake, type Fake } from "./helpers/fake-calmonkey.js";
import { sandbox, signedIn, type Sandbox } from "./helpers/sandbox.js";

let s: Sandbox;
beforeEach(() => {
  s = sandbox();
});
afterEach(() => s.cleanup());

describe("the command line", () => {
  it("--version and --help", async () => {
    expect(await main(["--version"], s.ctx)).toBe(0);
    expect(s.out()).toBe("9.9.9-test\n");
    expect(await main(["--help"], s.ctx)).toBe(0);
    for (const word of ["calmonkey <command> [flags]", "status", "init", "agent-guide", "events list | get | put | edit | delete", "freebusy", "logs requests | webhooks", "listen", "doctor", "docs search", "schema <command>", "explain <code>", "mcp add", "login, logout", "--json", "--dry-run", "CALMONKEY_TZ"]) expect(s.out()).toContain(word);
  });

  it("no command, an unknown command and an unknown flag name the nearest real one, with exit code 2 and nothing on stdout", async () => {
    expect(await main([], s.ctx)).toBe(2);
    const before = s.out().length;
    expect(await main(["frobnicate"], s.ctx)).toBe(2);
    expect(s.err()).toContain('error unknown_command: no command "frobnicate"');
    expect(await main(["event"], s.ctx)).toBe(2);
    expect(s.err()).toContain("Did you mean: calmonkey events list");
    expect(await main(["init", "--frobnicate"], s.ctx)).toBe(2);
    expect(s.err()).toContain("calmonkey init has no flag --frobnicate");
    expect(await main(["events", "list", "--form", "today"], s.ctx)).toBe(2);
    expect(s.err()).toContain("Did you mean --from");
    expect(await main(["mcp"], s.ctx)).toBe(2);
    expect(s.err()).toContain('"mcp" needs a verb: add');
    expect(s.out().length).toBe(before);
  });
});

describe("mcp add", () => {
  it("writes the named tools' files with --yes, shows without writing with --dry-run", async () => {
    expect(await main(["mcp", "add", "--client", "cursor", "--dry-run"], s.ctx)).toBe(0);
    expect(existsSync(path.join(s.cwd, ".cursor"))).toBe(false);
    expect(s.out()).toContain('"url": "https://mcp.calmonkey.com/mcp"');
    expect(await main(["mcp", "add", "--client", "cursor", "--client", "claude", "--yes"], s.ctx)).toBe(0);
    expect(JSON.parse(readFileSync(path.join(s.cwd, ".cursor/mcp.json"), "utf8"))).toEqual({ mcpServers: { calmonkey: { url: "https://mcp.calmonkey.com/mcp" } } });
    expect(JSON.parse(readFileSync(path.join(s.cwd, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { calmonkey: { type: "http", url: "https://mcp.calmonkey.com/mcp" } } });
    expect(s.out()).toContain("Wrote .cursor/mcp.json");
  });

  it("without a terminal and without --yes it writes nothing and says why", async () => {
    expect(await main(["mcp", "add", "--client", "codex"], s.ctx)).toBe(1);
    expect(existsSync(path.join(s.cwd, ".codex"))).toBe(false);
    expect(s.err()).toContain("--yes");
  });

  it("an unknown tool name lists the names", async () => {
    expect(await main(["mcp", "add", "--client", "emacs", "--yes"], s.ctx)).toBe(1);
    expect(s.err()).toContain("claude-code, cursor, vscode, codex, gemini, windsurf");
  });

  it("uses the address from CALMONKEY_MCP_URL, with or without /mcp", async () => {
    const local = sandbox({ env: { PATH: "", CALMONKEY_MCP_URL: "http://localhost:3080" }, endpoints: endpointsFrom({ CALMONKEY_MCP_URL: "http://localhost:3080" }) });
    await main(["mcp", "add", "--client", "gemini", "--yes"], local.ctx);
    expect(JSON.parse(readFileSync(path.join(local.cwd, ".gemini/settings.json"), "utf8"))).toEqual({ mcpServers: { calmonkey: { httpUrl: "http://localhost:3080/mcp" } } });
    local.cleanup();
  });
});

describe("questions", () => {
  const answering = (input: string, opts: { yes?: boolean } = {}) => {
    const stdin = new PassThrough();
    const box = sandbox({ stdin: stdin as unknown as NodeJS.ReadStream, interactive: true });
    stdin.end(input);
    return { box, ui: createUi(box.ctx, opts) };
  };

  it("a yes/no question takes y, n, or the default on Enter", async () => {
    for (const [typed, fallback, expected] of [["y\n", false, true], ["n\n", true, false], ["\n", true, true], ["\n", false, false], ["maybe\nyes\n", false, true]] as const) {
      const { box, ui } = answering(typed);
      expect(await ui.confirm("Write it?", { default: fallback })).toBe(expected);
      box.cleanup();
    }
  });

  it("a choice is made by number; --yes takes the stated answer without asking", async () => {
    const { box, ui } = answering("2\n");
    expect(await ui.select("Which?", [{ label: "One", value: 1 }, { label: "Two", value: 2 }], { whenYes: 1 })).toBe(2);
    expect(box.out()).toContain("1. One");
    // The input has ended: every later question takes its default.
    expect(await ui.confirm("More?", { default: false })).toBe(false);
    expect(await ui.input("Name?", { default: "x" })).toBe("x");
    box.cleanup();
    const quiet = answering("", { yes: true });
    expect(await quiet.ui.select("Which?", [{ label: "One", value: 1 }], { whenYes: 1 })).toBe(1);
    expect(await quiet.ui.confirm("Replace?", { whenYes: false })).toBe(false);
    expect(await quiet.ui.input("Name?", { default: "x" })).toBe("x");
    expect(quiet.box.out()).toBe("");
    quiet.box.cleanup();
  });
});

describe("the environment", () => {
  it("the three addresses default to the live service and can each be pointed elsewhere", () => {
    expect(endpointsFrom({})).toEqual({ app: "https://app.calmonkey.com", api: "https://api.calmonkey.com", mcp: "https://mcp.calmonkey.com/mcp" });
    expect(endpointsFrom({ CALMONKEY_APP_URL: "http://localhost:3080/", CALMONKEY_API_URL: "http://localhost:3080", CALMONKEY_MCP_URL: "http://localhost:3080/mcp/" })).toEqual({ app: "http://localhost:3080", api: "http://localhost:3080", mcp: "http://localhost:3080/mcp" });
    expect(() => endpointsFrom({ CALMONKEY_APP_URL: "app.calmonkey.com" })).toThrow(/CALMONKEY_APP_URL is not a URL/);
    expect(() => endpointsFrom({ CALMONKEY_API_URL: "ftp://x" })).toThrow(/must start with https/);
    expect(() => endpointsFrom({ CALMONKEY_MCP_URL: "https://user:pw@mcp.example/mcp" })).toThrow(/user name or password/);
  });

  it("CI is recognised, so nothing is ever asked there", () => {
    expect(isCi({})).toBe(false);
    for (const name of ["CI", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "TF_BUILD"]) expect(isCi({ [name]: "true" }), name).toBe(true);
    expect(isCi({ CI: "false" })).toBe(false);
    expect(isCi({ CI: "" })).toBe(false);
    const stdin = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream;
    const stdout = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
    expect(sandbox({ stdin, stdout, interactive: undefined, env: {} }).ctx.interactive).toBe(true);
    expect(sandbox({ stdin, stdout, interactive: undefined, env: { CI: "1" } }).ctx.interactive).toBe(false);
  });

  it("the sign-in's folder: CALMONKEY_CONFIG_DIR, else the platform's place", () => {
    expect(configDirFrom({ CALMONKEY_CONFIG_DIR: "/tmp/x" }, "/home/a", "linux")).toBe("/tmp/x");
    expect(configDirFrom({}, "/home/a", "linux")).toBe("/home/a/.config/calmonkey");
    expect(configDirFrom({ XDG_CONFIG_HOME: "/cfg" }, "/home/a", "linux")).toBe("/cfg/calmonkey");
    expect(configDirFrom({ XDG_CONFIG_HOME: "relative" }, "/home/a", "darwin")).toBe("/home/a/.config/calmonkey");
    expect(configDirFrom({ APPDATA: "C:\\Users\\a\\AppData\\Roaming" }, "C:\\Users\\a", "win32")).toContain("calmonkey");
  });

  it("NO_COLOR wins, FORCE_COLOR turns colour on, otherwise only a terminal gets colour", () => {
    expect(colourEnabled({}, { isTTY: true })).toBe(true);
    expect(colourEnabled({}, { isTTY: false })).toBe(false);
    expect(colourEnabled({ NO_COLOR: "1" }, { isTTY: true })).toBe(false);
    expect(colourEnabled({ NO_COLOR: "" }, { isTTY: true })).toBe(true);
    expect(colourEnabled({ NO_COLOR: "1", FORCE_COLOR: "1" }, { isTTY: true })).toBe(false);
    expect(colourEnabled({ FORCE_COLOR: "1" }, { isTTY: false })).toBe(true);
    expect(colourEnabled({ FORCE_COLOR: "0" }, { isTTY: true })).toBe(false);
    expect(colourEnabled({ TERM: "dumb" }, { isTTY: true })).toBe(false);
    // No escape codes reach a pipe.
    const ui = createUi(s.ctx);
    ui.ok("done");
    ui.warn("careful");
    expect(s.out()).toBe("✓ done\n! careful\n");
  });

  it("a proxy in the environment is honoured where Node can, by starting once more with its own setting", () => {
    expect(proxyDecision({}, "22.21.0")).toBe("none");
    expect(proxyDecision({ HTTPS_PROXY: "http://proxy:8080" }, "22.21.0")).toBe("restart");
    expect(proxyDecision({ https_proxy: "http://proxy:8080" }, "24.5.0")).toBe("restart");
    expect(proxyDecision({ HTTP_PROXY: "http://proxy:8080", NODE_USE_ENV_PROXY: "1" }, "24.5.0")).toBe("active");
    expect(proxyDecision({ HTTPS_PROXY: "http://proxy:8080" }, "20.12.0")).toBe("unsupported");
    expect(proxyDecision({ NO_PROXY: "localhost" }, "24.5.0")).toBe("none");
    expect([supportsEnvProxy("22.20.9"), supportsEnvProxy("22.21.0"), supportsEnvProxy("23.9.0"), supportsEnvProxy("24.4.0"), supportsEnvProxy("24.5.0"), supportsEnvProxy("26.0.0")]).toEqual([false, true, false, false, true, true]);
  });
});

describe("login and logout from the command line", () => {
  let fake: Fake;
  beforeEach(async () => {
    fake = await startFake();
  });
  afterEach(() => fake.close());

  it("logout says so when there is nothing to sign out of, and ends a sign-in when there is", async () => {
    const box = sandbox({ url: fake.url });
    expect(await main(["logout"], box.ctx)).toBe(0);
    expect(box.out()).toContain("Not signed in.");
    signedIn(box, fake);
    expect(await main(["logout"], box.ctx)).toBe(0);
    expect(box.out()).toContain("Signed out. The connection was ended at CalMonkey");
    expect(fake.state.revoked).toEqual(["cmmrt_test_refresh"]);
    box.cleanup();
  });

  it("a command that needs the sign-in says how to get one", async () => {
    const box = sandbox({ url: fake.url });
    box.write(".env.local", "CALMONKEY_CLIENT_ID=client1\n");
    expect(await main(["listen"], box.ctx)).toBe(1);
    expect(box.err()).toContain("Not signed in. Run: calmonkey login");
    box.cleanup();
  });
});
