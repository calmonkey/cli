import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { COMMON, flag, str, type Command, type Input } from "../command.js";
import { EXIT, Failure } from "../fail.js";
import { usesMachineToken } from "../oauth.js";
import { table } from "../out.js";
import type { Resolved, ToolAnswer } from "../tools.js";
import { call, emit, write } from "./data.js";

// Your own brand on Google's and Microsoft's sign-in screens (the Scale plan): the steps of the
// dashboard's Own brand tab, from the terminal. Every command is one server tool (brand_*), so
// who may do what (an owner or admin, a person rather than a machine token, an organisation on
// Scale) and what needs a yes first are decided by CalMonkey, not here. The client secret in a
// Google client file goes to CalMonkey and is never printed.

const APP = flag.value("app", "<id|name>", "the application (default: the organisation's only one)");
const FLAGS = [APP, COMMON.json];
const WRITE_FLAGS = [APP, COMMON.confirm, COMMON.json];

type Status = {
  application: string;
  available: "plan" | "switch" | "grace";
  grace_until?: string;
  use: "shared" | "own";
  brand: { name: string; support_email: string; logo: boolean; homepage_url: string; privacy_url: string };
  domain: null | { name: string; status: "pending" | "verified" | "failed"; problems: string[] };
  google: null | { client_id: string; secret_hint: string; uploaded_at: string | null };
  microsoft: null | { client_id: string; secret_hint: string; secret_expires_at: string | null };
  preflight: null | { at: string; failed: number; warnings: number };
  round_trip: null | { at: string; provider: string; outcome: string };
  connections: { shared: number; own: number };
  cutover_blockers: string[];
  next: string[];
  dashboard_url: string;
};
type DnsRecord = { type: string; name: string; value: string; purpose: string; optional?: boolean };
type DomainSet = { domain: string; status: string; records: DnsRecord[]; zone_file: string };
type Verify = { domain: string; verified: boolean; problems: string[] };
type Upload = { client_id: string; secret_hint: string; project_id?: string; redirect_uris?: string[]; probe: string; detail: string; rotated: boolean };
type Check = { items: { key: string; level: "pass" | "warn" | "fail"; title: string; detail: string }[]; failed: number; warnings: number };
type Kit = { sections: { id: string; title: string; text: string }[] };

const day = (iso: string | null | undefined) => (iso ? iso.slice(0, 10) : "-");
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const label = (r: Resolved, fallback = "") => (r.application ? `${JSON.stringify(r.application.name)} (${r.application.mode})` : JSON.stringify(fallback));
const one = (text: string) => text.replace(/\s+/g, " ").trim();

/** The application the command names; left out, CalMonkey takes the organisation's only one. */
const appArg = (input: Input): { application_id?: string } => (str(input.flags, "app") ? { application_id: str(input.flags, "app") } : {});

/** Own brand is set up by a person: a machine token (CALMONKEY_TOKEN) is turned away before anything is sent. */
function person(input: Input): void {
  if (usesMachineToken(input.ctx)) {
    throw new Failure({ code: "needs_person", message: "own brand is set up by a person who is signed in, not with CALMONKEY_TOKEN", exit: EXIT.notAllowed, write: input.spec.write, fix: ["unset CALMONKEY_TOKEN and run it in your own terminal after calmonkey login", "(or use the dashboard: the application's Own brand tab)"] });
  }
}

async function read<T>(input: Input, tool: string, args: Record<string, unknown> = {}): Promise<ToolAnswer<T>> {
  person(input);
  return call<T>(input, tool, { ...appArg(input), ...args });
}

function statusText(r: Status, resolved: Resolved): string {
  const who = r.use === "own" ? "your own app" : "CalMonkey's app";
  const why = r.available === "grace" ? `kept until ${day(r.grace_until)} (the organisation left the Scale plan)` : r.available === "switch" ? "switched on for this organisation" : "Scale plan";
  const client = (c: { client_id: string; secret_hint: string }) => `${c.client_id} (secret ${c.secret_hint}`;
  return [
    `own brand ${label(resolved, r.application)} | new connections use ${who} | ${why}`,
    `brand      ${JSON.stringify(r.brand.name)}, support ${r.brand.support_email || "none"}, logo ${r.brand.logo ? "set" : "none"}`,
    `pages      home ${r.brand.homepage_url || "none"}, privacy ${r.brand.privacy_url || "none"}`,
    `domain     ${r.domain ? `${r.domain.name} ${r.domain.status}${r.domain.problems.length ? `: ${one(r.domain.problems.join(" "))}` : ""}` : "none"}`,
    `google     ${r.google ? `${client(r.google)}), uploaded ${day(r.google.uploaded_at)}` : "none"}`,
    `microsoft  ${r.microsoft ? `${client(r.microsoft)})${r.microsoft.secret_expires_at ? `, secret expires ${day(r.microsoft.secret_expires_at)}` : ""}` : "none"}`,
    `checks     ${r.preflight ? `${day(r.preflight.at)}: ${r.preflight.failed} failed, ${plural(r.preflight.warnings, "warning")}` : "not run yet"}`,
    `sign-in    ${r.round_trip ? `${day(r.round_trip.at)} ${r.round_trip.provider}: ${r.round_trip.outcome}` : "not tried yet"}`,
    `connected  ${r.connections.shared} through CalMonkey's app, ${r.connections.own} through yours`,
    ...(r.cutover_blockers.length && r.use === "shared" ? [`to switch:  ${one(r.cutover_blockers.join(" "))}`] : []),
    ...(r.next.length ? ["next:", ...r.next.map((n) => `  ${one(n)}`)] : []),
    `dashboard: ${r.dashboard_url}`,
  ].join("\n");
}

const status: Command = {
  name: "brand status",
  group: "other",
  summary: "Your own brand on Google's and Microsoft's sign-in screens (Scale plan): where the set-up of an application stands, and what to do next. Owners and admins",
  flags: FLAGS,
  examples: ["calmonkey brand status", 'calmonkey brand status --app "Shop"'],
  seeAlso: "calmonkey brand check, https://calmonkey.com/docs/own-brand",
  async run(input) {
    const { result, resolved } = await read<Status>(input, "brand_status");
    emit(input, () => statusText(result, resolved), () => result);
    return EXIT.ok;
  },
};

const HOST = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const domainSet: Command = {
  name: "brand domain set",
  group: "other",
  summary: "Choose the connect domain people sign in on (a subdomain you own, e.g. calendar.yourcompany.com) and print the DNS records to add, also as a zone file",
  usage: "<host>",
  write: true,
  flags: WRITE_FLAGS,
  examples: ["calmonkey brand domain set calendar.yourcompany.com"],
  seeAlso: "calmonkey brand domain verify",
  async run(input) {
    person(input);
    const host = input.args[0]?.trim().toLowerCase().replace(/\.$/, "");
    if (!host) throw new Failure({ code: "missing_argument", message: "calmonkey brand domain set needs the host name people will sign in on", exit: EXIT.usage, write: true, fix: ["calmonkey brand domain set calendar.yourcompany.com"] });
    if (!HOST.test(host)) throw new Failure({ code: "invalid_domain", message: "give a host name only, such as calendar.yourcompany.com: no https://, path or port", exit: EXIT.usage, write: true, fix: ["calmonkey brand domain set calendar.yourcompany.com"] });
    return write<DomainSet>(input, "brand_domain_set", { ...appArg(input), domain: host }, {
      done: ({ result }) =>
        emit(
          input,
          () =>
            [
              `domain ${result.domain} set | ${result.status}: add these DNS records at your DNS host`,
              ...table([["TYPE", "NAME", "VALUE", "FOR"], ...result.records.map((r) => [r.type, r.name, r.value, `${r.purpose}${r.optional ? " (optional)" : ""}`])]),
              "zone file:",
              ...result.zone_file.trimEnd().split("\n").map((l) => `  ${l}`),
              "then: calmonkey brand domain verify",
            ].join("\n"),
          () => result,
        ),
    });
  },
};

const domainVerify: Command = {
  name: "brand domain verify",
  group: "other",
  summary: "Check the connect domain's DNS records and verify it. Exit code 1 while a record is missing",
  write: true,
  flags: FLAGS,
  examples: ["calmonkey brand domain verify"],
  seeAlso: "calmonkey brand domain set <host>, calmonkey brand status",
  async run(input) {
    const { result } = await read<Verify>(input, "brand_domain_verify");
    emit(
      input,
      () =>
        result.verified
          ? `domain ${result.domain} verified | the https certificate is issued on the first visit\nnext: calmonkey brand status`
          : [`domain ${result.domain} not verified yet`, ...result.problems.map((p) => `  ${one(p)}`), "DNS changes can take a while to be seen; run again: calmonkey brand domain verify"].join("\n"),
      () => result,
    );
    return result.verified ? EXIT.ok : EXIT.failed;
  },
};

const MAX_FILE = 64 * 1024;

/** Google's client file, read here and checked for its shape. Its content (the secret) is never put in a message. */
function clientFile(input: Input): Record<string, unknown> {
  const name = input.args[0];
  const bad = (message: string, fix?: string[]) => new Failure({ code: "invalid_file", message, exit: EXIT.usage, write: true, ...(fix ? { fix } : {}) });
  if (!name) throw new Failure({ code: "missing_argument", message: "calmonkey brand google upload needs the client file Google gave you (JSON)", exit: EXIT.usage, write: true, fix: ["calmonkey brand google upload client_secret_1069….json"] });
  const file = path.resolve(input.ctx.cwd, name);
  let size: number;
  try {
    size = statSync(file).size;
  } catch {
    throw bad(`no file ${name}`);
  }
  if (size > MAX_FILE) throw bad(`${name} is more than 64 KB, too large to be a Google client file`);
  let doc: unknown;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw bad(`${name} is not JSON. Use the file Google's console downloads for the client (Download JSON)`);
  }
  const root = doc as { web?: unknown; installed?: unknown } | null;
  if (root && typeof root === "object" && root.installed && !root.web) throw bad(`${name} is a desktop client. In Google's console create a client of type "Web application" and download its JSON`);
  const web = root && typeof root === "object" ? (root.web as Record<string, unknown> | undefined) : undefined;
  if (!web || typeof web !== "object" || typeof web.client_id !== "string" || typeof web.client_secret !== "string") throw bad(`${name} has no "web" section with a client_id and client_secret. Download the JSON of a "Web application" client`);
  return { web };
}

const googleUpload: Command = {
  name: "brand google upload",
  group: "other",
  summary: "Send your Google OAuth client file (the Web application client's JSON) to CalMonkey. Stored encrypted, checked with Google, never shown again; the secret is never printed",
  usage: "<client.json>",
  write: true,
  flags: WRITE_FLAGS,
  examples: ["calmonkey brand google upload ~/Downloads/client_secret_1069….json"],
  seeAlso: "calmonkey brand check",
  async run(input) {
    person(input);
    const file = clientFile(input);
    // Whatever comes back is printed without the secret, even if an answer were to carry it.
    const secret = String((file.web as Record<string, unknown>).client_secret);
    const scrub = <T>(value: T): T => (secret.length >= 6 ? (JSON.parse(JSON.stringify(value).split(secret).join("[redacted]")) as T) : value);
    try {
      return await write<Upload>(input, "brand_google_upload", { ...appArg(input), client_file: file }, {
      done: ({ result: answer }) => {
        const result = scrub(answer);
        emit(
          input,
          () =>
            [
              `uploaded Google client ${result.client_id} (secret ${result.secret_hint}${result.project_id ? `, project ${result.project_id}` : ""}) | ${one(result.detail)}`,
              ...(result.redirect_uris?.length ? [`redirect URIs: ${result.redirect_uris.join(", ")}`] : []),
              ...(result.rotated ? ["a new secret for the same client: the previous one can be put back in the dashboard for 7 days"] : []),
              "next: calmonkey brand check",
            ].join("\n"),
          () => result,
        );
      },
    });
    } catch (error) {
      if (error instanceof Failure) throw new Failure(scrub(error.init));
      throw error;
    }
  },
};

const ORDER = { fail: 0, warn: 1, pass: 2 } as const;

const check: Command = {
  name: "brand check",
  group: "other",
  summary: "Run the pre-flight: your settings and clients, and your home page and privacy policy as Google's reviewers see them. Failures first, each with its fix; exit code 1 while one fails",
  write: true,
  flags: FLAGS,
  examples: ["calmonkey brand check"],
  seeAlso: "calmonkey brand kit, calmonkey brand status",
  async run(input) {
    const { result, resolved } = await read<Check>(input, "brand_check");
    const items = [...result.items].sort((a, b) => ORDER[a.level] - ORDER[b.level]);
    const passed = items.filter((i) => i.level === "pass").length;
    emit(
      input,
      () =>
        [
          `pre-flight ${label(resolved)} | ${result.failed} failed, ${plural(result.warnings, "warning")}, ${passed} passed`,
          ...items.map((i) => `${i.level}  ${one(i.title)}: ${one(i.detail)}`),
          result.failed ? "fix the failed checks, then run again: calmonkey brand check" : "all checks passed: ask Google to review your app; calmonkey brand kit has the wording it asks for",
        ].join("\n"),
      () => result,
      true,
    );
    return result.failed ? EXIT.failed : EXIT.ok;
  },
};

const kit: Command = {
  name: "brand kit",
  group: "other",
  summary: "Print the verification kit: why the app needs each permission, wording for your privacy policy and home page, and the shot list for the demo video Google asks for",
  flags: FLAGS,
  examples: ["calmonkey brand kit", "calmonkey brand kit > kit.md"],
  seeAlso: "calmonkey brand check",
  async run(input) {
    const { result, resolved } = await read<Kit>(input, "brand_kit");
    emit(input, () => [`verification kit ${label(resolved)} | ${plural(result.sections.length, "section")}`, ...result.sections.map((s) => `\n## ${s.title}\n${s.text.trimEnd()}`)].join("\n"), () => result, true);
    return EXIT.ok;
  },
};

const USES = ["own", "shared"] as const;

const switchCommand: Command = {
  name: "brand switch",
  group: "other",
  summary: "Choose which app NEW connections sign in with: your own, or CalMonkey's shared one. Always described first; people already connected keep working either way",
  usage: "own|shared",
  write: true,
  flags: WRITE_FLAGS,
  examples: ["calmonkey brand switch own", "calmonkey brand switch own --confirm cmmcf_…   (after the person agreed)", "calmonkey brand switch shared"],
  seeAlso: "calmonkey brand status",
  async run(input) {
    person(input);
    const use = input.args[0] as (typeof USES)[number] | undefined;
    if (!use || !USES.includes(use)) throw new Failure({ code: "missing_argument", message: "calmonkey brand switch takes own (your own app) or shared (CalMonkey's app)", exit: EXIT.usage, write: true, fix: ["calmonkey brand switch own", "calmonkey brand switch shared"] });
    return write<{ use: string; changed: boolean }>(input, "brand_switch", { ...appArg(input), use }, {
      check: "calmonkey brand status",
      done: ({ result, resolved }) =>
        emit(
          input,
          () =>
            `${result.changed ? "switched" : "already on"} ${label(resolved)}: new connections use ${result.use === "own" ? "your own app" : "CalMonkey's app"} | people already connected keep working; nobody has to connect again\nback: calmonkey brand switch ${result.use === "own" ? "shared" : "own"}`,
          () => result,
        ),
    });
  },
};

export const BRAND_COMMANDS: Command[] = [status, domainSet, domainVerify, googleUpload, check, switchCommand, kit];
