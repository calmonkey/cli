import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseJsonc } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CLIENTS, CLIENT_IDS, applyPlans, detectClients, displayPath, isRegistered, onPath, planClients, type ClientId } from "../src/clients/index.js";
import { upsertJsonEntry } from "../src/clients/json.js";
import { upsertTomlServer } from "../src/clients/toml.js";
import { sandbox, type Sandbox } from "./helpers/sandbox.js";

// Every AI tool's settings file: the exact text that is written, into files that already hold
// other people's settings. Each case is a pair of fixture files (what was there, what must be
// there afterwards), compared byte for byte.

const URL_ = "https://mcp.calmonkey.com/mcp";
const fixture = (rel: string) => readFileSync(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url)), "utf8");

let s: Sandbox;
beforeEach(() => {
  s = sandbox();
});
afterEach(() => s.cleanup());

/** Plans one client against a project whose settings file holds `before` (or does not exist). */
function planFor(id: ClientId, before: string | null) {
  const target = CLIENTS[id].target(s.ctx, URL_);
  if (before !== null) {
    mkdirSync(path.dirname(target.file), { recursive: true });
    writeFileSync(target.file, before);
  }
  const [plan] = planClients(s.ctx, [CLIENTS[id]], URL_);
  return { plan: plan!, file: target.file };
}

describe("where each tool keeps its MCP servers", () => {
  it("project files, in each vendor's own shape", () => {
    const targets = Object.fromEntries(CLIENT_IDS.map((id) => [id, CLIENTS[id].target(s.ctx, URL_)]));
    expect(displayPath(s.ctx, targets["claude-code"]!.file)).toBe(".mcp.json");
    expect(targets["claude-code"]).toMatchObject({ scope: "project", container: "mcpServers", entry: { type: "http", url: URL_ } });
    expect(displayPath(s.ctx, targets.cursor!.file)).toBe(".cursor/mcp.json");
    expect(targets.cursor).toMatchObject({ scope: "project", container: "mcpServers", entry: { url: URL_ } });
    // VS Code reads the portable file Claude Code uses.
    expect(targets.vscode).toEqual(targets["claude-code"]);
    expect(displayPath(s.ctx, targets.codex!.file)).toBe(".codex/config.toml");
    expect(targets.codex).toMatchObject({ scope: "project", format: "toml" });
    expect(displayPath(s.ctx, targets.gemini!.file)).toBe(".gemini/settings.json");
    expect(targets.gemini).toMatchObject({ container: "mcpServers", entry: { httpUrl: URL_ } });
    expect(displayPath(s.ctx, targets.windsurf!.file)).toBe(".devin/mcp_config.json");
    expect(targets.windsurf).toMatchObject({ scope: "project", container: "mcpServers", entry: { url: URL_ } });
    // No entry carries a credential of any kind.
    for (const t of Object.values(targets)) expect(JSON.stringify(t.entry ?? {})).not.toMatch(/token|secret|authorization|header/i);
  });

  it("VS Code's own file is used when the project already has one", () => {
    s.write(".vscode/mcp.json", "{}");
    const target = CLIENTS.vscode.target(s.ctx, URL_);
    expect(displayPath(s.ctx, target.file)).toBe(".vscode/mcp.json");
    expect(target).toMatchObject({ container: "servers", entry: { type: "http", url: URL_ } });
  });

  it("a Windsurf from before the rename has only a file in the home folder, with its own name for the address", () => {
    mkdirSync(path.join(s.home, ".codeium", "windsurf"), { recursive: true });
    const legacy = CLIENTS.windsurf.target(s.ctx, URL_);
    expect(displayPath(s.ctx, legacy.file)).toBe("~/.codeium/windsurf/mcp_config.json");
    expect(legacy).toMatchObject({ scope: "user", entry: { serverUrl: URL_ } });
    // With Devin's settings folder there too, the project file wins.
    mkdirSync(path.join(s.home, ".config", "devin"), { recursive: true });
    expect(displayPath(s.ctx, CLIENTS.windsurf.target(s.ctx, URL_).file)).toBe(".devin/mcp_config.json");
  });
});

describe("a new file", () => {
  it.each([
    ["claude-code", `{\n  "mcpServers": {\n    "calmonkey": {\n      "type": "http",\n      "url": "${URL_}"\n    }\n  }\n}\n`],
    ["cursor", `{\n  "mcpServers": {\n    "calmonkey": {\n      "url": "${URL_}"\n    }\n  }\n}\n`],
    ["gemini", `{\n  "mcpServers": {\n    "calmonkey": {\n      "httpUrl": "${URL_}"\n    }\n  }\n}\n`],
    ["windsurf", `{\n  "mcpServers": {\n    "calmonkey": {\n      "url": "${URL_}"\n    }\n  }\n}\n`],
    ["codex", `[mcp_servers.calmonkey]\nurl = "${URL_}"\n`],
  ] as [ClientId, string][])("%s", (id, expected) => {
    const { plan, file } = planFor(id, null);
    expect(plan.edit.status).toBe("create");
    expect(plan.edit.content).toBe(expected);
    expect(existsSync(file)).toBe(false);
    expect(applyPlans([plan])).toEqual([file]);
    expect(readFileSync(file, "utf8")).toBe(expected);
    // Again: nothing to do.
    expect(planClients(s.ctx, [CLIENTS[id]], URL_)[0]!.edit.status).toBe("unchanged");
    expect(isRegistered(s.ctx, CLIENTS[id], URL_)).toBe(true);
  });

  it("an empty file is filled, not refused", () => {
    expect(planFor("cursor", "").plan.edit).toMatchObject({ status: "update", content: `{\n  "mcpServers": {\n    "calmonkey": {\n      "url": "${URL_}"\n    }\n  }\n}\n` });
    expect(planFor("codex", "\n").plan.edit).toMatchObject({ status: "update", content: `[mcp_servers.calmonkey]\nurl = "${URL_}"\n` });
  });
});

describe("a file that already holds other settings: everything stays, one entry is added", () => {
  const cases: [name: string, id: ClientId, before: string, after: string, setup?: () => void][] = [
    ["Claude Code / VS Code .mcp.json with other servers", "claude-code", "mcp-json/other-servers.in.json", "mcp-json/other-servers.out.json"],
    [".mcp.json without an mcpServers object, tab-indented", "claude-code", "mcp-json/no-container.in.json", "mcp-json/no-container.out.json"],
    ["Cursor mcp.json with comments and a trailing comma", "cursor", "cursor/with-comments.in.json", "cursor/with-comments.out.json"],
    ["VS Code's own .vscode/mcp.json (servers, four-space indent, inputs)", "vscode", "vscode/servers.in.json", "vscode/servers.out.json"],
    ["Gemini settings.json with other settings", "gemini", "gemini/settings.in.json", "gemini/settings.out.json"],
    ["Devin mcp_config.json", "windsurf", "devin/config.in.json", "devin/config.out.json"],
    ["Windsurf's file in the home folder", "windsurf", "windsurf-legacy/config.in.json", "windsurf-legacy/config.out.json", () => mkdirSync(path.join(s.home, ".codeium", "windsurf"), { recursive: true })],
    ["Codex config.toml with comments, tables and sub-tables", "codex", "codex/with-comments.in.toml", "codex/with-comments.out.toml"],
    ["Codex config.toml without a final newline", "codex", "codex/no-newline.in.toml", "codex/no-newline.out.toml"],
  ];

  it.each(cases)("%s", (_name, id, before, after, setup) => {
    setup?.();
    // VS Code's own format applies when its file exists.
    if (id === "vscode") s.write(".vscode/mcp.json", "{}");
    const { plan, file } = planFor(id, fixture(before));
    expect(plan.edit.status).toBe("update");
    expect(plan.edit.content).toBe(fixture(after));
    // Every character that was there is still there, in order.
    const original = fixture(before);
    let at = 0;
    for (const line of original.split("\n").map((l) => l.trim()).filter(Boolean)) {
      const found = plan.edit.content.indexOf(line.replace(/,$/, ""), at);
      expect(found, `line kept: ${line}`).toBeGreaterThanOrEqual(0);
      at = found;
    }
    applyPlans([plan]);
    // What was written still parses in its own format and has the entry.
    const written = readFileSync(file, "utf8");
    if (file.endsWith(".toml")) expect((parseToml(written) as { mcp_servers: Record<string, { url: string }> }).mcp_servers.calmonkey).toEqual({ url: URL_ });
    else {
      const errors: unknown[] = [];
      const root = parseJsonc(written, errors as never, { allowTrailingComma: true }) as Record<string, Record<string, Record<string, string>>>;
      expect(errors).toEqual([]);
      const entry = (root.mcpServers ?? root.servers)!.calmonkey!;
      expect(Object.values(entry)).toContain(URL_);
    }
    // And a second run changes nothing.
    const [again] = planClients(s.ctx, [CLIENTS[id]], URL_);
    expect(again!.edit.status).toBe("unchanged");
    expect(again!.edit.content).toBe(written);
    expect(applyPlans([again!])).toEqual([]);
  });
});

describe("an entry the person already has is theirs", () => {
  it("the same address, with their own additions: unchanged", () => {
    const before = fixture("mcp-json/registered.in.json");
    const { plan } = planFor("claude-code", before);
    expect(plan.edit).toEqual({ status: "unchanged", content: before });
    expect(planFor("codex", fixture("codex/registered.in.toml")).plan.edit.status).toBe("unchanged");
    // Gemini reads `url` as well as `httpUrl`: either one with our address counts.
    expect(planFor("gemini", fixture("gemini/registered-as-url.in.json")).plan.edit.status).toBe("unchanged");
  });

  it("another address under the same name: left alone, and said so", () => {
    const json = planFor("claude-code", fixture("mcp-json/conflict.in.json")).plan.edit;
    expect(json).toMatchObject({ status: "conflict", content: fixture("mcp-json/conflict.in.json") });
    expect((json as { reason: string }).reason).toContain("https://mcp.staging.example.com/mcp");
    const toml = planFor("codex", fixture("codex/conflict.in.toml")).plan.edit;
    expect(toml).toMatchObject({ status: "conflict", content: fixture("codex/conflict.in.toml") });
    expect((toml as { reason: string }).reason).toContain("http://localhost:3080/mcp");
    expect(applyPlans([planFor("codex", fixture("codex/conflict.in.toml")).plan])).toEqual([]);
  });

  it("TOML written in a form this tool does not edit: left alone", () => {
    for (const name of ["codex/dotted.in.toml", "codex/inline.in.toml"]) {
      const edit = upsertTomlServer(fixture(name), "calmonkey", URL_);
      expect(edit, name).toMatchObject({ status: "conflict", content: fixture(name) });
    }
    expect(upsertTomlServer('mcp_servers = { docs = { url = "https://x.example/mcp" } }\n', "calmonkey", URL_).status).toBe("conflict");
  });

  it("a file that is not valid JSON, or not an object: left alone", () => {
    expect(planFor("claude-code", fixture("mcp-json/invalid.in.json")).plan.edit).toMatchObject({ status: "invalid", content: fixture("mcp-json/invalid.in.json") });
    expect(upsertJsonEntry("[1, 2]", "mcpServers", "calmonkey", { url: URL_ }, URL_, ["url"]).status).toBe("invalid");
    expect(upsertJsonEntry('{"mcpServers": "nope"}', "mcpServers", "calmonkey", { url: URL_ }, URL_, ["url"]).status).toBe("invalid");
    expect(upsertJsonEntry('{"mcpServers": {"calmonkey": "a string"}}', "mcpServers", "calmonkey", { url: URL_ }, URL_, ["url"]).status).toBe("conflict");
  });

  it("Windows line endings are kept", () => {
    const edit = upsertJsonEntry('{\r\n  "mcpServers": {\r\n    "a": { "url": "https://a.example/mcp" }\r\n  }\r\n}\r\n', "mcpServers", "calmonkey", { url: URL_ }, URL_, ["url"]);
    expect(edit.content).toContain(`"calmonkey": {\r\n      "url": "${URL_}"\r\n    }`);
    expect(edit.content.replace(/\r\n/g, "")).not.toContain("\n");
    const toml = upsertTomlServer('model = "x"\r\n', "calmonkey", URL_);
    expect(toml.content).toBe(`model = "x"\r\n\r\n[mcp_servers.calmonkey]\r\nurl = "${URL_}"\r\n`);
  });
});

describe("one file for two tools", () => {
  it("Claude Code and VS Code share .mcp.json: planned and written once", () => {
    const plans = planClients(s.ctx, [CLIENTS["claude-code"], CLIENTS.vscode, CLIENTS.cursor], URL_);
    expect(plans.map((p) => [displayPath(s.ctx, p.file), p.clients.map((c) => c.id)])).toEqual([
      [".mcp.json", ["claude-code", "vscode"]],
      [".cursor/mcp.json", ["cursor"]],
    ]);
    expect(applyPlans(plans)).toHaveLength(2);
  });
});

describe("finding the tools", () => {
  it("nothing on an empty machine", () => {
    expect(detectClients(s.ctx)).toEqual([]);
  });

  it("by a folder in the project, a folder in the home directory, or a program on PATH", () => {
    s.write(".cursor/rules/x.mdc", "x");
    s.write(".codex/config.toml", "", "home");
    const bin = path.join(s.root, "bin");
    mkdirSync(bin);
    writeFileSync(path.join(bin, "gemini"), "#!/bin/sh\n");
    chmodSync(path.join(bin, "gemini"), 0o755);
    const ctx = { ...s.ctx, env: { PATH: bin } };
    expect(onPath(ctx, "gemini")).toBe(true);
    expect(onPath(ctx, "claude")).toBe(false);
    const found = detectClients(ctx);
    expect(found.map((d) => d.client.id)).toEqual(["cursor", "codex", "gemini"]);
    expect(found.map((d) => d.evidence[0])).toEqual([".cursor in this project", "~/.codex", "`gemini` on PATH"]);
  });

  it("each tool by each of its signs", () => {
    const signs: [ClientId, "cwd" | "home", string][] = [
      ["claude-code", "cwd", ".claude/settings.json"],
      ["claude-code", "cwd", "CLAUDE.md"],
      ["claude-code", "home", ".claude.json"],
      ["cursor", "home", ".cursor/mcp.json"],
      ["vscode", "cwd", ".vscode/settings.json"],
      ["vscode", "home", ".copilot/mcp-config.json"],
      ["codex", "cwd", ".codex/config.toml"],
      ["gemini", "home", ".gemini/settings.json"],
      ["windsurf", "cwd", ".devin/mcp_config.json"],
      ["windsurf", "home", ".config/devin/config.json"],
      ["windsurf", "home", ".codeium/windsurf/mcp_config.json"],
    ];
    for (const [id, base, rel] of signs) {
      const box = sandbox();
      box.write(rel, "{}", base);
      expect(detectClients(box.ctx).map((d) => d.client.id), `${id} by ${rel}`).toEqual([id]);
      box.cleanup();
    }
  });
});

describe("showing paths", () => {
  it("relative to the project, or from the home folder", () => {
    expect(displayPath(s.ctx, path.join(s.cwd, ".cursor", "mcp.json"))).toBe(".cursor/mcp.json");
    expect(displayPath(s.ctx, path.join(s.home, ".codeium", "windsurf", "mcp_config.json"))).toBe("~/.codeium/windsurf/mcp_config.json");
    expect(displayPath(s.ctx, "/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("JSON written in other ways", () => {
  const add = (text: string) => upsertJsonEntry(text, "mcpServers", "calmonkey", { url: URL_ }, URL_, ["url"]);

  it.each([
    ["empty braces", `{}\n`, `{\n  "mcpServers": {\n    "calmonkey": {\n      "url": "${URL_}"\n    }\n  }\n}\n`],
    ["an empty mcpServers object", `{\n  "mcpServers": {}\n}\n`, `{\n  "mcpServers": {\n    "calmonkey": {\n      "url": "${URL_}"\n    }\n  }\n}\n`],
    ["everything on one line", `{ "mcpServers": { "a": { "url": "https://a.example/mcp" } } }\n`, `{ "mcpServers": { "a": { "url": "https://a.example/mcp" }, "calmonkey": { "url": "${URL_}" } } }\n`],
    [
      "a comment after the last server",
      `{\n  "mcpServers": {\n    "a": { "url": "https://a.example/mcp" } // ours\n  }\n}\n`,
      `{\n  "mcpServers": {\n    "a": { "url": "https://a.example/mcp" }, // ours\n    "calmonkey": {\n      "url": "${URL_}"\n    }\n  }\n}\n`,
    ],
    [
      "only a comment inside mcpServers",
      `{\n  "mcpServers": {\n    // none so far\n  }\n}\n`,
      `{\n  "mcpServers": {\n    // none so far\n    "calmonkey": {\n      "url": "${URL_}"\n    }\n  }\n}\n`,
    ],
    [
      "a block comment and other top-level keys after mcpServers",
      `{\n  /* team servers */\n  "mcpServers": {\n    "a": {\n      "command": "x"\n    }\n  },\n  "other": true\n}\n`,
      `{\n  /* team servers */\n  "mcpServers": {\n    "a": {\n      "command": "x"\n    },\n    "calmonkey": {\n      "url": "${URL_}"\n    }\n  },\n  "other": true\n}\n`,
    ],
    ["no final newline", `{\n  "a": 1\n}`, `{\n  "a": 1,\n  "mcpServers": {\n    "calmonkey": {\n      "url": "${URL_}"\n    }\n  }\n}`],
  ])("%s", (_name, before, after) => {
    const edit = add(before);
    expect(edit.status).toBe("update");
    expect(edit.content).toBe(after);
    expect(add(edit.content)).toEqual({ status: "unchanged", content: after });
  });

  it("a name that looks like ours inside a string or a comment is not an entry", () => {
    const text = `{\n  // "calmonkey": { "url": "old" }\n  "mcpServers": {\n    "notes": { "url": "https://x.example/?q=calmonkey" }\n  }\n}\n`;
    const edit = add(text);
    expect(edit.status).toBe("update");
    expect(edit.content).toContain(`// "calmonkey": { "url": "old" }`);
    expect(edit.content.match(/"calmonkey": \{/g)).toHaveLength(2);
  });
});
