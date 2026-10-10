import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { RESOLVED } from "./helpers/fixtures.js";
import { startFake, type Fake } from "./helpers/fake-calmonkey.js";
import { sandbox, signedIn, type Sandbox } from "./helpers/sandbox.js";

// CALMONKEY_TOKEN: a token a person made for an agent with no browser, used instead of the
// stored sign-in, never printed. And `calmonkey token create | list | revoke` for that person.

let fake: Fake;
let s: Sandbox;
const MACHINE = `cmmmt_${"m".repeat(43)}`;

beforeEach(async () => {
  fake = await startFake();
  fake.tool = () => ({ status: 200, body: { result: { organization: "Acme", your_role: "owner", applications: [], live_applications_not_included: 0, this_connection: { live_applications: "none", event_details: false } }, resolved: RESOLVED } });
});
afterEach(async () => {
  s?.cleanup();
  await fake.close();
});

const bearers = () => fake.requests.filter((r) => r.path.startsWith("/mcp/cli/")).map((r) => r.headers.authorization);

describe("CALMONKEY_TOKEN", () => {
  it("is used instead of the stored sign-in, and never printed", async () => {
    s = sandbox({ url: fake.url, env: { PATH: "", CALMONKEY_TOKEN: MACHINE, CALMONKEY_TZ: "Etc/UTC" } });
    signedIn(s, fake);
    fake.state.machineTokens.add(MACHINE);
    expect(await main(["apps", "list"], s.ctx)).toBe(0);
    expect(await main(["status"], s.ctx)).toBe(0);
    expect(bearers().every((b) => b === `Bearer ${MACHINE}`)).toBe(true);
    expect(s.out()).toContain('signed in with a machine token (CALMONKEY_TOKEN) "CI", expires 2026-11-01');
    expect(s.out() + s.err()).not.toContain(MACHINE.slice(6));
  });

  it("works with no stored sign-in at all, and asks the sign-in server for nothing", async () => {
    s = sandbox({ url: fake.url, env: { PATH: "", CALMONKEY_TOKEN: MACHINE } });
    fake.state.machineTokens.add(MACHINE);
    expect(await main(["apps", "list"], s.ctx)).toBe(0);
    expect(fake.requests.filter((r) => r.path.includes("oauth") || r.path.includes("agent-auth"))).toEqual([]);
  });

  it("refused (expired or revoked): exit code 3, says so, does not tell an agent to log in", async () => {
    s = sandbox({ url: fake.url, env: { PATH: "", CALMONKEY_TOKEN: MACHINE } });
    expect(await main(["apps", "list"], s.ctx)).toBe(3);
    expect(s.err()).toContain("error token_refused: CALMONKEY_TOKEN was refused: it has expired, was revoked");
    expect(s.err()).not.toContain(MACHINE.slice(6));
  });

  it("set to something that is not a machine token: exit code 3 at once, nothing sent, the value not echoed", async () => {
    s = sandbox({ url: fake.url, env: { PATH: "", CALMONKEY_TOKEN: "cmsec_notamachinetokenatallxxxxxxxxxxxxxxx" } });
    expect(await main(["apps", "list"], s.ctx)).toBe(3);
    expect(s.err()).toContain("error bad_token");
    expect(s.err()).not.toContain("notamachinetoken");
    expect(fake.requests).toEqual([]);
  });

  it("whatever prints a machine token by accident, prints it redacted", async () => {
    s = sandbox({ url: fake.url, env: { PATH: "", CALMONKEY_TOKEN: MACHINE } });
    fake.state.machineTokens.add(MACHINE);
    fake.tool = () => ({ status: 200, body: { result: { organization: `leak ${MACHINE}`, your_role: "owner", applications: [], live_applications_not_included: 0 }, resolved: RESOLVED } });
    expect(await main(["apps", "list"], s.ctx)).toBe(0);
    expect(s.out()).not.toContain(MACHINE.slice(6));
    expect(s.out()).toContain("[redacted]");
  });
});

describe("calmonkey token create | list | revoke", () => {
  it("create: only in a person's own terminal; prints the token once with what to do", async () => {
    s = sandbox({ url: fake.url });
    signedIn(s, fake);
    expect(await main(["token", "create", "--name", "Codex cloud"], s.ctx)).toBe(3);
    expect(s.err()).toContain("error needs_person");
    expect(fake.madeTokens).toEqual([]);
    s.cleanup();

    s = sandbox({ url: fake.url, interactive: true });
    signedIn(s, fake);
    expect(await main(["token", "create", "--name", "Codex cloud", "--days", "30", "--may-write"], s.ctx)).toBe(0);
    expect(fake.madeTokens).toHaveLength(1);
    const made = fake.madeTokens[0]!;
    expect(JSON.parse(fake.requests.find((r) => r.path === "/mcp/cli/tokens" && r.method === "POST")!.body)).toEqual({ name: "Codex cloud", days: 30, may_write: true });
    expect(s.out()).toContain(made.token);
    expect(s.out()).toContain("Set it as CALMONKEY_TOKEN");
    expect(s.out()).toContain(`calmonkey token revoke ${made.connection_id}`);
  });

  it("create checks its flags before anything is sent", async () => {
    s = sandbox({ url: fake.url, interactive: true });
    signedIn(s, fake);
    expect(await main(["token", "create"], s.ctx)).toBe(2);
    expect(await main(["token", "create", "--name", "x", "--days", "365"], s.ctx)).toBe(2);
    expect(fake.requests.filter((r) => r.path === "/mcp/cli/tokens")).toEqual([]);
  });

  it("list shows them without the tokens; revoke ends one", async () => {
    s = sandbox({ url: fake.url, interactive: true });
    signedIn(s, fake);
    await main(["token", "create", "--name", "CI"], s.ctx);
    const made = fake.madeTokens[0]!;
    s.cleanup();
    s = sandbox({ url: fake.url });
    signedIn(s, fake);
    expect(await main(["token", "list"], s.ctx)).toBe(0);
    expect(s.out()).toContain(made.connection_id);
    expect(s.out()).not.toContain(made.token.slice(6));
    expect(await main(["token", "revoke", made.connection_id], s.ctx)).toBe(0);
    expect(fake.madeTokens).toEqual([]);
    expect(await main(["token", "revoke", made.connection_id], s.ctx)).toBe(4);
  });

  it("with CALMONKEY_TOKEN set they are refused here, before anything is sent", async () => {
    s = sandbox({ url: fake.url, interactive: true, env: { PATH: "", CALMONKEY_TOKEN: MACHINE } });
    expect(await main(["token", "list"], s.ctx)).toBe(5);
    expect(s.err()).toContain("error needs_person");
    expect(fake.requests).toEqual([]);
  });
});
