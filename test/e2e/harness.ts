import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import net, { type AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// What the end-to-end test needs around the tool itself: a CalMonkey on this machine, a person
// with a dashboard session (played over HTTP: no Google, no real browser), and a way to run
// the built CLI as a user would.
//
//   CALMONKEY_E2E_SERVER_DIR   a CalMonkey checkout (default: ../calmonkey beside this repository)
//   CALMONKEY_E2E_URL          use a CalMonkey that is already running there (e.g. http://localhost:3080)
//                              instead of starting one. It must have WEBHOOK_RELAY=true for `listen`.

export const REPO = fileURLToPath(new URL("../../", import.meta.url));
export const CLI = path.join(REPO, "dist", "cli.js");

export const serverDir = () => path.resolve(process.env.CALMONKEY_E2E_SERVER_DIR ?? path.join(REPO, "..", "calmonkey"));

/** Is there a CalMonkey checkout to run against? The suite is skipped (with the reason) when not. */
export function serverAvailable(): string | null {
  const dir = serverDir();
  if (!existsSync(path.join(dir, "scripts", "e2e", "dev-session.ts"))) return `no CalMonkey checkout with scripts/e2e/dev-session.ts at ${dir} (set CALMONKEY_E2E_SERVER_DIR)`;
  if (!existsSync(path.join(dir, "node_modules"))) return `${dir} has no node_modules (run npm ci there)`;
  return null;
}

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      server.close(() => resolve(port));
    });
  });

export type Server = { url: string; stop: () => Promise<void> };

async function healthy(url: string): Promise<boolean> {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

/** The CalMonkey to test against: the running one named by CALMONKEY_E2E_URL, or one started from the checkout. */
export async function startServer(): Promise<Server> {
  const given = process.env.CALMONKEY_E2E_URL?.replace(/\/+$/, "");
  if (given) {
    if (!(await healthy(given))) throw new Error(`CALMONKEY_E2E_URL=${given} does not answer /api/health`);
    return { url: given, stop: async () => {} };
  }
  const port = await freePort();
  const url = `http://localhost:${port}`;
  // One origin for site, app and API, as in development: the MCP server then answers there too.
  const child: ChildProcess = spawn("npx", ["next", "dev", "--port", String(port)], {
    cwd: serverDir(),
    env: { ...process.env, CALMONKEY_SITE_URL: url, CALMONKEY_APP_URL: url, CALMONKEY_API_URL: url, CALMONKEY_MCP_URL: "", WEBHOOK_RELAY: "true", LOG_LEVEL: "warn", NODE_ENV: "development" },
    stdio: ["ignore", "pipe", "pipe"],
    detached: true,
  });
  let log = "";
  child.stdout?.on("data", (d: Buffer) => (log += d.toString()));
  child.stderr?.on("data", (d: Buffer) => (log += d.toString()));
  const stop = async () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
  };
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`CalMonkey did not start:\n${log.slice(-2000)}`);
    if (await healthy(url)) return { url, stop };
    await new Promise((r) => setTimeout(r, 500));
  }
  await stop();
  throw new Error(`CalMonkey did not answer within 90 s:\n${log.slice(-2000)}`);
}

export type Person = { cookie: string; email: string; orgId: string; orgName: string };

/** A signed-in dashboard user with a new organization, made by the server's own script in its development database. */
export function makePerson(server: Server, opts: { memberOf?: string } = {}): Person {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "calmonkey-e2e-person-")), "person.json");
  const res = spawnSync("npx", ["tsx", "scripts/e2e/dev-session.ts", "--out", out, ...(opts.memberOf ? ["--member-of", opts.memberOf] : [])], { cwd: serverDir(), env: { ...process.env, CALMONKEY_SITE_URL: server.url, CALMONKEY_APP_URL: server.url, CALMONKEY_API_URL: server.url }, encoding: "utf8" });
  if (res.status !== 0) throw new Error(`dev-session.ts failed: ${res.stderr || res.stdout}`);
  const person = JSON.parse(readFileSync(out, "utf8")) as Person;
  rmSync(path.dirname(out), { recursive: true, force: true });
  return person;
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;/g, "'");
const attr = (html: string, name: string) => new RegExp(`name="${name}"[^>]*\\bvalue="([^"]*)"|\\bvalue="([^"]*)"[^>]*name="${name}"`).exec(html)?.slice(1).find(Boolean);

export type ConsentPage = { html: string; offersSecrets: boolean; secretsTicked: boolean; clientName: string };

/**
 * The person in the browser: opens the address the tool printed, reads the approval page as the
 * dashboard renders it, and presses Connect (or Cancel). Returns what the page showed.
 */
export async function approveInBrowser(person: Person, authorizeUrl: string, opts: { decision?: "approve" | "deny"; secrets?: boolean } = {}): Promise<ConsentPage> {
  const origin = new URL(authorizeUrl).origin;
  const first = await fetch(authorizeUrl, { redirect: "manual" });
  if (first.status !== 302) throw new Error(`authorize answered ${first.status}: ${(await first.text()).slice(0, 300)}`);
  const consentUrl = new URL(first.headers.get("location")!, origin);
  const page = await fetch(consentUrl, { headers: { cookie: person.cookie } });
  const html = await page.text();
  if (page.status !== 200) throw new Error(`consent page answered ${page.status}`);
  const action = decode(/<form[^>]*action="([^"]+)"/.exec(html)?.[1] ?? "");
  const csrf = attr(html, "csrf");
  const request = attr(html, "request");
  if (!action || !csrf || !request) throw new Error("the consent page has no form");
  const secretsInput = /<input[^>]*name="secrets"[^>]*>/.exec(html)?.[0] ?? "";
  const info: ConsentPage = { html, offersSecrets: Boolean(secretsInput), secretsTicked: /\bchecked\b/.test(secretsInput), clientName: /<h1[^>]*>Connect (?:<!-- -->)?([^<]+?)(?:<!-- -->)? to CalMonkey\?/.exec(html)?.[1] ?? "" };
  const fields: Record<string, string> = { csrf, request, decision: opts.decision ?? "approve", org: person.orgId, details: "events" };
  // The tick as the page shows it, unless the test says otherwise.
  if (opts.secrets ?? info.secretsTicked) fields.secrets = "on";
  const answered = await fetch(action, { method: "POST", headers: { cookie: person.cookie, "content-type": "application/x-www-form-urlencoded", origin }, body: new URLSearchParams(fields) });
  const back = decode(/content="0;url=([^"]+)"/.exec(await answered.text())?.[1] ?? "");
  if (answered.status !== 200 || !back) throw new Error(`consent answered ${answered.status}`);
  // The browser follows the page to the tool's port on this machine.
  const landed = await fetch(back);
  if (!landed.ok) throw new Error(`the tool's callback answered ${landed.status}`);
  return info;
}

export type Run = { code: number | null; stdout: string; stderr: string };

export type Project = { dir: string; home: string; configDir: string; env: NodeJS.ProcessEnv; cleanup: () => void };

/** An empty project folder, an empty home folder and a place for the sign-in: nothing of this machine leaks into the run. */
export function makeProject(server: Server): Project {
  const root = mkdtempSync(path.join(os.tmpdir(), "calmonkey-e2e-"));
  const dir = path.join(root, "my-app");
  const home = path.join(root, "home");
  const configDir = path.join(root, "config");
  spawnSync("mkdir", ["-p", dir, home]);
  spawnSync("git", ["init", "-q"], { cwd: dir });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    USERPROFILE: home,
    CALMONKEY_APP_URL: server.url,
    CALMONKEY_API_URL: server.url,
    CALMONKEY_MCP_URL: `${server.url}/mcp`,
    CALMONKEY_CONFIG_DIR: configDir,
    NO_COLOR: "1",
  };
  return { dir, home, configDir, env, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

/** Runs the built CLI. `onOutput` sees stdout as it grows (to catch the sign-in address); `stop` ends a command that runs until stopped. */
export function runCli(project: Project, args: string[], opts: { onOutput?: (stdout: string) => void; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): { done: Promise<Run>; stop: () => void; output: () => string } {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: project.dir, env: { ...project.env, ...opts.env }, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => {
    stdout += d.toString();
    opts.onOutput?.(stdout);
  });
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  const timer = setTimeout(() => child.kill("SIGKILL"), opts.timeoutMs ?? 60_000);
  const done = new Promise<Run>((resolve) => child.on("close", (code) => (clearTimeout(timer), resolve({ code, stdout, stderr }))));
  return { done, stop: () => child.kill("SIGINT"), output: () => stdout };
}

/** Runs a command that signs in: waits for the address it prints and plays the person. */
export async function runWithSignIn(project: Project, person: Person, args: string[], opts: { decision?: "approve" | "deny"; secrets?: boolean } = {}): Promise<Run & { consent: ConsentPage | null }> {
  let consent: Promise<ConsentPage> | null = null;
  const run = runCli(project, args, {
    onOutput: (stdout) => {
      const url = /(https?:\/\/\S+\/agent-auth\/authorize\?\S+)/.exec(stdout)?.[1];
      if (url && !consent) consent = approveInBrowser(person, url, opts);
    },
  });
  const result = await run.done;
  return { ...result, consent: consent ? await (consent as Promise<ConsentPage>).catch((error: unknown) => ({ html: String(error), offersSecrets: false, secretsTicked: false, clientName: "" })) : null };
}

export type Hit = { path: string; headers: http.IncomingHttpHeaders; body: string };

/** A webhook endpoint on this machine, as the developer's own server would have. */
export async function startReceiver(answer: (hit: Hit) => number = () => 200): Promise<{ url: string; hits: Hit[]; close: () => Promise<void> }> {
  const hits: Hit[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const hit = { path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      hits.push(hit);
      res.writeHead(answer(hit)).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://localhost:${(server.address() as AddressInfo).port}`, hits, close: () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve()))) };
}

/** The receiver's side of `Calmonkey-Signature: t=<unix>,v1=<hex>`, as the docs describe it. */
export function signatureValid(header: string | undefined, signingSecret: string, rawBody: string): boolean {
  const parts = new Map((header ?? "").split(",").map((p) => p.trim().split("=", 2) as [string, string]));
  const t = parts.get("t");
  const v1 = parts.get("v1");
  if (!t || !v1) return false;
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false;
  return createHmac("sha256", signingSecret).update(`${t}.${rawBody}`, "utf8").digest("hex") === v1;
}

export const waitFor = async (what: () => boolean, timeoutMs = 20_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!what()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((r) => setTimeout(r, 100));
  }
};
