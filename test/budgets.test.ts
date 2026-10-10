import { readFileSync, writeFileSync } from "node:fs";
import { get_encoding } from "tiktoken";
import { afterAll, describe, expect, it } from "vitest";
import { COMMANDS, rootHelp } from "../src/cli.js";
import { commandHelp } from "../src/command.js";
import { operationText, operations } from "../src/commands/learn.js";
import { CLI_CODES } from "../src/data/codes.js";
import { EXIT, Failure, failureText } from "../src/fail.js";
import { agentGuide, agentsSection } from "../src/guide.js";
import { busyText, confirmationText, daysOf, eventGetText, eventsCountText, eventsListJson, eventsListText, freeText, merge, type Period } from "../src/render.js";
import { startOfDay } from "../src/time.js";
import { DESIGN_REVIEW, EVENTS, RESOLVED, busyPeriods } from "./helpers/fixtures.js";

// Budgets are tests. Help text and output grow by a
// line at a time; this file is where that stops. Tokens are counted with tiktoken's
// o200k_base, the tokenizer the budgets were set with; the byte caps are what the tool
// itself enforces at run time, having no tokenizer.

const encoding = get_encoding("o200k_base");
afterAll(() => encoding.free());
const tokens = (text: string) => encoding.encode(text).length;
const bytes = (text: string) => Buffer.byteLength(text);

const measured: Record<string, number> = {};
const within = (name: string, text: string, budget: number, cap?: number) => {
  measured[name] = tokens(text);
  expect(measured[name], `${name}: ${measured[name]} tokens, budget ${budget}`).toBeLessThanOrEqual(budget);
  if (cap) expect(bytes(text), `${name}: ${bytes(text)} bytes, cap ${cap}`).toBeLessThanOrEqual(cap);
};

const TZ = "Australia/Melbourne";
const NOW = new Date("2026-10-09T01:00:00Z");
const VIEW = { resolved: RESOLVED, from: "2026-10-12", to: "2026-10-17", tz: TZ, now: NOW };

describe("help", () => {
  it("root --help is at most 400 tokens", () => within("root --help", rootHelp("0.2.0"), 400));

  it("every command's --help is at most 400 tokens", () => {
    const over = COMMANDS.filter((spec) => (measured[`${spec.name} --help`] = tokens(commandHelp(spec))) > 400).map((spec) => `${spec.name}: ${measured[`${spec.name} --help`]}`);
    expect(over).toEqual([]);
  });

  it("agent-guide is at most 450 tokens", () => within("agent-guide", agentGuide("0.2.0"), 450));

  it("schema of any operation is at most 600 tokens", () => {
    for (const op of operations()) within(`schema ${op.id}`, operationText(op.id, COMMANDS.find((c) => c.operationId === op.id))!, 600);
  });

  it("explain of any of the tool's codes is at most 120 tokens", () => {
    for (const [code, entry] of Object.entries(CLI_CODES)) within(`explain ${code}`, `${code}: ${entry.means}\nfix: ${entry.fix}`, 120);
  });
});

describe("output", () => {
  it("a default list of 20 rows is at most 900 tokens and 4 KB; the same as --json is under the explicit cap", () => {
    const view = { ...VIEW, events: EVENTS, total: 57, nextCursor: "WzE3OTQyNjE2MDAwMDAsIjZhYzgyNmUzNTg5ZTllYTcxOWMxZjNmMiIsMiwyXQ.20" };
    within("events list (20 rows)", eventsListText(view, `calmonkey events list --from 2026-10-12 --to 2026-10-17 --cursor ${view.nextCursor}`), 900, 4096);
    within("events list --json (20 rows)", JSON.stringify(eventsListJson(view)), 6000, 24 * 1024);
    // Text is the default because it is the smaller of the two, by a wide margin.
    expect(measured["events list (20 rows)"]!).toBeLessThan(measured["events list --json (20 rows)"]! * 0.75);
  });

  it("--count is at most 150 tokens and 1 KB", () => {
    within("events list --count", eventsCountText({ total: 57, capped: false, days: [{ day: "2026-10-12", count: 11 }, { day: "2026-10-13", count: 12 }, { day: "2026-10-14", count: 13 }, { day: "2026-10-15", count: 10 }, { day: "2026-10-16", count: 11 }], ours: 19, with_guests: 14, repeating: 12 }, VIEW), 150, 1024);
  });

  it("status is at most 150 tokens", () => {
    within("status", 'signed in: "Acme Bookings Pty Ltd" as owner | test-mode applications only, event text shown, may write\napplication: "booking-app (dev)" (test), client id Ri_mtRjsj1lWtHEnpkXRPzxF_EX76DGl, from .env.local\naccounts: 3 (1 connected, 2 application calendars): calmonkey accounts list\nzone: Australia/Melbourne (CALMONKEY_TZ, .env.local)', 150, 1024);
  });

  it("events get is at most 500 tokens and 3 KB, also with the longest description it shows", () => {
    within("events get", eventGetText({ event: DESIGN_REVIEW, ours: false, resolved: RESOLVED, tz: TZ, full: false }, "7f3a"), 500, 3072);
    const long = { ...DESIGN_REVIEW, description: { untrusted_text: "Please read the document before the meeting and bring your questions. ".repeat(15).slice(0, 1000), truncated: true as const } };
    within("events get (500-char description)", eventGetText({ event: long, ours: false, resolved: RESOLVED, tz: TZ, full: false }, "7f3a"), 500, 3072);
  });

  it("free/busy over the default 14 days is at most 600 tokens and 3 KB, busy or free", () => {
    const periods: Period[] = busyPeriods(14).map((p) => ({ start: Date.parse(p.start), end: Date.parse(p.end), tentative: p.free_busy_status === "tentative" }));
    const days = daysOf("2026-10-12", "2026-10-26", TZ, (day) => startOfDay(day, TZ));
    const view = { from: "2026-10-12", to: "2026-10-26", tz: TZ, now: NOW };
    within("freebusy (14 days)", busyText({ busy: merge(periods), days, resolved: RESOLVED, accounts: [RESOLVED.account_id], calendars: 2, ...view, hints: true }), 600, 3072);
    const free = days.flatMap((d) => [{ start: d.from + 10 * 3600_000, end: d.from + 11 * 3600_000, tentative: false }, { start: d.from + 11.75 * 3600_000, end: d.from + 14.5 * 3600_000, tentative: false }, { start: d.from + 15.5 * 3600_000, end: d.from + 17 * 3600_000, tentative: false }]);
    within("freebusy --free (14 days, 2 accounts)", freeText({ free, days, accounts: [RESOLVED.account_id, "acc_91bc02aa0000000000000000"], minutes: 30, within: "09:00-17:00", ...view }), 600, 3072);
  });

  it("an error is at most 120 tokens and 600 bytes", () => {
    const zone = new Failure({ code: "invalid_local_time", message: "--start 2026-11-03T10:00 has no time zone, and CALMONKEY_TZ is not set", exit: EXIT.usage, write: true, fix: ['calmonkey events put booking-1042 --start 2026-11-03T10:00 --end 2026-11-03T11:00 --title "Lash lift" --tz Australia/Melbourne', "(Australia/Melbourne is this machine's zone; use the zone of the calendar's owner)"] });
    within("error (no zone)", failureText(zone, { hints: true }), 120, 600);
    const refused = new Failure({ code: "attendees_unsupported", message: "Not valid. attendees: this calendar cannot send invitations. Nothing was changed", http: 422, field: "attendees", exit: EXIT.refused, write: true, more: "request req_4b0d7c2e9f1a46d38b5e0c7a2f9d1e63: calmonkey logs requests --id req_4b0d7c2e9f1a46d38b5e0c7a2f9d1e63" });
    within("error (422)", failureText(refused, { hints: true }), 120, 600);
    const signIn = new Failure({ code: "not_signed_in", message: "no sign-in on this machine for app.calmonkey.com", exit: EXIT.signIn, fix: ["ask the person to run this in their own terminal: calmonkey login", "(it opens a browser; nothing here waits for it)"] });
    within("error (not signed in)", failureText(signIn, { hints: true }), 120, 600);
  });

  it("a confirmation is at most 150 tokens and 700 bytes", () => {
    const will = "Delete the event “booking-1041” from calendar cal_89645320138ae1ac547189a1 of account acc_38da51e7b1345bb5fae3656a in the test application “booking-app (dev)”. It deletes an event, which cannot be undone. It makes the calendar email the event's guests.";
    within("NOT DONE", confirmationText(will, '"Lash lift with Grace" (third-party text), Tue 2026-10-13 11:30-12:30, 2 guests', "calmonkey events delete booking-1041 --confirm cmmcf_hiVQEmVVq9edKqwWismzpH9ZCwTcGId3hNmoWyzmIKY", 10), 150, 700);
  });
});

describe("what is always loaded, and the skill", () => {
  it("the AGENTS.md section is at most 200 tokens", () => within("AGENTS.md section", agentsSection({ version: "0.2.0", envFile: ".env.local" }), 200));

  it("the bundled SKILL.md body is at most 1,500 tokens", () => {
    const skill = readFileSync(new URL("../skills/calmonkey-api/SKILL.md", import.meta.url), "utf8");
    const body = skill.replace(/^---\n[\s\S]*?\n---\n/, "");
    expect(body).not.toBe(skill);
    within("SKILL.md body", body, 1500);
  });

  it("writes what was measured to docs/BUDGETS.md, so the numbers in the docs are the test's own", () => {
    const worst = (pattern: RegExp) => Object.entries(measured).filter(([n]) => pattern.test(n) && n !== "root --help").sort((a, b) => b[1] - a[1])[0]!;
    const rows: [string, number, string][] = [
      ["Root `--help`", 400, String(measured["root --help"])],
      ["One command's `--help` (largest)", 400, `${worst(/ --help$/)[1]} (\`${worst(/ --help$/)[0].replace(" --help", "")}\`)`],
      ["`agent-guide`", 450, String(measured["agent-guide"])],
      ["`schema <command>` (largest)", 600, `${worst(/^schema /)[1]} (\`${worst(/^schema /)[0].replace("schema ", "")}\`)`],
      ["List, default (20 rows)", 900, String(measured["events list (20 rows)"])],
      ["The same list with `--json`", 6000, String(measured["events list --json (20 rows)"])],
      ["`events get`, default", 500, `${measured["events get"]}; ${measured["events get (500-char description)"]} with a 500-character description`],
      ["`freebusy`, default (14 days)", 600, `${measured["freebusy (14 days)"]}; ${measured["freebusy --free (14 days, 2 accounts)"]} with \`--free\``],
      ["`--count`", 150, String(measured["events list --count"])],
      ["`status`", 150, String(measured.status)],
      ["Error", 120, `${measured["error (not signed in)"]} to ${Math.max(measured["error (no zone)"]!, measured["error (422)"]!)}`],
      ["`explain <code>` (largest)", 120, `${worst(/^explain /)[1]} (\`${worst(/^explain /)[0].replace("explain ", "")}\`)`],
      ["Confirmation block", 150, String(measured["NOT DONE"])],
      ["AGENTS.md section", 200, String(measured["AGENTS.md section"])],
      ["SKILL.md body", 1500, String(measured["SKILL.md body"])],
    ];
    const text = `# Token budgets, measured\n\nWritten by \`test/budgets.test.ts\` on every run: tiktoken \`o200k_base\`, on the fixtures of \`test/helpers/fixtures.ts\`. The test fails when a row goes over its budget, and when this file is not what it measures.\n\n| Output | Budget (tokens) | Measured |\n|---|---|---|\n${rows.map(([name, budget, got]) => `| ${name} | ${budget.toLocaleString("en-US")} | ${got} |`).join("\n")}\n`;
    const file = new URL("../docs/BUDGETS.md", import.meta.url);
    if (process.env.UPDATE_BUDGETS) writeFileSync(file, text);
    expect(readFileSync(file, "utf8"), "run: UPDATE_BUDGETS=1 npx vitest run test/budgets.test.ts").toBe(text);
  });
});
