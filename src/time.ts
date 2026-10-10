// Dates, times and zones, with nothing but Intl (no dependency, no table of zones).
//
// The rules: a time without a zone is an error, never the
// machine's zone by default; a local time that does not exist (clocks forward) is refused; one
// that happens twice (clocks back) is the first; every answer shows weekday, local time, zone,
// offset and UTC, so a wrong day is visible at once.

export const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
export const WEEKDAY_NAMES = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"] as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const LOCAL = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;
const INSTANT = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) formatters.set(tz, (f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })));
  return f;
}

export function isZone(tz: string): boolean {
  if (!tz || tz.length > 64 || !/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** The zone this machine is set to. Only ever offered as a suggestion. */
export const machineZone = (): string => new Intl.DateTimeFormat().resolvedOptions().timeZone || "Etc/UTC";

export type Wall = { day: string; hour: number; minute: number; second: number };

/** The wall clock of an instant in a zone. */
export function wallOf(instant: Date, tz: string): Wall {
  const parts = Object.fromEntries(formatter(tz).formatToParts(instant).map((p) => [p.type, p.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

/** Minutes the zone is ahead of UTC at that instant. */
export function offsetMinutes(instant: Date, tz: string): number {
  const w = wallOf(instant, tz);
  const asUtc = Date.UTC(Number(w.day.slice(0, 4)), Number(w.day.slice(5, 7)) - 1, Number(w.day.slice(8, 10)), w.hour, w.minute, w.second);
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
}

export function offsetLabel(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

export const pad = (n: number) => String(n).padStart(2, "0");
export const clock = (w: Pick<Wall, "hour" | "minute">) => `${pad(w.hour)}:${pad(w.minute)}`;

export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const weekdayIndex = (day: string): number => new Date(`${day}T00:00:00Z`).getUTCDay();
export const weekdayOf = (day: string): string => WEEKDAYS[weekdayIndex(day)]!;

export const isDay = (value: string): boolean => DAY.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

export type LocalResult = { instant: Date; twice: boolean } | { missing: true; next: string };

/**
 * A wall-clock time in a zone as an instant. `missing`: the clocks jump over it (with the
 * first time after the jump); `twice`: it happens twice and this is the first.
 */
export function localToInstant(day: string, hour: number, minute: number, tz: string, second = 0): LocalResult {
  const wanted = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)), hour, minute, second);
  // The offsets in force around that wall time: try each, keep the instants that read back as it.
  const offsets = [...new Set([-36, -12, 0, 12, 36].map((h) => offsetMinutes(new Date(wanted + h * 3600_000), tz)))];
  const hits = offsets
    .map((off) => new Date(wanted - off * 60_000))
    .filter((candidate) => {
      const w = wallOf(candidate, tz);
      return w.day === day && w.hour === hour && w.minute === minute;
    })
    .sort((a, b) => a.getTime() - b.getTime());
  if (hits.length) return { instant: hits[0]!, twice: hits.length > 1 && hits[0]!.getTime() !== hits[hits.length - 1]!.getTime() };
  // In the gap: the first wall time after it is where the later offset begins.
  let after = wanted - Math.min(...offsets) * 60_000;
  const later = offsetMinutes(new Date(after), tz);
  for (let i = 0; i < 240 && offsetMinutes(new Date(after - 60_000), tz) === later; i++) after -= 60_000;
  const w = wallOf(new Date(after), tz);
  return { missing: true, next: `${w.day}T${clock(w)}` };
}

/** The instant a day begins in a zone (the first time after midnight where the clocks skip it). */
export function startOfDay(day: string, tz: string): number {
  const found = localToInstant(day, 0, 0, tz);
  if (!("missing" in found)) return found.instant.getTime();
  const next = localToInstant(found.next.slice(0, 10), Number(found.next.slice(11, 13)), Number(found.next.slice(14, 16)), tz);
  return "missing" in next ? Date.parse(`${day}T00:00:00Z`) : next.instant.getTime();
}

export type When =
  | { kind: "day"; day: string }
  | { kind: "instant"; instant: Date; twice?: boolean; local?: string };

export class TimeError extends Error {
  constructor(
    readonly code: "invalid_local_time" | "invalid_time" | "nonexistent_local_time" | "invalid_zone",
    message: string,
    readonly next?: string,
  ) {
    super(message);
    this.name = "TimeError";
  }
}

/**
 * A `--from` / `--start` value. Writes take a date, a local time (which needs `tz`) or a time
 * with an offset. Reads (`relative`) also take today, tomorrow, yesterday, +7d and -2d,
 * resolved in `tz`.
 */
export function parseWhen(flag: string, value: string, tz: string | undefined, opts: { relative?: boolean; now?: Date } = {}): When {
  const raw = value.trim();
  if (opts.relative) {
    const rel = /^(today|tomorrow|yesterday|[+-]\d{1,3}d)$/i.exec(raw)?.[1]?.toLowerCase();
    if (rel) {
      if (!tz) throw new TimeError("invalid_local_time", `${flag} ${raw} needs a time zone to know which day it is`);
      const today = wallOf(opts.now ?? new Date(), tz).day;
      const days = rel === "today" ? 0 : rel === "tomorrow" ? 1 : rel === "yesterday" ? -1 : Number(rel.slice(0, -1));
      return { kind: "day", day: addDays(today, days) };
    }
  }
  if (DAY.test(raw)) {
    if (!isDay(raw)) throw new TimeError("invalid_time", `${flag} ${raw} is not a date in the calendar`);
    return { kind: "day", day: raw };
  }
  const withOffset = INSTANT.exec(raw);
  if (withOffset) {
    const instant = new Date(raw.replace(" ", "T").replace(/([+-]\d{2})(\d{2})$/, "$1:$2"));
    if (Number.isNaN(instant.getTime())) throw new TimeError("invalid_time", `${flag} ${raw} is not a time`);
    return { kind: "instant", instant };
  }
  const local = LOCAL.exec(raw);
  if (local) {
    const [, day, hh, mm] = local as unknown as [string, string, string, string];
    if (!isDay(day) || Number(hh) > 23 || Number(mm) > 59) throw new TimeError("invalid_time", `${flag} ${raw} is not a time in the calendar`);
    if (!tz) throw new TimeError("invalid_local_time", `${flag} ${raw} has no time zone, and CALMONKEY_TZ is not set`);
    const found = localToInstant(day, Number(hh), Number(mm), tz);
    if ("missing" in found) throw new TimeError("nonexistent_local_time", `${flag} ${day}T${hh}:${mm} does not exist in ${tz}: the clocks go forward over it that day`, found.next);
    return { kind: "instant", instant: found.instant, twice: found.twice, local: `${day}T${hh}:${mm}` };
  }
  throw new TimeError("invalid_time", `${flag} ${raw.slice(0, 40)} is not a date or time. Use 2026-11-03, 2026-11-03T10:00 (with --tz) or 2026-11-03T10:00:00+11:00${opts.relative ? ", or today, tomorrow, +7d" : ""}`);
}

export const isoUtc = (instant: Date): string => instant.toISOString().replace(/\.\d{3}Z$/, "Z");
/** Short UTC, to the minute: 2026-10-15T03:00Z. */
export const utcMinute = (instant: Date): string => instant.toISOString().slice(0, 16) + "Z";

/** ISO 8601 with the zone's own offset: 2026-10-12T08:00:00+11:00. */
export function isoInZone(instant: Date, tz: string): string {
  const w = wallOf(instant, tz);
  return `${w.day}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${offsetLabel(offsetMinutes(instant, tz))}`;
}

/** "Mon 2026-10-12 08:00-08:30", "…23:00-01:00+1" over midnight, "… all day" for whole days. */
export function span(start: string, end: string, tz: string): string {
  if (DAY.test(start) && DAY.test(end)) {
    const last = addDays(end, -1);
    return last <= start ? `${weekdayOf(start)} ${start} all day` : `${weekdayOf(start)} ${start}..${weekdayOf(last)} ${last} all day`;
  }
  const a = wallOf(new Date(start), tz);
  const b = wallOf(new Date(end), tz);
  const days = Math.round((Date.parse(`${b.day}T00:00:00Z`) - Date.parse(`${a.day}T00:00:00Z`)) / 86_400_000);
  return `${weekdayOf(a.day)} ${a.day} ${clock(a)}-${clock(b)}${days > 0 ? `+${days}` : ""}`;
}

/** "Australia/Melbourne (+11:00)" at an instant. */
export const zoneLabel = (tz: string, at: Date): string => `${tz} (${offsetLabel(offsetMinutes(at, tz))})`;

/** A length such as 30m, 45, 1h, 1h30m, as minutes. */
export function parseDuration(value: string): number | null {
  const m = /^(?:(\d{1,3})h)?(?:(\d{1,4})m?)?$/.exec(value.trim().toLowerCase());
  if (!m || (!m[1] && !m[2])) return null;
  const minutes = Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
  return minutes > 0 && minutes <= 24 * 60 * 31 ? minutes : null;
}
