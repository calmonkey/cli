import { COMMON, flag, list, on, str, type Command } from "../command.js";
import { EXIT, Failure } from "../fail.js";
import { busyText, daysOf, durationLabel, freeText, merge, type Period } from "../render.js";
import { addDays, isoInZone, localToInstant, parseDuration, wallOf } from "../time.js";
import type { Resolved } from "../tools.js";
import { call, emit, hints, readWindow, target } from "./data.js";

// Busy times, and the arithmetic an agent should not be asked to do: which times are free for
// everyone, for at least so long, inside working hours. No event text is ever read for this.

type FreeBusyPage = { free_busy: { calendar_id: string; start: string; end: string; free_busy_status: string }[]; next_cursor?: string };

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const MAX_PERIODS = 4000;

const freebusyCommand: Command = {
  name: "freebusy",
  group: "data",
  summary: "When an account's calendars are busy; with --free, the free slots (for several accounts: free for all of them). Returns no event text",
  operation: "tool read_free_busy, GET /v1/free_busy",
  operationId: "getFreeBusy",
  flags: [
    flag.value("from", "<when>", "start: a date, a time, today, tomorrow, +7d (default today)"),
    flag.value("to", "<when>", "end, exclusive (default 14 days after --from)"),
    COMMON.tz,
    flag.list("account", "<id>", "the account; give it again for each person who must be free"),
    flag.list("calendar", "<id>", "only this calendar"),
    flag.bool("free", "show free slots instead of busy periods"),
    flag.value("duration", "<length>", "with --free: the shortest slot wanted, e.g. 45m (default 30m)"),
    flag.value("within", "<HH:MM-HH:MM>", "with --free: the hours of each day to look in (default 09:00-17:00)"),
    flag.bool("by-calendar", "busy periods per calendar, not joined"),
    COMMON.json,
    COMMON.app,
  ],
  examples: ["calmonkey freebusy --from 2026-11-03 --to 2026-11-08 --tz Australia/Melbourne", "calmonkey freebusy --free --duration 45m --within 09:00-17:00 --account acc_38da51e7 --account acc_91bc02aa --from 2026-11-03 --to 2026-11-08"],
  seeAlso: "calmonkey events list (with titles), calmonkey accounts list",
  async run(input) {
    const { flags } = input;
    const window = readWindow(input, { from: "today", days: 14 });
    const accounts = list(flags, "account");
    const base = target(input);
    const now = new Date();

    const read = async (account: string | undefined) => {
      const periods: (Period & { calendar: string })[] = [];
      let cursor: string | undefined;
      let resolved: Resolved;
      do {
        const page = await call<FreeBusyPage>(input, "read_free_busy", { application_id: base.application_id, ...(account ? { account_id: account } : {}), tzid: window.tz, from: window.from, to: window.to, ...(list(flags, "calendar").length ? { calendar_ids: list(flags, "calendar") } : {}), limit: 200, ...(cursor ? { cursor } : {}) });
        resolved = page.resolved;
        for (const p of page.result.free_busy) {
          if (p.free_busy_status === "free") continue;
          // A whole-day period has days, not instants: it covers them in the command's zone.
          const start = DAY.test(p.start) ? window.startOf(p.start) : Date.parse(p.start);
          const end = DAY.test(p.end) ? window.startOf(p.end) : Date.parse(p.end);
          if (end > start) periods.push({ start, end, tentative: p.free_busy_status === "tentative", calendar: p.calendar_id });
        }
        cursor = page.result.next_cursor;
      } while (cursor && periods.length < MAX_PERIODS);
      return { periods, resolved };
    };

    const answers = accounts.length ? await Promise.all(accounts.map((a) => read(a))) : [await read(undefined)];
    const ids = answers.map((a) => a.resolved.account_id ?? "");
    const all = answers.flatMap((a) => a.periods);
    const fromDay = /^\d{4}-\d{2}-\d{2}$/.test(window.from) ? window.from : wallOf(new Date(window.from), window.tz).day;
    const toDay = /^\d{4}-\d{2}-\d{2}$/.test(window.to) ? window.to : addDays(wallOf(new Date(Date.parse(window.to) - 1), window.tz).day, 1);
    const days = daysOf(fromDay, toDay, window.tz, window.startOf);
    const view = { from: window.fromLabel, to: window.toLabel, tz: window.tz, now };
    const iso = (t: number) => isoInZone(new Date(t), window.tz);

    if (!on(flags, "free")) {
      if (str(flags, "duration") !== undefined || str(flags, "within") !== undefined) throw new Failure({ code: "bad_flag", message: "--duration and --within go with --free", exit: EXIT.usage, fix: [`calmonkey ${[...input.argv, "--free"].join(" ")}`] });
      const calendars = new Set(all.map((p) => p.calendar));
      if (on(flags, "by-calendar")) {
        const sections = [...calendars].map((calendar) => busyText({ busy: all.filter((p) => p.calendar === calendar).sort((a, b) => a.start - b.start), days, resolved: answers[0]!.resolved, accounts: ids, calendars: 1, ...view, hints: false }).replace(/^busy/, `calendar ${calendar.slice(0, 12)}: busy`));
        emit(input, () => (sections.length ? sections.join("\n") : busyText({ busy: [], days, resolved: answers[0]!.resolved, accounts: ids, calendars: 0, ...view, hints: false })), () => ({ busy: all.sort((a, b) => a.start - b.start).map((p) => ({ start: iso(p.start), end: iso(p.end), calendar_id: p.calendar, ...(p.tentative ? { status: "tentative" } : {}) })), account_ids: ids, from: view.from, to: view.to, tz: view.tz, merged: false }));
        return EXIT.ok;
      }
      const busy = merge(all);
      emit(
        input,
        () => busyText({ busy, days, resolved: answers[0]!.resolved, accounts: ids, calendars: Math.max(1, calendars.size), ...view, hints: hints(input) }),
        () => ({ busy: busy.map((p) => ({ start: iso(p.start), end: iso(p.end), ...(p.tentative ? { status: "tentative" } : {}) })), ...(ids.length === 1 ? { account_id: ids[0] } : { account_ids: ids }), from: view.from, to: view.to, tz: view.tz, merged: true }),
      );
      return EXIT.ok;
    }

    const minutes = parseDuration(str(flags, "duration") ?? "30m");
    if (!minutes) throw new Failure({ code: "bad_flag", message: "--duration is a length such as 30m, 45m, 1h or 1h30m", exit: EXIT.usage });
    const withinRaw = str(flags, "within") ?? "09:00-17:00";
    const within = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(withinRaw);
    const [h1, m1, h2, m2] = within ? within.slice(1).map(Number) : [];
    if (!within || h1! > 23 || m1! > 59 || h2! > 24 || m2! > 59 || h2! * 60 + m2! <= h1! * 60 + m1!) throw new Failure({ code: "bad_flag", message: "--within is the hours of a day to look in: --within 09:00-17:00", exit: EXIT.usage });
    const at = (day: string, h: number, m: number): number => {
      if (h === 24) return window.startOf(addDays(day, 1));
      const found = localToInstant(day, h, m, window.tz);
      return "missing" in found ? window.startOf(addDays(day, 1)) : found.instant.getTime();
    };
    const busy = merge(all);
    const free: Period[] = [];
    for (const d of days) {
      // Nothing in the past is offered, and nothing outside what was asked for.
      let cursor = Math.max(at(d.day, h1!, m1!), now.getTime(), DAY.test(window.from) ? 0 : Date.parse(window.from));
      const stop = Math.min(at(d.day, h2!, m2!), DAY.test(window.to) ? Infinity : Date.parse(window.to));
      // Round up to a whole five minutes when "now" is what cut the start.
      cursor = Math.ceil(cursor / 300_000) * 300_000;
      for (const p of busy) {
        if (p.end <= cursor) continue;
        if (p.start >= stop) break;
        if (p.start - cursor >= minutes * 60_000) free.push({ start: cursor, end: p.start, tentative: false });
        cursor = Math.max(cursor, p.end);
      }
      if (stop - cursor >= minutes * 60_000) free.push({ start: cursor, end: stop, tentative: false });
    }
    emit(
      input,
      () => freeText({ free, days, accounts: ids, minutes, within: withinRaw, ...view }),
      () => ({ free: free.map((p) => ({ start: iso(p.start), end: iso(p.end) })), ...(free[0] ? { first: { start: iso(free[0].start), end: iso(free[0].start + minutes * 60_000) } } : {}), account_ids: ids, duration: durationLabel(minutes), within: withinRaw, from: view.from, to: view.to, tz: view.tz, tentative_counts_as_busy: true }),
    );
    return EXIT.ok;
  },
};

export const FREEBUSY_COMMANDS: Command[] = [freebusyCommand];
