import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { credentialsPath, loadSession, saveSession } from "../src/credentials.js";
import { NotSignedInError, accessToken, clientIdOf, discover, login, logout, pkcePair, startCallbackServer } from "../src/oauth.js";
import { startFake, type Fake } from "./helpers/fake-calmonkey.js";
import { sandbox, uiOf, type Sandbox } from "./helpers/sandbox.js";

// Signing in, against a small authorization server that checks what a real one checks: PKCE,
// the redirect address, the resource, and refresh tokens that work once.

let fake: Fake;
let s: Sandbox;

beforeEach(async () => {
  fake = await startFake();
  s = sandbox({ url: fake.url });
});
afterEach(async () => {
  s.cleanup();
  await fake.close();
});

/** Signs in with the person played by a fetch of the address the tool prints. */
async function signIn(opts: Parameters<typeof login>[2] = {}) {
  const ui = uiOf(s);
  // Only what this sign-in prints: an earlier one's address is further up the output.
  const from = s.out().length;
  const running = login(s.ctx, ui, { browser: false, wait: true, timeoutMs: 5000, ...opts });
  running.catch(() => {});
  const deadline = Date.now() + 3000;
  let url: string | undefined;
  while (!url && Date.now() < deadline) {
    url = /(http:\/\/\S+\/agent-auth\/authorize\?\S+)/.exec(s.out().slice(from))?.[1];
    if (!url) await new Promise((r) => setTimeout(r, 10));
  }
  if (url) await fetch(url).then((r) => r.text());
  return { session: await running, authorizeUrl: new URL(url ?? "http://none") };
}

describe("discovery", () => {
  it("reads the sign-in's settings from the app host", async () => {
    expect(await discover(s.ctx)).toEqual({ issuer: fake.url, authorization_endpoint: `${fake.url}/agent-auth/authorize`, token_endpoint: `${fake.url}/agent-auth/token`, revocation_endpoint: `${fake.url}/agent-auth/revoke` });
  });

  it.each([
    ["wrong-issuer", /name another host/],
    ["foreign-token-endpoint", /name another host/],
    ["no-s256", /PKCE with S256/],
    ["no-cimd", /client metadata documents/],
  ] as const)("refuses settings that are not safe to use: %s", async (broken, message) => {
    fake.state.metadata = broken;
    await expect(discover(s.ctx)).rejects.toThrow(message);
  });

  it("says so when the host has no such sign-in", async () => {
    const elsewhere = sandbox({ url: `${fake.url}/nowhere` });
    await expect(discover(elsewhere.ctx)).rejects.toThrow(/does not offer sign-in|Could not read/);
    elsewhere.cleanup();
  });
});

describe("login", () => {
  it("asks with PKCE, state, its client document and the MCP endpoint as resource; puts no secret in the address", async () => {
    const { session, authorizeUrl } = await signIn();
    const q = authorizeUrl.searchParams;
    expect(Object.fromEntries(q)).toMatchObject({ response_type: "code", client_id: `${fake.url}/agent-auth/cli/client.json`, code_challenge_method: "S256", scope: "calmonkey:test calmonkey:secrets", resource: `${fake.url}/mcp` });
    expect(q.get("client_id")).toBe(clientIdOf(s.ctx));
    expect(q.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(q.get("state")!.length).toBeGreaterThanOrEqual(32);
    // The answer comes back to the address literal, never "localhost", on a port chosen at the time.
    expect(q.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect([...q.keys()].sort()).toEqual(["client_id", "code_challenge", "code_challenge_method", "redirect_uri", "resource", "response_type", "scope", "state"]);
    // The verifier went to the token endpoint in the body, never in an address.
    const exchange = fake.requests.find((r) => r.path === "/agent-auth/token")!;
    const form = new URLSearchParams(exchange.body);
    expect(form.get("grant_type")).toBe("authorization_code");
    expect(pkceOk(form.get("code_verifier")!, q.get("code_challenge")!)).toBe(true);
    expect(form.get("resource")).toBe(`${fake.url}/mcp`);
    expect(exchange.query.size).toBe(0);
    expect(exchange.headers["user-agent"]).toMatch(/^calmonkey-cli\/9\.9\.9-test \(node /);
    expect(session.access_token).toMatch(/^cmmat_/);
    // Nothing printed gives a token away.
    expect(s.out()).not.toMatch(/cmmat_|cmmrt_|code_verifier/);
  });

  it("keeps the sign-in in one file for its owner only, per CalMonkey address", async () => {
    const { session } = await signIn();
    const file = credentialsPath(s.ctx);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(s.ctx.configDir).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ version: 1, sessions: { [fake.url]: session } });
    expect(loadSession(s.ctx)).toEqual(session);
    // Another address has its own entry and sees none of this one.
    const other = { ...s.ctx, endpoints: { app: "https://app.example", api: "https://api.example", mcp: "https://mcp.example/mcp" } };
    expect(loadSession(other)).toBeNull();
    saveSession(other, { ...session, resource: "https://mcp.example/mcp" });
    expect(loadSession(s.ctx)).toEqual(session);
  });

  it("asks without the secrets scope when told to", async () => {
    const { authorizeUrl } = await signIn({ secrets: false });
    expect(authorizeUrl.searchParams.get("scope")).toBe("calmonkey:test");
  });

  it("a declined request, an answer for another run, and an answer from another issuer connect nothing", async () => {
    fake.state.deny = "access_denied";
    await expect(signIn()).rejects.toThrow(/declined in the browser/);
    fake.state.deny = undefined;
    fake.state.forgeState = "someone-elses";
    await expect(signIn()).rejects.toThrow(/does not belong to this run/);
    fake.state.forgeState = undefined;
    fake.state.iss = "https://elsewhere.example";
    await expect(signIn()).rejects.toThrow(/another issuer/);
    expect(existsSync(credentialsPath(s.ctx))).toBe(false);
    expect(fake.requests.filter((r) => r.path === "/agent-auth/token")).toHaveLength(0);
  });

  it("gives up when nobody answers", async () => {
    await expect(login(s.ctx, uiOf(s), { browser: false, wait: true, timeoutMs: 50 })).rejects.toThrow(/Timed out/);
  });

  it("signing in again ends the earlier connection, after the new one is stored", async () => {
    const first = (await signIn()).session;
    const second = (await signIn()).session;
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(fake.state.revoked).toEqual([first.refresh_token]);
    expect(loadSession(s.ctx)!.refresh_token).toBe(second.refresh_token);
  });
});

const pkceOk = (verifier: string, challenge: string) => createHash("sha256").update(verifier, "ascii").digest("base64url") === challenge;

describe("the callback on this machine", () => {
  it("answers only GET /callback on 127.0.0.1, once, with a page that carries nothing", async () => {
    const callback = await startCallbackServer();
    try {
      expect(callback.redirectUri).toBe(`http://127.0.0.1:${callback.port}/callback`);
      expect((await fetch(`http://127.0.0.1:${callback.port}/other`)).status).toBe(404);
      expect((await fetch(callback.redirectUri, { method: "POST" })).status).toBe(404);
      const waiting = callback.wait(2000);
      const res = await fetch(`${callback.redirectUri}?code=abc&state=xyz`);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("referrer-policy")).toBe("no-referrer");
      const html = await res.text();
      expect(html).toContain("Signed in");
      expect(html).not.toContain("abc");
      expect((await waiting).get("code")).toBe("abc");
    } finally {
      callback.close();
    }
  });

  it("makes a fresh verifier and its S256 challenge each time", () => {
    const a = pkcePair();
    const b = pkcePair();
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(pkceOk(a.verifier, a.challenge)).toBe(true);
  });
});

describe("the access token", () => {
  it("is used while it lasts, refreshed when it is about to run out, and the new refresh token is the one kept", async () => {
    const { session } = await signIn();
    expect(await accessToken(s.ctx)).toBe(session.access_token);
    expect(fake.requests.filter((r) => r.path === "/agent-auth/token")).toHaveLength(1);
    saveSession(s.ctx, { ...session, expires_at: Date.now() + 30_000 });
    const next = await accessToken(s.ctx);
    expect(next).not.toBe(session.access_token);
    const stored = loadSession(s.ctx)!;
    expect(stored.access_token).toBe(next);
    expect(stored.refresh_token).not.toBe(session.refresh_token);
    expect(stored.signed_in_at).toBe(session.signed_in_at);
    // The old refresh token is used up; the stored one works.
    expect(fake.state.refreshTokens.has(session.refresh_token)).toBe(false);
    expect(await accessToken(s.ctx, { forceRefresh: true })).not.toBe(next);
  });

  it("when another run has refreshed in the meantime, its token is used instead of ending the sign-in", async () => {
    const { session } = await signIn();
    // This run holds a refresh token that another run has since replaced.
    saveSession(s.ctx, { ...session, expires_at: Date.now() - 1000 });
    const realFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const res = await realFetch(input, init);
      if (String(input).endsWith("/agent-auth/token")) {
        // While this run's refresh was in flight, the other run wrote its own fresh tokens.
        saveSession(s.ctx, { ...session, access_token: "cmmat_from_the_other_run", refresh_token: "cmmrt_from_the_other_run", expires_at: Date.now() + 3600_000 });
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "content-type": "application/json" } });
      }
      return res;
    };
    try {
      expect(await accessToken(s.ctx)).toBe("cmmat_from_the_other_run");
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("a sign-in that was ended asks for a new one and forgets the dead tokens", async () => {
    const { session } = await signIn();
    fake.state.refreshTokens.clear();
    saveSession(s.ctx, { ...session, expires_at: Date.now() - 1000 });
    await expect(accessToken(s.ctx)).rejects.toBeInstanceOf(NotSignedInError);
    expect(loadSession(s.ctx)).toBeNull();
    await expect(accessToken(s.ctx)).rejects.toThrow(/calmonkey login/);
  });
});

describe("logout", () => {
  it("ends the connection at CalMonkey and removes the file", async () => {
    const { session } = await signIn();
    expect(await logout(s.ctx)).toEqual({ wasSignedIn: true, revoked: true });
    expect(fake.state.revoked).toEqual([session.refresh_token]);
    expect(existsSync(credentialsPath(s.ctx))).toBe(false);
    expect(await logout(s.ctx)).toEqual({ wasSignedIn: false, revoked: false });
  });

  it("works without the network", async () => {
    await signIn();
    await fake.close();
    expect(await logout(s.ctx)).toEqual({ wasSignedIn: true, revoked: false });
    expect(loadSession(s.ctx)).toBeNull();
    fake = await startFake();
  });
});
