import { createHmac } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makePerson, makeProject, runCli, runWithSignIn, serverAvailable, signatureValid, startReceiver, startServer, waitFor, type Person, type Project, type Server } from "./harness.js";

// The whole thing as a developer meets it, against a real CalMonkey on this machine: `init`
// (browser sign-in played over HTTP, a test application, the environment file with a working
// secret, every AI tool's file, the skill), a second `init` that changes nothing, `doctor`,
// `listen` delivering a signed notification to a local endpoint, and `logout`.

const unavailable = serverAvailable();
const SECRET = /cmsec_[A-Za-z0-9_-]{20,}/;
const ALL_CLIENTS = ["claude-code", "cursor", "vscode", "codex", "gemini", "windsurf"].flatMap((c) => ["--client", c]);

/** Every file of the project with its content, to compare two states of it. */
function snapshot(dir: string, base = dir, out: Record<string, string> = {}): Record<string, string> {
  for (const entry of readdirSync(dir).sort()) {
    if (entry === ".git") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) snapshot(full, base, out);
    else out[path.relative(base, full)] = readFileSync(full, "utf8");
  }
  return out;
}

describe.skipIf(unavailable)("calmonkey against a local CalMonkey", () => {
  let server: Server;
  let person: Person;
  let project: Project;
  let clientId = "";
  let clientSecret = "";

  beforeAll(async () => {
    server = await startServer();
    person = makePerson(server);
    project = makeProject(server);
    writeFileSync(path.join(project.dir, "package.json"), JSON.stringify({ name: "booking-app", private: true }));
    writeFileSync(path.join(project.dir, "AGENTS.md"), "# Booking app\n\nRun `npm test` before committing.\n");
  }, 180_000);

  afterAll(async () => {
    project?.cleanup();
    await server?.stop();
  });

  it("init --dry-run signs in and writes nothing to the project", async () => {
    const before = snapshot(project.dir);
    const run = await runWithSignIn(project, person, ["init", "--yes", "--dry-run", "--wait", "--mcp", "--tz", "Australia/Melbourne", ...ALL_CLIENTS]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    // The approval page: the tool by name, and the tick for client secrets, ticked.
    expect(run.consent).toMatchObject({ clientName: "CalMonkey CLI", offersSecrets: true, secretsTicked: true });
    expect(run.consent!.html).toContain("a program on this computer (127.0.0.1:");
    expect(run.stdout).toContain("Would create a test-mode application called “booking-app (dev)”");
    expect(run.stdout).toContain("Dry run: nothing was written");
    for (const file of [".mcp.json", ".cursor/mcp.json", ".codex/config.toml", ".gemini/settings.json", ".devin/mcp_config.json"]) expect(run.stdout, file).toContain(file);
    expect(snapshot(project.dir)).toEqual(before);
  }, 90_000);

  it("init --yes sets the project up: application, environment file with a secret that works, every tool's file, the skill", async () => {
    // Already signed in by the run above: no browser this time.
    const run = await runCli(project, ["init", "--yes", "--wait", "--mcp", "--tz", "Australia/Melbourne", ...ALL_CLIENTS]).done;
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).not.toContain("/agent-auth/authorize");
    expect(run.stdout).toContain("Created the test-mode application “booking-app (dev)”");
    // The secret is never shown.
    expect(run.stdout).not.toMatch(SECRET);

    const env = readFileSync(path.join(project.dir, ".env.local"), "utf8");
    clientId = /^CALMONKEY_CLIENT_ID=(.+)$/m.exec(env)![1]!;
    clientSecret = /^CALMONKEY_CLIENT_SECRET=(.+)$/m.exec(env)![1]!;
    expect(clientSecret).toMatch(SECRET);
    expect(env).toContain(`CALMONKEY_API_URL=${server.url}`);
    expect(env).toContain(`CALMONKEY_APP_URL=${server.url}`);
    expect(statSync(path.join(project.dir, ".env.local")).mode & 0o077).toBe(0);
    expect(readFileSync(path.join(project.dir, ".gitignore"), "utf8")).toContain(".env.local");

    // The credentials are the application's real ones: they open an application calendar.
    const opened = await fetch(`${server.url}/v1/application_calendars`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, application_calendar_id: "e2e" }) });
    expect(opened.status).toBe(200);

    const mcp = `${server.url}/mcp`;
    expect(JSON.parse(readFileSync(path.join(project.dir, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { calmonkey: { type: "http", url: mcp } } });
    expect(JSON.parse(readFileSync(path.join(project.dir, ".cursor/mcp.json"), "utf8"))).toEqual({ mcpServers: { calmonkey: { url: mcp } } });
    expect(readFileSync(path.join(project.dir, ".codex/config.toml"), "utf8")).toBe(`[mcp_servers.calmonkey]\nurl = "${mcp}"\n`);
    expect(JSON.parse(readFileSync(path.join(project.dir, ".gemini/settings.json"), "utf8"))).toEqual({ mcpServers: { calmonkey: { httpUrl: mcp } } });
    expect(JSON.parse(readFileSync(path.join(project.dir, ".devin/mcp_config.json"), "utf8"))).toEqual({ mcpServers: { calmonkey: { url: mcp } } });
    // Nothing outside the project: the home folder is as empty as it was.
    expect(readdirSync(project.home)).toEqual([]);

    expect(existsSync(path.join(project.dir, ".agents/skills/calmonkey-api/SKILL.md"))).toBe(true);
    const agents = readFileSync(path.join(project.dir, "AGENTS.md"), "utf8");
    expect(agents.startsWith("# Booking app\n\nRun `npm test` before committing.\n")).toBe(true);
    expect(agents).toContain("<!-- BEGIN:calmonkey -->");
    expect(run.stdout).toContain("Use the calmonkey command line tool: run `calmonkey agent-guide` first.");
    expect(env).toContain("CALMONKEY_TZ=Australia/Melbourne");

    // The sign-in is kept for its owner only.
    expect(statSync(path.join(project.configDir, "credentials.json")).mode & 0o077).toBe(0);
  }, 90_000);

  it("the data commands against the real server: a calendar, events, free slots, a held delete, the request log, and no secret anywhere", async () => {
    const cm = async (...args: string[]) => runCli(project, args).done;
    const all: string[] = [];
    const ok = async (...args: string[]) => {
      const run = await cm(...args);
      all.push(run.stdout, run.stderr);
      expect(run.stderr, args.join(" ")).toBe("");
      expect(run.code, args.join(" ")).toBe(0);
      return run.stdout;
    };
    // The application has the calendar the test above opened ("e2e"), so the account is named here.
    const opened = await ok("calendars", "open-test", "cli-data");
    const account = /^account +(apc_[0-9a-f]{24})$/m.exec(opened)![1]!;
    const calendar = /^calendar +(cal_[0-9a-f]{24})$/m.exec(opened)![1]!;
    const short = account.slice(0, 12);

    expect((await cm("events", "list", "--from", "2026-11-01", "--to", "2026-12-01")).code).toBe(2);
    expect(await ok("status")).toMatch(/^signed in: "CLI e2e [0-9a-f]+" as owner \| test-mode applications only, event text shown, may write\napplication: "booking-app \(dev\)" \(test\)/);

    const written = await ok("events", "put", "booking-1", "--account", short, "--title", "Lash lift", "--description", "Bring the voucher", "--location", "12 Harbour St", "--start", "2026-11-03T10:00", "--duration", "1h");
    expect(written).toBe(`written booking-1 to calendar ${calendar.slice(0, 12)} (test application "booking-app (dev)") (new)\nwhen    Tue 2026-11-03 10:00-11:00 Australia/Melbourne (+11:00) = 2026-11-02T23:00Z\nguests  none added, nobody was emailed\ncheck: calmonkey events get booking-1\n`);
    await ok("events", "put", "standup-1", "--account", short, "--title", "Stand-up", "--start", "2026-11-03T09:00", "--duration", "15m", "--repeat", "weekly", "--on", "tue", "--count", "4", "--skip", "2026-11-17");

    const list = await ok("events", "list", "--account", short, "--from", "2026-11-01", "--to", "2026-12-01");
    expect(list.split("\n")[0]).toBe(`events 4 of 4 | account ${short} | 2026-11-01..2026-12-01 | Australia/Melbourne (+11:00)`);
    expect(list).toMatch(/^standup-1 {2}Tue 2026-11-03 09:00-09:15 {2}repeats,ours {2}"Stand-up"$/m);
    expect(list).toMatch(/^booking-1 {2}Tue 2026-11-03 10:00-11:00 {2}desc,ours {5}"Lash lift"$/m);
    expect(await ok("events", "list", "--account", short, "--from", "2026-11-01", "--to", "2026-12-01", "--count")).toContain("Tue 2026-11-03 2   Tue 2026-11-10 1   Tue 2026-11-24 1\nours 4");
    const page = await ok("events", "list", "--account", short, "--from", "2026-11-01", "--to", "2026-12-01", "--limit", "2");
    const next = /^2 more: calmonkey (.+)$/m.exec(page)![1]!;
    expect((await ok(...next.split(" "))).split("\n")[0]).toContain("events 3-4 of 4");

    // A partial change keeps what it does not name; an occurrence gets its own time.
    expect(await ok("events", "edit", "booking-1", "--account", short, "--title", "Lash lift and tint")).toContain("changed summary; every other field is as it was");
    const got = await ok("events", "get", "booking-1", "--account", short);
    expect(got).toContain('| title      "Lash lift and tint"');
    expect(got).toContain('| location   "12 Harbour St"');
    expect(got).toContain("|   Bring the voucher");
    expect(await ok("events", "edit", "standup-1", "--account", short, "--occurrence", "2026-11-10", "--start", "2026-11-10T15:00", "--duration", "15m")).toContain("occurrence 2026-11-10 only");
    expect(await ok("events", "list", "--account", short, "--from", "2026-11-10", "--to", "2026-11-11")).toContain("Tue 2026-11-10 15:00-15:15");
    expect(await ok("events", "get", "standup-1", "--account", short)).toContain("repeats   weekly on Tue, 4 times, last Tue 2026-11-24; skipped: 2026-11-17");

    // Free slots are worked out by the tool: Tuesday has 09:00-09:15 and 10:00-11:00 taken.
    const free = await ok("freebusy", "--free", "--duration", "45m", "--account", short, "--from", "2026-11-03", "--to", "2026-11-04");
    expect(free).toContain("Tue 2026-11-03  09:15-10:00  11:00-17:00\nfirst: Tue 2026-11-03 09:15-10:00 = 2026-11-02T22:15Z.");
    const busy = await ok("freebusy", "--account", short, "--from", "2026-11-03", "--to", "2026-11-04");
    expect(busy).toContain("Tue 2026-11-03  09:00-09:15  10:00-11:00");
    expect(busy).not.toContain("Lash");

    // A delete is described first, changes nothing, and the printed command carries it out.
    const held = await cm("events", "delete", "booking-1", "--account", short);
    all.push(held.stdout, held.stderr);
    expect(held.code).toBe(10);
    expect(held.stdout).toBe("");
    expect(held.stderr).toContain("NOT DONE: confirmation needed\nwould: Delete the event “booking-1”");
    expect(held.stderr).toContain('"Lash lift and tint" (third-party text), Tue 2026-11-03 10:00-11:00');
    expect(await ok("events", "get", "booking-1", "--account", short)).toContain("Lash lift and tint");
    const command = /^ {2}calmonkey (.+)$/m.exec(held.stderr)![1]!.split(" ");
    expect((await cm(...command.slice(0, -1), "cmmcf_wrong")).code).toBe(1);
    expect(await ok(...command)).toContain(`deleted booking-1 from calendar ${calendar.slice(0, 12)}`);
    // What was deleted can still be looked at, and says so.
    expect(await ok("events", "get", "booking-1", "--account", short)).toMatch(/^status .*DELETED$/m);
    expect(await ok("events", "list", "--account", short, "--from", "2026-11-03", "--to", "2026-11-04")).not.toContain("booking-1");

    // A time the clocks skip never reaches the server; an API refusal comes back with its key.
    expect((await cm("events", "put", "night-1", "--account", short, "--title", "Night", "--start", "2026-10-04T02:30", "--duration", "1h")).code).toBe(6);
    const refused = await cm("events", "put", "g-1", "--account", short, "--title", "With a guest", "--start", "2026-11-05T10:00", "--duration", "1h", "--guest", "grace@example.com");
    all.push(refused.stderr);
    expect(refused.code).toBe(6);
    expect(refused.stderr).toMatch(/^error attendees_unsupported \(HTTP 422, attendees/);

    // The request log has every call, marked as the tool's; a raw API call goes out with the project's own credentials.
    const log = await ok("logs", "requests", "--limit", "50", "--made-by", "ai");
    expect(log).toMatch(/CalMonkey CLI {2}MCP \/mcp\/cli\/tools\/upsert_event/);
    expect(await ok("logs", "requests", "--errors")).toMatch(/422 .*upsert_event/);
    const raw = await ok("api", "GET", "/v1/calendars", "--as", "cli-data");
    expect(raw).toMatch(/^HTTP 200 GET \/v1\/calendars \| request req_[0-9a-f]+ \| as application calendar "cli-data"\n\{"calendars":\[/);
    expect(await ok("logs", "requests", "--made-by", "app", "--limit", "5")).toContain("GET /v1/calendars");
    const guarded = await cm("api", "DELETE", `/v1/calendars/${calendar}/events`, "--as", "cli-data");
    expect(guarded.code).toBe(10);
    expect(guarded.stderr).toContain("would: Send DELETE");

    for (const text of all) expect(text).not.toMatch(/cmsec_[A-Za-z0-9_-]{8}|cmat_[A-Za-z0-9_-]{8}|cmmat_|cmmrt_|whsec_/);
    expect(all.join("")).not.toContain(clientSecret);
  }, 120_000);

  it("running init again changes nothing", async () => {
    const before = snapshot(project.dir);
    const run = await runCli(project, ["init", "--yes", "--wait", "--mcp", "--tz", "Australia/Melbourne", ...ALL_CLIENTS]).done;
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("its client id is already in your environment file");
    expect(run.stdout).not.toContain("Created the test-mode application");
    expect(run.stdout).toContain("already has one. Left as it is.");
    expect(snapshot(project.dir)).toEqual(before);
  }, 60_000);

  it("doctor finds everything in place", async () => {
    const run = await runCli(project, ["doctor"]).done;
    expect(run.stdout).toContain("CALMONKEY_CLIENT_ID is set in .env.local");
    expect(run.stdout).toContain("The client credentials are accepted");
    expect(run.stdout).toContain(`The MCP server answers at ${server.url}/mcp`);
    expect(run.stdout).toContain(`Signed in to ${person.orgName} as owner`);
    expect(run.stdout).toContain("is the test-mode application “booking-app (dev)”");
    expect(run.stdout).toContain("The calmonkey-api skill is installed");
    expect(run.stdout).not.toMatch(SECRET);
    expect(run.code).toBe(0);
    // And it notices a wrong secret.
    const bad = await runCli(project, ["doctor"], { env: { CALMONKEY_CLIENT_SECRET: "cmsec_wrongwrongwrongwrongwrongwrong" } }).done;
    expect(bad.stdout).toContain("The client id and secret are not accepted");
    expect(bad.code).toBe(1);
  }, 60_000);

  it("listen brings a notification to the local endpoint, signed by CalMonkey, and reports the answer", async () => {
    const receiver = await startReceiver();
    const callback = `${receiver.url}/webhooks/calmonkey`;
    // The developer's own code: open a calendar and register a channel at an address on this machine.
    const calendar = (await (await fetch(`${server.url}/v1/application_calendars`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, application_calendar_id: "listen" }) })).json()) as { access_token: string };
    const created = await fetch(`${server.url}/v1/channels`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${calendar.access_token}` }, body: JSON.stringify({ callback_url: callback }) });
    expect(created.status).toBe(200);
    const { channel } = (await created.json()) as { channel: { channel_id: string; signing_secret: string } };
    // CalMonkey does not send it itself.
    await new Promise((r) => setTimeout(r, 1500));
    expect(receiver.hits).toHaveLength(0);

    const listening = runCli(project, ["listen"], { timeoutMs: 60_000 });
    await waitFor(() => receiver.hits.length >= 1);
    const hit = receiver.hits[0]!;
    expect(hit.path).toBe("/webhooks/calmonkey");
    expect(JSON.parse(hit.body)).toMatchObject({ notification: { type: "verification" }, channel: { channel_id: channel.channel_id, callback_url: callback } });
    // The developer's verification code runs against the real thing: both signatures are CalMonkey's.
    expect(signatureValid(hit.headers["calmonkey-signature"] as string, channel.signing_secret, hit.body)).toBe(true);
    expect(hit.headers["calmonkey-hmac-sha256"]).toBe(createHmac("sha256", clientSecret).update(hit.body).digest("base64"));
    expect(hit.headers["calmonkey-delivery-id"]).toMatch(/^whd_[0-9a-f]{24}$/);
    expect(hit.headers["calmonkey-delivery-attempt"]).toBe("1");
    expect(hit.headers["user-agent"]).toBe("Calmonkey-Webhooks/1.0");
    await waitFor(() => /<--\s+\[200\] POST/.test(listening.output()));
    expect(listening.output()).toContain("Ready. Listening for test-mode notifications of “booking-app (dev)”");
    expect(listening.output()).toMatch(/-->\s+verification \[whd_/);
    // Reported as delivered: it is not handed over a second time.
    await new Promise((r) => setTimeout(r, 2500));
    expect(receiver.hits).toHaveLength(1);
    listening.stop();
    const ended = await listening.done;
    expect(ended.stdout).toContain("Stopped.");
    expect(ended.code).toBe(0);

    // --forward-to: every notification goes to the one address given.
    const other = await startReceiver((h) => (h.path === "/once" ? 200 : 500));
    const second = await fetch(`${server.url}/v1/channels`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${calendar.access_token}` }, body: JSON.stringify({ callback_url: `${receiver.url}/elsewhere` }) });
    expect(second.status).toBe(200);
    const forwarding = runCli(project, ["listen", "--forward-to", `${other.url}/once`], { timeoutMs: 60_000 });
    await waitFor(() => other.hits.length >= 1);
    expect(other.hits[0]!.path).toBe("/once");
    expect(receiver.hits).toHaveLength(1);
    await waitFor(() => /<--\s+\[200\] POST/.test(forwarding.output()));
    forwarding.stop();
    await forwarding.done;
    await receiver.close();
    await other.close();
  }, 120_000);

  it("a member is told what needs an owner or admin, and gets no secret", async () => {
    const member = makePerson(server, { memberOf: person.orgId });
    const theirs = makeProject(server);
    try {
      const run = await runWithSignIn(theirs, member, ["init", "--yes", "--wait", "--no-skills", "--app", clientId]);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain("you are a member, read only");
      expect(run.stdout).toContain("Client secret: only an owner or admin can fetch it.");
      const env = readFileSync(path.join(theirs.dir, ".env.local"), "utf8");
      expect(env).toContain(`CALMONKEY_CLIENT_ID=${clientId}`);
      expect(env).not.toContain("CALMONKEY_CLIENT_SECRET");
      const listening = await runCli(theirs, ["listen"], { timeoutMs: 30_000 }).done;
      expect(listening.code).toBe(1);
      expect(listening.stderr).toMatch(/read-only|owner or admin/);
    } finally {
      theirs.cleanup();
    }
  }, 90_000);

  it("a declined sign-in connects nothing", async () => {
    const other = makeProject(server);
    try {
      const run = await runWithSignIn(other, person, ["login", "--wait"], { decision: "deny" });
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("declined in the browser");
      expect(existsSync(path.join(other.configDir, "credentials.json"))).toBe(false);
    } finally {
      other.cleanup();
    }
  }, 60_000);

  it("logout ends the connection and forgets the sign-in", async () => {
    const run = await runCli(project, ["logout"]).done;
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Signed out. The connection was ended at CalMonkey");
    expect(existsSync(path.join(project.configDir, "credentials.json"))).toBe(false);
    const doctor = await runCli(project, ["doctor"]).done;
    expect(doctor.stdout).toContain("Not signed in");
    const listening = await runCli(project, ["listen"]).done;
    expect(listening.code).toBe(1);
    expect(listening.stderr).toContain("calmonkey login");
  }, 60_000);
});

describe.runIf(unavailable)("calmonkey against a local CalMonkey", () => {
  it.skip(`skipped: ${unavailable}`, () => {});
});
