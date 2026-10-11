import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS, main, rootHelp } from "../src/cli.js";
import { startFake, type Fake } from "./helpers/fake-calmonkey.js";
import { sandbox, signedIn, type Sandbox } from "./helpers/sandbox.js";

// `calmonkey brand …`: the customer's own brand on Google's and Microsoft's sign-in screens
// (Scale plan). The commands help a person (or their agent) through the set-up the dashboard's
// Own brand tab also does; every call is a server tool (brand_*), so who may do what and what
// needs a yes is the server's decision.

let fake: Fake;
let s: Sandbox;

const LIVE = { application: { application_id: "1".repeat(24), client_id: "live1", name: "Shop", mode: "live" as const } };
type Handler = (args: Record<string, unknown>) => { status: number; body: unknown };
const ok = (result: unknown) => ({ status: 200, body: { result, resolved: LIVE } });
const tools = (handlers: Record<string, Handler>) => {
  fake.tool = (name, args) => handlers[name]?.(args) ?? { status: 404, body: { error: { code: "unknown_tool", message: `No tool ${name}.` } } };
};
const run = (...args: string[]) => main(args, s.ctx);
const sent = (tool: string) => fake.toolCalls.filter((c) => c.tool === tool).map((c) => c.args);

const STATUS = {
  application: "Shop",
  available: "plan",
  use: "shared",
  brand: { name: "Shop Calendar", support_email: "help@shop.example", logo: true, homepage_url: "https://shop.example/", privacy_url: "https://shop.example/privacy" },
  domain: { name: "calendar.shop.example", status: "verified", problems: [] },
  google: { client_id: "1069805636571-abc.apps.googleusercontent.com", secret_hint: "…x9Qa", uploaded_at: "2026-10-10T03:00:00Z" },
  microsoft: null,
  preflight: { at: "2026-10-10T04:00:00Z", failed: 1, warnings: 2 },
  round_trip: null,
  connections: { shared: 12, own: 0 },
  cutover_blockers: [],
  next: ["Fix the failed pre-flight checks: calmonkey brand check", "Try a sign-in with your own client in the dashboard (Own brand, Try a sign-in)"],
  dashboard_url: "https://app.calmonkey.com/dashboard/apps/111/brand",
};

const SECRET = "GOCSPX-verysecretvalue123456";
const CLIENT_FILE = { web: { client_id: "1069805636571-abc.apps.googleusercontent.com", project_id: "shop-cal", client_secret: SECRET, redirect_uris: ["https://calendar.shop.example/connect/google/callback"] } };

beforeEach(async () => {
  fake = await startFake();
  s = sandbox({ url: fake.url, env: { PATH: "" } });
  signedIn(s, fake);
});
afterEach(async () => {
  s.cleanup();
  await fake.close();
});

describe("calmonkey brand status", () => {
  it("says where the set-up stands and what is next", async () => {
    tools({ brand_status: () => ok(STATUS) });
    expect(await run("brand", "status", "--app", "live1")).toBe(0);
    expect(sent("brand_status")[0]).toEqual({ application_id: "live1" });
    expect(s.out()).toBe(
      [
        'own brand "Shop" (live) | new connections use CalMonkey\'s app | Scale plan',
        'brand      "Shop Calendar", support help@shop.example, logo set',
        "pages      home https://shop.example/, privacy https://shop.example/privacy",
        "domain     calendar.shop.example verified",
        "google     1069805636571-abc.apps.googleusercontent.com (secret …x9Qa), uploaded 2026-10-10",
        "microsoft  none",
        "checks     2026-10-10: 1 failed, 2 warnings",
        "sign-in    not tried yet",
        "connected  12 through CalMonkey's app, 0 through yours",
        "next:",
        "  Fix the failed pre-flight checks: calmonkey brand check",
        "  Try a sign-in with your own client in the dashboard (Own brand, Try a sign-in)",
        "dashboard: https://app.calmonkey.com/dashboard/apps/111/brand",
        "",
      ].join("\n"),
    );
  });

  it("names the grace period after leaving the Scale plan, and an empty set-up", async () => {
    tools({ brand_status: () => ok({ ...STATUS, available: "grace", grace_until: "2026-11-09T00:00:00Z", use: "own", domain: null, google: null, preflight: null, connections: { shared: 0, own: 3 }, next: ["calmonkey brand domain set calendar.yourcompany.com"] }) });
    expect(await run("brand", "status")).toBe(0);
    const lines = s.out().split("\n");
    expect(lines[0]).toBe('own brand "Shop" (live) | new connections use your own app | kept until 2026-11-09 (the organisation left the Scale plan)');
    expect(lines).toContain("domain     none");
    expect(lines).toContain("checks     not run yet");
    expect(sent("brand_status")[0]).toEqual({});
  });

  it("--json is the server's answer", async () => {
    tools({ brand_status: () => ok(STATUS) });
    expect(await run("brand", "status", "--json")).toBe(0);
    expect(JSON.parse(s.out()).domain).toEqual({ name: "calendar.shop.example", status: "verified" });
  });

  it("an organisation without the Scale plan gets the upgrade link as the fix", async () => {
    tools({ brand_status: () => ({ status: 403, body: { error: { code: "plan_required", message: "Own brand is included in the Scale plan. This organisation is on Growth. Nothing was read or changed.", upgrade_url: "https://app.calmonkey.com/dashboard/billing" } } }) });
    expect(await run("brand", "status")).toBe(5);
    expect(s.err()).toBe(
      "error plan_required (HTTP 403): Own brand is included in the Scale plan. This organisation is on Growth. Nothing was read or changed\nnothing was changed\nfix: an owner upgrades to Scale: https://app.calmonkey.com/dashboard/billing\nmore: calmonkey explain plan_required\n",
    );
  });

  it("a machine token is refused before anything is sent", async () => {
    const machine = sandbox({ url: fake.url, env: { PATH: "", CALMONKEY_TOKEN: `cmmmt_${"m".repeat(43)}` } });
    expect(await main(["brand", "status"], machine.ctx)).toBe(5);
    expect(machine.err()).toContain("error needs_person");
    expect(fake.toolCalls).toEqual([]);
    machine.cleanup();
  });
});

describe("calmonkey brand domain set | verify", () => {
  const RECORDS = {
    domain: "calendar.shop.example",
    status: "pending",
    records: [
      { type: "CNAME", name: "calendar.shop.example", value: "connect.calmonkey.com", purpose: "traffic" },
      { type: "TXT", name: "_calmonkey.calendar.shop.example", value: "calmonkey-verify=k3j4h5", purpose: "ownership" },
    ],
    zone_file: "calendar.shop.example.\t3600\tIN\tCNAME\tconnect.calmonkey.com.\n_calmonkey.calendar.shop.example.\t3600\tIN\tTXT\t\"calmonkey-verify=k3j4h5\"\n",
  };

  it("set prints the DNS records to add, the zone file and the next command", async () => {
    tools({ brand_domain_set: () => ok(RECORDS) });
    expect(await run("brand", "domain", "set", "calendar.shop.example")).toBe(0);
    expect(sent("brand_domain_set")[0]).toEqual({ domain: "calendar.shop.example" });
    expect(s.out()).toBe(
      [
        "domain calendar.shop.example set | pending: add these DNS records at your DNS host",
        "TYPE   NAME                              VALUE                    FOR",
        "CNAME  calendar.shop.example             connect.calmonkey.com    traffic",
        "TXT    _calmonkey.calendar.shop.example  calmonkey-verify=k3j4h5  ownership",
        "zone file:",
        "  calendar.shop.example.\t3600\tIN\tCNAME\tconnect.calmonkey.com.",
        '  _calmonkey.calendar.shop.example.\t3600\tIN\tTXT\t"calmonkey-verify=k3j4h5"',
        "then: calmonkey brand domain verify",
        "",
      ].join("\n"),
    );
  });

  it("set needs a host name, and refuses a URL before asking anything", async () => {
    expect(await run("brand", "domain", "set")).toBe(2);
    expect(s.err()).toContain("fix: calmonkey brand domain set calendar.yourcompany.com");
    expect(await run("brand", "domain", "set", "https://calendar.shop.example/")).toBe(2);
    expect(s.err()).toContain("error invalid_domain");
    expect(fake.toolCalls).toEqual([]);
  });

  it("a held change (an own app is set up) is described first, and done with --confirm", async () => {
    tools({ brand_domain_set: (a) => (a.confirm ? ok(RECORDS) : { status: 202, body: { confirmation: { will: "Change the connect domain of “Shop” to calendar.shop.example. It changes what Google reviewed: a new review starts there.", confirmation_token: "cmmcf_abc123", expires_in_seconds: 600 }, resolved: LIVE } }) });
    expect(await run("brand", "domain", "set", "calendar.shop.example")).toBe(10);
    expect(s.err()).toContain("NOT DONE: confirmation needed\nwould: Change the connect domain of “Shop” to calendar.shop.example.");
    expect(s.err()).toContain("  calmonkey brand domain set calendar.shop.example --confirm cmmcf_abc123");
    expect(await run("brand", "domain", "set", "calendar.shop.example", "--confirm", "cmmcf_abc123")).toBe(0);
    expect(sent("brand_domain_set")[1]).toEqual({ domain: "calendar.shop.example", confirm: true, confirmation_token: "cmmcf_abc123" });
  });

  it("verify: verified, or what is missing and exit code 1", async () => {
    tools({ brand_domain_verify: () => ok({ domain: "calendar.shop.example", verified: true, problems: [] }) });
    expect(await run("brand", "domain", "verify")).toBe(0);
    expect(s.out()).toBe("domain calendar.shop.example verified | the https certificate is issued on the first visit\nnext: calmonkey brand status\n");
    tools({ brand_domain_verify: () => ok({ domain: "calendar.shop.example", verified: false, problems: ["The TXT record _calmonkey.calendar.shop.example was not found."] }) });
    expect(await run("brand", "domain", "verify")).toBe(1);
    expect(s.out()).toContain("domain calendar.shop.example not verified yet\n  The TXT record _calmonkey.calendar.shop.example was not found.\nDNS changes can take a while to be seen; run again: calmonkey brand domain verify\n");
  });
});

describe("calmonkey brand google upload", () => {
  it("reads the file, sends it, and never prints the secret", async () => {
    s.write("client.json", JSON.stringify(CLIENT_FILE));
    tools({ brand_google_upload: () => ok({ client_id: CLIENT_FILE.web.client_id, secret_hint: "…3456", project_id: "shop-cal", redirect_uris: CLIENT_FILE.web.redirect_uris, probe: "accepted", detail: "Google accepted the client id and secret.", rotated: false }) });
    expect(await run("brand", "google", "upload", "client.json")).toBe(0);
    expect(sent("brand_google_upload")[0]).toEqual({ client_file: CLIENT_FILE });
    expect(s.out()).toBe(
      [
        "uploaded Google client 1069805636571-abc.apps.googleusercontent.com (secret …3456, project shop-cal) | Google accepted the client id and secret.",
        "redirect URIs: https://calendar.shop.example/connect/google/callback",
        "next: calmonkey brand check",
        "",
      ].join("\n"),
    );
    expect(s.out() + s.err()).not.toContain(SECRET);
  });

  it("--json does not carry the secret either, even when an answer would", async () => {
    s.write("client.json", JSON.stringify(CLIENT_FILE));
    tools({ brand_google_upload: () => ok({ client_id: CLIENT_FILE.web.client_id, client_secret: SECRET, secret_hint: "…3456", probe: "accepted", detail: `echo ${SECRET}`, rotated: false }) });
    expect(await run("brand", "google", "upload", "client.json", "--json")).toBe(0);
    expect(s.out()).not.toContain(SECRET);
  });

  it("refuses a file that is not Google's web client file, and says so without its content", async () => {
    s.write("bad.json", `{"oops": "${SECRET}"`);
    expect(await run("brand", "google", "upload", "bad.json")).toBe(2);
    expect(s.err()).toContain("error invalid_file: bad.json is not JSON");
    s.write("desktop.json", JSON.stringify({ installed: { client_id: "x", client_secret: SECRET } }));
    expect(await run("brand", "google", "upload", "desktop.json")).toBe(2);
    expect(s.err()).toContain("a desktop client");
    s.write("big.json", JSON.stringify({ web: { client_id: "x", client_secret: "y", pad: "z".repeat(70 * 1024) } }));
    expect(await run("brand", "google", "upload", "big.json")).toBe(2);
    expect(s.err()).toContain("more than 64 KB");
    expect(await run("brand", "google", "upload", "missing.json")).toBe(2);
    expect(s.err()).toContain("no file missing.json");
    expect(s.out() + s.err()).not.toContain(SECRET);
    expect(fake.toolCalls).toEqual([]);
  });
});

describe("calmonkey brand check | kit | switch", () => {
  it("check prints failures first, each with its fix, and exits 1 while one fails", async () => {
    tools({
      brand_check: () =>
        ok({
          items: [
            { key: "brand.name", level: "pass", title: "App name", detail: "“Shop Calendar”, exactly as on the consent screen." },
            { key: "brand.logo", level: "warn", title: "Logo", detail: "No logo: the connect page shows your initial. Google needs a 120 × 120 logo for review." },
            { key: "site.privacy", level: "fail", title: "Privacy policy", detail: "Add a section on Google user data with the Limited Use sentence (calmonkey brand kit has the wording)." },
          ],
          failed: 1,
          warnings: 1,
        }),
    });
    expect(await run("brand", "check")).toBe(1);
    expect(s.out()).toBe(
      [
        'pre-flight "Shop" (live) | 1 failed, 1 warning, 1 passed',
        "fail  Privacy policy: Add a section on Google user data with the Limited Use sentence (calmonkey brand kit has the wording).",
        "warn  Logo: No logo: the connect page shows your initial. Google needs a 120 × 120 logo for review.",
        "pass  App name: “Shop Calendar”, exactly as on the consent screen.",
        "fix the failed checks, then run again: calmonkey brand check",
        "",
      ].join("\n"),
    );
    tools({ brand_check: () => ok({ items: [{ key: "brand.name", level: "pass", title: "App name", detail: "Fine." }], failed: 0, warnings: 0 }) });
    expect(await run("brand", "check")).toBe(0);
    expect(s.out()).toContain("all checks passed: ask Google to review your app; calmonkey brand kit has the wording it asks for");
  });

  it("kit prints every section", async () => {
    tools({ brand_kit: () => ok({ sections: [{ id: "privacy", title: "Wording for your privacy policy", text: "Google user data\n\nWhen you connect…" }, { id: "video", title: "Demo video: shot list", text: "1. Open…\n2. Sign in…" }] }) });
    expect(await run("brand", "kit")).toBe(0);
    expect(s.out()).toBe('verification kit "Shop" (live) | 2 sections\n\n## Wording for your privacy policy\nGoogle user data\n\nWhen you connect…\n\n## Demo video: shot list\n1. Open…\n2. Sign in…\n');
  });

  it("switch is always described first and done only with --confirm", async () => {
    tools({ brand_switch: (a) => (a.confirm ? ok({ use: a.use, changed: true }) : { status: 202, body: { confirmation: { will: "Switch the live application “Shop” to your own app for new connections. People already connected keep working.", confirmation_token: "cmmcf_sw1", expires_in_seconds: 600 }, resolved: LIVE } }) });
    expect(await run("brand", "switch", "own")).toBe(10);
    expect(s.err()).toContain("  calmonkey brand switch own --confirm cmmcf_sw1");
    expect(sent("brand_switch")[0]).toEqual({ use: "own" });
    expect(await run("brand", "switch", "own", "--confirm", "cmmcf_sw1")).toBe(0);
    expect(s.out()).toBe("switched \"Shop\" (live): new connections use your own app | people already connected keep working; nobody has to connect again\nback: calmonkey brand switch shared\n");
  });

  it("switch takes own or shared and nothing else", async () => {
    expect(await run("brand", "switch", "mine")).toBe(2);
    expect(s.err()).toContain("fix: calmonkey brand switch own");
    expect(fake.toolCalls).toEqual([]);
  });
});

describe("the commands are found and listed", () => {
  it("three-word commands resolve, and a group without its verb lists the verbs", async () => {
    expect(COMMANDS.map((c) => c.name).filter((n) => n.startsWith("brand "))).toEqual(["brand status", "brand domain set", "brand domain verify", "brand google upload", "brand check", "brand switch", "brand kit"]);
    expect(await run("brand", "domain")).toBe(2);
    expect(s.err()).toContain('"brand domain" needs a verb: set, verify');
    expect(await run("brand", "domain", "verfy")).toBe(2);
    expect(s.err()).toContain("Did you mean: calmonkey brand domain verify");
    expect(await run("brand", "domain", "set", "--help")).toBe(0);
    expect(s.out()).toContain("calmonkey brand domain set <host>");
  });

  it("the root help names them", () => {
    expect(rootHelp("0.2.4")).toContain("brand status | domain set | domain verify | google upload | check | switch | kit");
  });
});
