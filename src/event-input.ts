import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Command, Flags } from "./command.js";
import { list, on, str } from "./command.js";
import type { Context } from "./context.js";
import { EXIT, Failure } from "./fail.js";
import { requireZone, zoneOf } from "./project.js";
import { printable, without } from "./quote.js";
import { describeRule, occurrences, parseDays, type Rule } from "./recurrence.js";
import { TimeError, WEEKDAYS, WEEKDAY_NAMES, addDays, isDay, isoUtc, parseDuration, parseWhen, span, utcMinute, wallOf, weekdayIndex, weekdayOf, zoneLabel } from "./time.js";

// From the flags of `events put` / `events edit` to the body the API takes, with everything
// that can be checked on this machine checked first: a time needs a zone, a time the clocks
// skip is refused, a weekly rule must fit the day it starts on, a skipped day must be one the
// rule has. Each refusal carries the corrected command.

export type Echo = {
  /** "Tue 2026-11-03 10:00-11:00 Australia/Melbourne (+11:00) = 2026-11-02T23:00Z" */
  when?: string;
  repeats?: string;
  notes: string[];
  invited: string[];
  removed: string[];
  notify: boolean;
};

export type Built = { body: Record<string, unknown>; echo: Echo };

const fail = (code: string, message: string, write = true, fix?: string[]) => new Failure({ code, message, exit: EXIT.usage, write, ...(fix ? { fix } : {}) });

/** "Grace Park <grace@example.com>" or a bare address. */
function guest(value: string): { email: string; display_name?: string } {
  const named = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
  const email = (named ? named[2]! : value.trim()).toLowerCase();
  if (!/^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(email) || email.length > 254) throw fail("invalid_email", `--guest ${JSON.stringify(value.slice(0, 60))} is not an email address. Use grace@example.com or "Grace Park <grace@example.com>"`);
  const name = named?.[1]?.replace(/^"|"$/g, "").trim();
  return { email, ...(name ? { display_name: name.slice(0, 256) } : {}) };
}

function timeFailure(error: unknown, ctx: Context, flags: Flags, argv: readonly string[], spec: Command): never {
  if (!(error instanceof TimeError)) throw error;
  if (error.code === "invalid_local_time") requireZone(ctx, flags as { tz?: string }, argv, error.message, spec.write);
  if (error.code === "nonexistent_local_time" && error.next) {
    // The same command with the first time that does exist: only when the bad time can be found in what was typed.
    const bad = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})/.exec(error.message)?.[1];
    const fixed = bad ? argv.map((a) => (a.startsWith(bad) ? error.next! : a)) : null;
    throw new Failure({ code: error.code, message: error.message, exit: EXIT.refused, write: spec.write, fix: fixed && !argv.includes("--duration") && !argv.includes("--end") ? [printable(fixed)] : [`the first time after the change is ${error.next}; choose a time that exists and give --start and --end again`] });
  }
  throw new Failure({ code: error.code, message: error.message, exit: EXIT.usage, write: spec.write });
}

/** The start and end of an event from --start, --end, --duration and --all-day, as the API writes them. */
function times(ctx: Context, flags: Flags, argv: readonly string[], spec: Command, need: boolean): { start?: string; end?: string; tz?: string; when?: string; startDay?: string; allDay?: boolean; notes: string[] } {
  const startRaw = str(flags, "start");
  const endRaw = str(flags, "end");
  const durationRaw = str(flags, "duration");
  const notes: string[] = [];
  if (!startRaw) {
    if (need) throw fail("missing_flag", "an event needs --start", true, [`${printable([...argv, "--start", "2026-11-03T10:00", ...(endRaw || durationRaw ? [] : ["--end", "2026-11-03T11:00"])])}`]);
    if (endRaw || durationRaw) throw fail("missing_flag", "--end or --duration needs --start too: give both ends of the new time");
    return { notes };
  }
  if (endRaw && durationRaw) throw fail("bad_flag", "give --end or --duration, not both");
  let tz = zoneOf(ctx, flags as { tz?: string });
  let start;
  let end;
  try {
    start = parseWhen("--start", startRaw, tz);
    end = endRaw ? parseWhen("--end", endRaw, tz) : undefined;
  } catch (error) {
    timeFailure(error, ctx, flags, argv, spec);
  }
  if (start.kind === "day" || on(flags, "all-day")) {
    if (start.kind !== "day") throw fail("bad_flag", "--all-day takes dates: --start 2026-11-03 (and --end, the day after the last day)");
    if (end && end.kind !== "day") throw fail("bad_flag", "--end must be a date when --start is a date");
    const days = durationRaw ? /^(\d{1,3})d$/.exec(durationRaw)?.[1] : undefined;
    if (durationRaw && !days) throw fail("bad_flag", "for a whole-day event --duration is in days: --duration 2d");
    const endDay = end ? end.day : addDays(start.day, days ? Number(days) : 1);
    if (endDay <= start.day) throw fail("invalid_time", `--end ${endDay} must be after --start ${start.day}: the end date of a whole-day event is the day after its last day`, true, [printable([...without(argv, "--end"), "--end", addDays(start.day, 1)])]);
    return { start: start.day, end: endDay, tz, when: span(start.day, endDay, tz ?? "Etc/UTC"), startDay: start.day, allDay: true, notes };
  }
  if (end?.kind === "day") throw fail("bad_flag", "--end must be a time when --start is a time: --end 2026-11-03T11:00");
  const minutes = durationRaw ? parseDuration(durationRaw) : null;
  if (durationRaw && !minutes) throw fail("bad_flag", "--duration is a length such as 30m, 45m, 1h or 1h30m");
  const endInstant = end ? end.instant : minutes ? new Date(start.instant.getTime() + minutes * 60_000) : undefined;
  if (!endInstant) {
    if (need) throw fail("missing_flag", "an event needs --end (or --duration)", true, [printable([...argv, "--duration", "1h"])]);
    // A change that only names a new start: the server keeps the event's length.
    const shown = tz ?? "Etc/UTC";
    const w = wallOf(start.instant, shown);
    if (start.twice) notes.push(`${startRaw} happens twice that day (the clocks go back); this is the first`);
    return { start: isoUtc(start.instant), tz, when: `${weekdayOf(w.day)} ${w.day} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")} (same length as before) ${zoneLabel(shown, start.instant)} = ${utcMinute(start.instant)}`, startDay: w.day, notes };
  }
  if (endInstant.getTime() <= start.instant.getTime()) throw fail("invalid_time", "--end must be after --start");
  if (start.twice) notes.push(`${startRaw} happens twice that day (the clocks go back); this is the first`);
  const shown = tz ?? "Etc/UTC";
  if (!tz) notes.push("shown in UTC: no --tz was given");
  tz = tz ?? undefined;
  return { start: isoUtc(start.instant), end: isoUtc(endInstant), tz, when: `${span(isoUtc(start.instant), isoUtc(endInstant), shown)} ${zoneLabel(shown, start.instant)} = ${utcMinute(start.instant)}`, startDay: wallOf(start.instant, shown).day, notes };
}

function recurrence(flags: Flags, argv: readonly string[], startDay: string | undefined, tz: string | undefined, allDay: boolean | undefined, ctx: Context): { value?: Record<string, unknown>; text?: string } {
  const repeat = str(flags, "repeat");
  const given = ["every", "on", "count", "until"].filter((f) => flags[f] !== undefined);
  const skips = list(flags, "skip");
  if (!repeat) {
    if (given.length || skips.length) throw fail("missing_flag", `--${given[0] ?? "skip"} needs --repeat daily|weekly|monthly|yearly`);
    return {};
  }
  if (!["daily", "weekly", "monthly", "yearly"].includes(repeat)) throw fail("bad_flag", "--repeat is daily, weekly, monthly or yearly");
  if (!startDay) throw fail("missing_flag", "--repeat needs --start: a series is written from its first occurrence");
  if (!allDay && !tz) requireZone(ctx, flags as { tz?: string }, argv, "a repeating event needs a time zone (it repeats at the same local time)", true);
  const rule: Rule = { frequency: repeat as Rule["frequency"] };
  const every = str(flags, "every");
  if (every !== undefined) {
    if (!/^\d{1,3}$/.test(every) || Number(every) < 1) throw fail("bad_flag", "--every is a whole number: --every 2 with --repeat weekly is every second week");
    if (Number(every) > 1) rule.interval = Number(every);
  }
  const count = str(flags, "count");
  const until = str(flags, "until");
  if (count !== undefined && until !== undefined) throw fail("bad_flag", "give --count or --until, not both");
  if (count !== undefined) {
    if (!/^\d{1,4}$/.test(count) || Number(count) < 1) throw fail("bad_flag", "--count is how many times in all, the first included: --count 10");
    rule.count = Number(count);
  }
  if (until !== undefined) {
    if (!isDay(until)) throw fail("bad_flag", "--until is the last day an occurrence may fall on: --until 2027-01-31");
    rule.until = until;
  }
  const onRaw = str(flags, "on");
  if (onRaw !== undefined) {
    if (repeat !== "weekly") throw fail("bad_flag", "--on goes with --repeat weekly: --on tue,thu");
    const days = parseDays(onRaw);
    if (!days) throw fail("bad_flag", "--on takes days of the week: --on tue or --on mon,wed,fri");
    if (!days.includes(weekdayIndex(startDay))) {
      // The next day the rule has, at the same time of day: what was most likely meant.
      let next = startDay;
      for (let i = 1; i <= 7 && !days.includes(weekdayIndex(next)); i++) next = addDays(startDay, i);
      const moved = argv.map((a) => (a.startsWith(startDay) ? next + a.slice(startDay.length) : a));
      throw new Failure({ code: "weekday_mismatch", message: `--start ${startDay} is a ${WEEKDAYS[weekdayIndex(startDay)]}, which --on ${onRaw} does not include: a series starts on one of its own days`, exit: EXIT.usage, write: true, fix: [printable(moved), `(${next} is the next ${WEEKDAYS[weekdayIndex(next)]})`] });
    }
    rule.by_day = days.map((n) => ({ day: WEEKDAY_NAMES[n]! }));
  }
  for (const day of skips) if (!isDay(day)) throw fail("bad_flag", `--skip ${day.slice(0, 20)} is not a date: --skip 2026-11-17`);
  const { days } = occurrences(startDay, rule);
  const stray = skips.find((day) => !days.includes(day));
  if (stray) {
    const near = days.filter((d) => d > stray)[0] ?? days[days.length - 1];
    throw new Failure({ code: "not_an_occurrence", message: `--skip ${stray} is not a day this series has (${weekdayOf(stray)}); a skipped day is an occurrence's own date`, exit: EXIT.usage, write: true, fix: [`its days are ${days.slice(0, 6).join(", ")}${days.length > 6 ? ", …" : ""}${near ? `; the nearest after ${stray} is ${near}` : ""}`] });
  }
  return { value: { rules: [rule], ...(skips.length ? { exceptions: { add: skips.map((date) => ({ date })) } } : {}) }, text: describeRule(startDay, rule, skips) };
}

/** `--weekday tue`: the start must be that day, or nothing is written. */
function checkWeekday(flags: Flags, startDay: string | undefined): void {
  const wanted = str(flags, "weekday");
  if (wanted === undefined) return;
  const days = parseDays(wanted);
  if (!days || days.length !== 1) throw fail("bad_flag", "--weekday is one day of the week: --weekday tue");
  if (!startDay) throw fail("missing_flag", "--weekday checks --start, which is missing");
  if (weekdayIndex(startDay) !== days[0]) {
    let next = startDay;
    for (let i = 1; i <= 7 && weekdayIndex(next) !== days[0]; i++) next = addDays(startDay, i);
    throw new Failure({ code: "weekday_mismatch", message: `--start ${startDay} is a ${WEEKDAYS[weekdayIndex(startDay)]}, not a ${WEEKDAYS[days[0]!]}`, exit: EXIT.usage, write: true, fix: [`the next ${WEEKDAYS[days[0]!]} is ${next}: give --start and --end again with that date`] });
  }
}

/** The body of a write from flags. `need`: everything a whole event needs must be there (`put`); otherwise only what was named (`edit`). */
export function buildEvent(ctx: Context, flags: Flags, argv: readonly string[], spec: Command, need: boolean): Built {
  const body: Record<string, unknown> = {};
  const title = str(flags, "title");
  if (title !== undefined) {
    if (!title.trim()) throw fail("bad_flag", "--title must not be empty");
    body.summary = title;
  } else if (need) throw fail("missing_flag", "an event needs --title", true, [printable([...argv, "--title", "Meeting"])]);

  const t = times(ctx, flags, argv, spec, need);
  if (t.start) body.start = t.start;
  if (t.end) body.end = t.end;
  if (t.tz && (t.start || str(flags, "tz"))) body.tzid = t.tz;
  checkWeekday(flags, t.startDay);

  for (const [name, key] of [["description", "description"], ["url", "url"]] as const) if (str(flags, name) !== undefined) body[key] = str(flags, name) || null;
  if (str(flags, "location") !== undefined) body.location = str(flags, "location") ? { description: str(flags, "location") } : null;
  if (on(flags, "free") && on(flags, "busy")) throw fail("bad_flag", "give --free or --busy, not both");
  if (on(flags, "free")) body.transparency = "transparent";
  if (on(flags, "busy")) body.transparency = "opaque";
  for (const field of list(flags, "clear")) {
    for (const name of field.split(",").map((f) => f.trim()).filter(Boolean)) {
      if (!["description", "location", "url"].includes(name)) throw fail("bad_flag", "--clear takes description, location or url");
      body[name] = null;
    }
  }

  const invite = list(flags, "guest").map(guest);
  const remove = list(flags, "remove-guest").map(guest);
  if (invite.length || remove.length) body.attendees = { ...(invite.length ? { invite } : {}), ...(remove.length ? { remove: remove.map(({ email }) => ({ email })) } : {}) };
  if (on(flags, "no-notify")) body.notify_attendees = false;
  if (on(flags, "meeting-link") && on(flags, "no-meeting-link")) throw fail("bad_flag", "give --meeting-link or --no-meeting-link, not both");
  // "integrated": a calendar that cannot make a link answers 422 instead of quietly making none.
  if (on(flags, "meeting-link")) body.conferencing = { profile_id: "integrated" };
  if (on(flags, "no-meeting-link")) body.conferencing = { profile_id: "none" };

  if (on(flags, "no-repeat")) {
    if (str(flags, "repeat")) throw fail("bad_flag", "give --repeat or --no-repeat, not both");
    body.recurrence = null;
  }
  const series = recurrence(flags, argv, t.startDay, t.tz, t.allDay, ctx);
  if (series.value) body.recurrence = series.value;

  return { body, echo: { ...(t.when ? { when: t.when } : {}), ...(series.text ? { repeats: series.text } : on(flags, "no-repeat") ? { repeats: "no longer repeats" } : {}), notes: t.notes, invited: invite.map((g) => g.email), removed: remove.map((g) => g.email), notify: !on(flags, "no-notify") } };
}

// --- --from-file -------------------------------------------------------------------------------

const BODY_KEYS = ["event_id", "summary", "description", "start", "end", "tzid", "location", "url", "transparency", "attendees", "notify_attendees", "recurrence", "conferencing"];
const MAX_FILE_BYTES = 256 * 1024;

/**
 * A whole event body from a file (or stdin with `-`). Only a JSON object whose keys are the
 * API's own is accepted, and nothing of the file is ever echoed: a command told to read
 * ~/.ssh/id_rsa must not be able to turn it into an event description sent to a guest.
 */
export function bodyFromFile(ctx: Context, file: string, stdin: () => string, spec: Command): Record<string, unknown> {
  const refuse = (message: string) => new Failure({ code: "invalid_file", message, exit: EXIT.usage, write: spec.write, fix: [`calmonkey events get <event_id> --as-put   prints a body of the right shape; calmonkey schema ${spec.name} lists its fields`] });
  let text: string;
  if (file === "-") text = stdin();
  else {
    const full = path.resolve(ctx.cwd, file);
    if (!existsSync(full) || !statSync(full).isFile()) throw refuse("--from-file names no file");
    if (statSync(full).size > MAX_FILE_BYTES) throw refuse("--from-file is larger than 256 KB");
    text = readFileSync(full, "utf8");
  }
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw refuse("the body is larger than 256 KB");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw refuse("--from-file is not JSON (its content is not shown)");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw refuse("--from-file must hold one JSON object: the body of an event");
  const unknown = Object.keys(parsed).filter((k) => !BODY_KEYS.includes(k));
  if (unknown.length) throw refuse(`--from-file has ${unknown.length === 1 ? "a key" : `${unknown.length} keys`} an event does not have. The keys are: ${BODY_KEYS.join(", ")}`);
  return parsed as Record<string, unknown>;
}
