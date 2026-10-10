import { DESIGN_REVIEW, EVENTS, RESOLVED, busyPeriods } from "../test/helpers/fixtures.js";
import { COMMANDS, rootHelp } from "./cli.js";
import { commandHelp } from "./command.js";
import { EXIT, Failure, failureText } from "./fail.js";
import { STARTER_PROMPT, agentGuide, agentsSection } from "./guide.js";
import { busyText, confirmationText, daysOf, eventGetText, eventsCountText, eventsListJson, eventsListText, freeText, merge, type Period } from "./render.js";
import { startOfDay } from "./time.js";

// The tool described by itself, for the reference page on the docs site (calmonkey.com/docs/cli)
// and the skill's reference file: every command's own help, the guide, the exit codes, and
// samples of the output made by the same functions that print it. scripts/reference.mjs writes
// it to docs/reference.json; a test fails when that file is not what the code says, and the
// site's repository fails when its copy is not that file. So the page cannot describe a flag
// the tool does not have.

const TZ = "Australia/Melbourne";
const NOW = new Date("2026-10-09T01:00:00Z");

const GROUPS: [key: string, title: string][] = [["start", "Start"], ["data", "Calendar data"], ["debug", "Debug"], ["learn", "Learn"], ["other", "Other"]];

export function buildReference(version: string) {
  const view = { resolved: RESOLVED, from: "2026-10-12", to: "2026-10-17", tz: TZ, now: NOW };
  const list = { ...view, events: EVENTS.slice(0, 5), total: 57, nextCursor: "eyJ2IjoxLCJhIjoi.5" };
  const periods: Period[] = busyPeriods(3).map((p) => ({ start: Date.parse(p.start), end: Date.parse(p.end), tentative: p.free_busy_status === "tentative" }));
  const days = daysOf("2026-10-12", "2026-10-15", TZ, (day) => startOfDay(day, TZ));
  const window = { from: "2026-10-12", to: "2026-10-15", tz: TZ, now: NOW };
  const free = days.flatMap((d) => [{ start: d.from + 10 * 3600_000, end: d.from + 11 * 3600_000, tentative: false }, { start: d.from + 11.75 * 3600_000, end: d.from + 14.5 * 3600_000, tentative: false }, { start: d.from + 15.5 * 3600_000, end: d.from + 17 * 3600_000, tentative: false }]);
  return {
    version,
    root_help: rootHelp(version),
    agent_guide: agentGuide(version),
    agents_section: agentsSection({ version, envFile: ".env.local" }),
    starter_prompt: STARTER_PROMPT.join("\n"),
    exit_codes: [
      [EXIT.ok, "done"],
      [EXIT.failed, "failed"],
      [EXIT.usage, "bad command, flag or value; or a choice only you can make (which account, which calendar)"],
      [EXIT.signIn, "not signed in: a person runs calmonkey login"],
      [EXIT.notFound, "not found"],
      [EXIT.notAllowed, "not allowed for this sign-in"],
      [EXIT.refused, "the API refused the input (422)"],
      [EXIT.rateLimited, "rate limited"],
      [EXIT.network, "network or timeout"],
      [EXIT.confirm, "confirmation needed: nothing was changed"],
      [EXIT.interrupted, "interrupted"],
    ].map(([code, meaning]) => ({ code, meaning })),
    groups: GROUPS.map(([key, title]) => ({ title, commands: COMMANDS.filter((c) => c.group === key).map((c) => ({ name: c.name, summary: c.summary, ...(c.operation ? { calls: c.operation } : {}), help: commandHelp(c) })) })),
    samples: {
      events_list: eventsListText(list, `calmonkey events list --from 2026-10-12 --to 2026-10-17 --cursor ${list.nextCursor}`),
      events_list_json: JSON.stringify(eventsListJson({ ...list, events: EVENTS.slice(0, 2) })),
      events_count: eventsCountText({ total: 57, capped: false, days: [{ day: "2026-10-12", count: 11 }, { day: "2026-10-13", count: 12 }, { day: "2026-10-14", count: 13 }, { day: "2026-10-15", count: 10 }, { day: "2026-10-16", count: 11 }], ours: 19, with_guests: 14, repeating: 12 }, view),
      events_get: eventGetText({ event: DESIGN_REVIEW, ours: false, resolved: RESOLVED, tz: TZ, full: false }, "7f3a"),
      freebusy: busyText({ busy: merge(periods), days, resolved: RESOLVED, accounts: [RESOLVED.account_id], calendars: 2, ...window, hints: true }),
      freebusy_free: freeText({ free, days, accounts: [RESOLVED.account_id, "acc_91bc02aa0000000000000000"], minutes: 30, within: "09:00-17:00", ...window }),
      written: 'written booking-1042 to calendar cal_89645320 (test application "booking-app (dev)") (new)\nwhen    Tue 2026-11-03 10:00-11:00 Australia/Melbourne (+11:00) = 2026-11-02T23:00Z\nrepeats weekly on Tue, 10 times, last Tue 2027-01-05; skipped: 2026-11-17\nguests  none added, nobody was emailed\ncheck: calmonkey events get booking-1042',
      not_done: confirmationText("Delete the event “booking-1041” from calendar cal_89645320138ae1ac547189a1 of account acc_38da51e7b1345bb5fae3656a in the test application “booking-app (dev)”. It deletes an event, which cannot be undone.", '"Lash lift with Grace" (third-party text), Tue 2026-10-13 11:30-12:30, 2 guests', "calmonkey events delete booking-1041 --confirm cmmcf_hiVQEmVVq9edKqwWismzpH9ZCwTcGId3hNmoWyzmIKY", 10),
      error: failureText(new Failure({ code: "invalid_local_time", message: "--start 2026-11-03T10:00 has no time zone, and CALMONKEY_TZ is not set", exit: EXIT.usage, write: true, fix: ['calmonkey events put booking-1042 --title "Lash lift" --start 2026-11-03T10:00 --duration 1h --tz Australia/Melbourne', "(Australia/Melbourne is this machine's zone; use the zone of the calendar's owner)"] }), { hints: true }),
    },
  };
}

export type Reference = ReturnType<typeof buildReference>;
