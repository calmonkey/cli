import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { startFake, type Fake } from "./helpers/fake-calmonkey.js";
import { sandbox, signedIn, type Sandbox } from "./helpers/sandbox.js";

let fake: Fake;
let s: Sandbox;

beforeEach(async () => {
  fake = await startFake();
  s = sandbox({ url: fake.url });
  fake.applications.push({ application_id: "0".repeat(23) + "1", client_id: "client1", name: "Shop (dev)", mode: "test", connected_accounts: 0, created: "", dashboard_url: "" });
});
afterEach(async () => {
  s.cleanup();
  await fake.close();
});

describe("calmonkey doctor", () => {
  it("everything in place: exit code 0, and no secret shown", async () => {
    signedIn(s, fake);
    await main(["init", "--yes", "--mcp", "--client", "cursor", "--rotate-secret"], s.ctx);
    const before = s.out().length;
    expect(await main(["doctor"], s.ctx)).toBe(0);
    const out = s.out().slice(before);
    for (const line of ["✓ Node ", "✓ CALMONKEY_CLIENT_ID is set in .env.local", "✓ CALMONKEY_CLIENT_SECRET is set in .env.local", "✓ The client credentials are accepted by", `✓ The MCP server answers at ${fake.url}/mcp`, "✓ Signed in to Acme as owner", "✓ CALMONKEY_CLIENT_ID is the test-mode application “Shop (dev)”", "✓ The MCP server is registered for: Cursor", "✓ The calmonkey-api skill is installed in this project", "Everything is in place."]) expect(out).toContain(line);
    expect(out).not.toContain(fake.state.clientSecret);
    // The credentials were checked with a token request that cannot succeed, and with nothing else.
    const check = fake.requests.filter((r) => r.path === "/oauth/token");
    expect(check).toHaveLength(1);
    expect(JSON.parse(check[0]!.body)).toMatchObject({ grant_type: "refresh_token", client_id: "client1" });
  });

  it("an empty project: says what is missing and how to fix it, and fails", async () => {
    expect(await main(["doctor"], s.ctx)).toBe(1);
    const out = s.out();
    expect(out).toContain("✗ CALMONKEY_CLIENT_ID is not set in this project");
    expect(out).toContain("Run: npx calmonkey init");
    expect(out).toContain("! Not signed in");
    expect(out).toContain("! No AI coding tool was found");
    expect(out).toContain("! The calmonkey-api skill is not installed");
    expect(out).toContain("1 thing to fix, 4 to look at.");
    // Nothing was sent that needs a sign-in or credentials.
    expect(fake.requests.some((r) => r.path === "/oauth/token" || r.path.startsWith("/mcp/cli"))).toBe(false);
  });

  it("wrong credentials, a client id that is not a test application, and a tool that is not registered", async () => {
    signedIn(s, fake);
    s.write(".env.local", "CALMONKEY_CLIENT_ID=someone-elses\nCALMONKEY_CLIENT_SECRET=cmsec_wrong\n");
    s.write(".cursor/rules/x.mdc", "x");
    expect(await main(["doctor"], s.ctx)).toBe(1);
    expect(s.out()).toContain("✗ The client id and secret are not accepted");
    expect(s.out()).toContain("! CALMONKEY_CLIENT_ID is not one of this organization's test-mode applications");
    expect(s.out()).toContain("! Not registered for: Cursor");
    expect(s.out()).not.toContain("cmsec_wrong");
  });

  it("a sign-in that was ended, and an MCP server that is not there", async () => {
    signedIn(s, fake);
    fake.state.accessTokens.clear();
    fake.state.refreshTokens.clear();
    await main(["doctor"], s.ctx);
    expect(s.out()).toContain("! The sign-in has run out or was disconnected");
    const off = sandbox({ endpoints: { app: fake.url, api: fake.url, mcp: `${fake.url}/nowhere/mcp` } });
    expect(await main(["doctor"], off.ctx)).toBe(1);
    expect(off.out()).toContain("did not answer as expected");
    const down = sandbox({ endpoints: { app: "http://127.0.0.1:9", api: "http://127.0.0.1:9", mcp: "http://127.0.0.1:9/mcp" } });
    expect(await main(["doctor"], down.ctx)).toBe(1);
    expect(down.out()).toContain("✗ The MCP server could not be reached");
    off.cleanup();
    down.cleanup();
  });

  it("reads the variables from the environment too", async () => {
    const box = sandbox({ url: fake.url, env: { PATH: "", CALMONKEY_CLIENT_ID: "client1", CALMONKEY_CLIENT_SECRET: fake.state.clientSecret } });
    await main(["doctor"], box.ctx);
    expect(box.out()).toContain("✓ CALMONKEY_CLIENT_ID is set in the environment");
    expect(box.out()).toContain("✓ The client credentials are accepted");
    box.cleanup();
  });
});
