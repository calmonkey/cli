import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { forward, forwardTarget, isLocalUrl, runListen } from "../src/commands/listen.js";
import { startFake, type Fake, type FakeNotification } from "./helpers/fake-calmonkey.js";
import { sandbox, signedIn, uiOf, type Sandbox } from "./helpers/sandbox.js";

type Hit = { method: string; path: string; headers: http.IncomingHttpHeaders; body: string };

let fake: Fake;
let s: Sandbox;
let receiver: http.Server;
let base: string;
let hits: Hit[];
let answer: (hit: Hit) => number;

beforeEach(async () => {
  fake = await startFake();
  s = sandbox({ url: fake.url });
  signedIn(s, fake);
  fake.applications.push({ application_id: "0".repeat(23) + "1", client_id: "client1", name: "Shop (dev)", mode: "test", connected_accounts: 0, created: "", dashboard_url: "" });
  s.write(".env.local", "CALMONKEY_CLIENT_ID=client1\n");
  hits = [];
  answer = () => 200;
  receiver = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const hit = { method: req.method ?? "", path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") };
      hits.push(hit);
      const status = answer(hit);
      if (status === 302) res.writeHead(302, { Location: "http://127.0.0.1:1/elsewhere" }).end();
      else res.writeHead(status).end();
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}`;
});

afterEach(async () => {
  receiver.closeAllConnections();
  await new Promise((resolve) => receiver.close(resolve));
  s.cleanup();
  await fake.close();
});

const BODY = '{"notification":{"type":"change","changes_since":"2026-10-08T01:02:03Z"},"channel":{"channel_id":"chn_1","callback_url":"x","filters":{}}}';
const notification = (over: Partial<FakeNotification> = {}): FakeNotification => ({
  delivery_id: "whd_" + "a".repeat(24),
  attempt: 1,
  type: "change",
  channel_id: "chn_1",
  callback_url: `${base}/webhooks/calmonkey`,
  headers: { "Content-Type": "application/json; charset=utf-8", "User-Agent": "Calmonkey-Webhooks/1.0", "Calmonkey-Delivery-Id": "whd_" + "a".repeat(24), "Calmonkey-Delivery-Attempt": "1", "Calmonkey-HMAC-SHA256": "aGVsbG8=", "Calmonkey-Signature": "t=1791000000,v1=abcdef" },
  body: BODY,
  ...over,
});

/** Runs listen until `until` holds, then stops it as Ctrl+C would. */
async function listenUntil(until: () => boolean, opts: Parameters<typeof runListen>[2] = {}) {
  const stop = new AbortController();
  const running = runListen(s.ctx, uiOf(s), opts, stop.signal);
  const deadline = Date.now() + 8000;
  while (!until() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  stop.abort();
  return running;
}

describe("forwarding one notification", () => {
  it("posts the body byte for byte with every header CalMonkey made, and reports the answer", async () => {
    const n = notification();
    expect(await forward(s.ctx, n, n.callback_url)).toEqual({ delivery_id: n.delivery_id, attempt: 1, status: 200 });
    expect(hits).toHaveLength(1);
    const hit = hits[0]!;
    expect(hit.method).toBe("POST");
    expect(hit.path).toBe("/webhooks/calmonkey");
    expect(hit.body).toBe(BODY);
    expect(hit.headers).toMatchObject({ "content-type": "application/json; charset=utf-8", "user-agent": "Calmonkey-Webhooks/1.0", "calmonkey-delivery-id": n.delivery_id, "calmonkey-delivery-attempt": "1", "calmonkey-hmac-sha256": "aGVsbG8=", "calmonkey-signature": "t=1791000000,v1=abcdef" });
    // The sign-in's token never travels to the developer's endpoint.
    expect(hit.headers.authorization).toBeUndefined();
  });

  it("reports what the endpoint answered, follows no redirect, and reports no answer as 0 with the reason", async () => {
    answer = () => 500;
    expect((await forward(s.ctx, notification(), `${base}/x`)).status).toBe(500);
    answer = () => 410;
    expect((await forward(s.ctx, notification(), `${base}/x`)).status).toBe(410);
    answer = () => 302;
    expect((await forward(s.ctx, notification(), `${base}/x`)).status).toBe(302);
    expect(hits).toHaveLength(3);
    const nobody = await forward(s.ctx, notification(), "http://127.0.0.1:9/nobody");
    expect(nobody).toMatchObject({ status: 0, error: expect.stringMatching(/connection refused|Could not reach|Nothing is answering/) });
  });

  it("knows an address on this machine from any other", () => {
    for (const url of ["http://localhost:3000/hooks", "http://127.0.0.1/x", "http://[::1]:8080/x", "https://localhost:8443/x"]) expect(isLocalUrl(url), url).toBe(true);
    for (const url of ["http://example.com/x", "http://localhost.example.com/x", "http://192.168.1.2/x", "http://user:pw@localhost/x", "file:///etc/passwd", "nope"]) expect(isLocalUrl(url), url).toBe(false);
    expect(forwardTarget(undefined)).toBeUndefined();
    expect(forwardTarget("http://localhost:3000/webhooks/calmonkey")).toBe("http://localhost:3000/webhooks/calmonkey");
    expect(() => forwardTarget("localhost:3000")).toThrow(/must be an http/);
    expect(() => forwardTarget("not a url")).toThrow(/not a URL/);
  });
});

describe("calmonkey listen", () => {
  it("collects, forwards to the channel's own address, and reports with its next call", async () => {
    fake.listenQueue.push([notification()]);
    expect(await listenUntil(() => fake.reports.length >= 1)).toBe(0);
    expect(hits.map((h) => h.path)).toEqual(["/webhooks/calmonkey"]);
    expect(fake.reports).toEqual([{ delivery_id: "whd_" + "a".repeat(24), attempt: 1, status: 200 }]);
    const calls = fake.requests.filter((r) => r.path === "/mcp/cli/listen").map((r) => JSON.parse(r.body) as { application_id: string; wait_seconds: number; reports: unknown[] });
    expect(calls[0]).toEqual({ application_id: "client1", reports: [], wait_seconds: 25 });
    expect(calls[1]!.reports).toHaveLength(1);
    // The answer is handed in once.
    expect(calls.slice(2).every((c) => c.reports.length === 0)).toBe(true);
    const out = s.out();
    expect(out).toContain("Ready. Listening for test-mode notifications of “Shop (dev)”");
    expect(out).toMatch(/--> {2}change \[whd_a{24}\]/);
    expect(out).toMatch(new RegExp(`<--  \\[200\\] POST ${base}/webhooks/calmonkey`));
    expect(out).toContain("Stopped.");
  });

  it("--forward-to sends everything to the one address", async () => {
    fake.listenQueue.push([notification({ callback_url: "http://localhost:1/never" }), notification({ delivery_id: "whd_" + "b".repeat(24), attempt: 3 })]);
    await listenUntil(() => fake.reports.length >= 2, { forwardTo: `${base}/all` });
    expect(hits.map((h) => h.path)).toEqual(["/all", "/all"]);
    expect(s.out()).toContain(`Every notification goes to ${base}/all`);
    expect(s.out()).toContain("attempt 3");
  });

  it("an endpoint that fails or is not running is reported as it is", async () => {
    answer = () => 503;
    fake.listenQueue.push([notification(), notification({ delivery_id: "whd_" + "c".repeat(24), callback_url: "http://127.0.0.1:9/down" })]);
    await listenUntil(() => fake.reports.length >= 2);
    expect(fake.reports).toEqual([
      { delivery_id: "whd_" + "a".repeat(24), attempt: 1, status: 503 },
      { delivery_id: "whd_" + "c".repeat(24), attempt: 1, status: 0, error: expect.any(String) },
    ]);
    expect(s.out()).toContain("[503]");
    expect(s.out()).toContain("[no answer]");
  });

  it("never posts to an address that is not on this machine unless told to with --forward-to", async () => {
    fake.listenQueue.push([notification({ callback_url: "https://internal.example.com/admin" })]);
    await listenUntil(() => fake.reports.length >= 1);
    expect(hits).toHaveLength(0);
    expect(fake.reports).toEqual([{ delivery_id: "whd_" + "a".repeat(24), attempt: 1, status: 0, error: "not a local address" }]);
    expect(s.out()).toContain("is not an address on this machine");
  });

  it("names the application by --app, or the project's CALMONKEY_CLIENT_ID, or the only one there is", async () => {
    await listenUntil(() => fake.requests.some((r) => r.path === "/mcp/cli/listen"), { app: "client1" });
    const bare = sandbox({ url: fake.url });
    signedIn(bare, fake);
    const stop = new AbortController();
    const running = runListen(bare.ctx, uiOf(bare), {}, stop.signal);
    await new Promise((r) => setTimeout(r, 300));
    stop.abort();
    expect(await running).toBe(0);
    expect(bare.out()).toContain("Shop (dev)");
    fake.applications.push({ application_id: "0".repeat(23) + "2", client_id: "client2", name: "Other", mode: "test", connected_accounts: 0, created: "", dashboard_url: "" });
    await expect(runListen(bare.ctx, uiOf(bare), {}, new AbortController().signal)).rejects.toThrow(/Which application\? Pass --app with one of: client1 \(Shop \(dev\)\), client2 \(Other\)/);
    bare.cleanup();
  });

  it("an application that is not there, or a role that may not, stops it with CalMonkey's words", async () => {
    await expect(runListen(s.ctx, uiOf(s), { app: "nope" }, new AbortController().signal)).rejects.toThrow(/No test-mode application “nope”/);
    fake.state.listenStatus = 403;
    await expect(runListen(s.ctx, uiOf(s), {}, new AbortController().signal)).rejects.toThrow(/listen answered 403/);
  });

  it("carries on through a moment of trouble at CalMonkey, keeping the answers it has not handed in", async () => {
    fake.listenQueue.push([notification()]);
    // The moment the notification arrives here, CalMonkey starts answering 503: the report cannot be handed in yet.
    answer = () => {
      fake.state.listenStatus = 503;
      return 200;
    };
    const stop = new AbortController();
    const running = runListen(s.ctx, uiOf(s), {}, stop.signal);
    while (!s.out().includes("Trying again")) await new Promise((r) => setTimeout(r, 10));
    expect(fake.reports).toHaveLength(0);
    fake.state.listenStatus = undefined;
    const deadline = Date.now() + 6000;
    while (!fake.reports.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    stop.abort();
    await running;
    expect(fake.reports).toEqual([{ delivery_id: "whd_" + "a".repeat(24), attempt: 1, status: 200 }]);
  }, 15_000);
});
