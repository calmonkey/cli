import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createContext, type Context } from "../../src/context.js";
import { saveSession } from "../../src/credentials.js";
import { createUi } from "../../src/ui.js";

// A project folder, a home folder and a place for the sign-in, all temporary; and a Context
// whose output is captured. Nothing of the machine the tests run on is read.

export type Sandbox = { root: string; cwd: string; home: string; ctx: Context; out: () => string; err: () => string; write: (rel: string, content: string, base?: "cwd" | "home") => string; cleanup: () => void };

export function sandbox(overrides: Partial<Context> & { url?: string } = {}): Sandbox {
  const root = mkdtempSync(path.join(os.tmpdir(), "calmonkey-test-"));
  const cwd = path.join(root, "project");
  const home = path.join(root, "home");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  let out = "";
  let err = "";
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream;
  stdout.on("data", (d: Buffer) => (out += d.toString()));
  stderr.on("data", (d: Buffer) => (err += d.toString()));
  const { url, ...rest } = overrides;
  const ctx = createContext({
    cwd,
    home,
    env: { PATH: "" },
    platform: "linux",
    configDir: path.join(root, "config"),
    stdin: new PassThrough() as unknown as NodeJS.ReadStream,
    stdout,
    stderr,
    interactive: false,
    version: "9.9.9-test",
    ...(url ? { endpoints: { app: url, api: url, mcp: `${url}/mcp` } } : {}),
    ...rest,
  });
  return {
    root,
    cwd,
    home,
    ctx,
    out: () => out,
    err: () => err,
    write: (rel, content, base = "cwd") => {
      const file = path.join(base === "cwd" ? cwd : home, rel);
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, content);
      return file;
    },
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

export const uiOf = (s: Sandbox, opts: { yes?: boolean } = {}) => createUi(s.ctx, opts);

/** Puts a working sign-in into the sandbox, as if `calmonkey login` had run against the fake. */
export function signedIn(s: Sandbox, fake: { url: string; state: { accessTokens: Set<string>; refreshTokens: Set<string> } }): void {
  fake.state.accessTokens.add("cmmat_test_access");
  fake.state.refreshTokens.add("cmmrt_test_refresh");
  saveSession(s.ctx, { client_id: `${fake.url}/agent-auth/cli/client.json`, access_token: "cmmat_test_access", refresh_token: "cmmrt_test_refresh", expires_at: Date.now() + 3600_000, scope: "calmonkey:test", resource: `${fake.url}/mcp`, signed_in_at: new Date().toISOString() });
}
