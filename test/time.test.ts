import { describe, expect, it } from "vitest";
import { describeRule, occurrences, parseDays } from "../src/recurrence.js";
import { TimeError, isZone, isoInZone, localToInstant, offsetLabel, offsetMinutes, parseDuration, parseWhen, span, startOfDay, zoneLabel } from "../src/time.js";

const at = (iso: string) => new Date(iso);

describe("zones, with nothing but Intl", () => {
  it("knows a zone from a typo, and a zone's offset at an instant", () => {
    expect(isZone("Australia/Melbourne")).toBe(true);
    expect(isZone("Etc/UTC")).toBe(true);
    for (const bad of ["Melbourne/Australia", "", "AEST; rm -rf", "x".repeat(80)]) expect(isZone(bad), bad).toBe(false);
    expect(offsetLabel(offsetMinutes(at("2026-11-03T00:00:00Z"), "Australia/Melbourne"))).toBe("+11:00");
    expect(offsetLabel(offsetMinutes(at("2026-07-03T00:00:00Z"), "Australia/Melbourne"))).toBe("+10:00");
    expect(offsetLabel(offsetMinutes(at("2026-01-03T00:00:00Z"), "America/New_York"))).toBe("-05:00");
    expect(offsetLabel(offsetMinutes(at("2026-01-03T00:00:00Z"), "Asia/Kolkata"))).toBe("+05:30");
    expect(zoneLabel("Australia/Brisbane", at("2026-11-03T00:00:00Z"))).toBe("Australia/Brisbane (+10:00)");
  });

  it("turns a wall-clock time into the right instant, on both sides of the equator", () => {
    const melbourne = localToInstant("2026-11-03", 10, 0, "Australia/Melbourne");
    expect("instant" in melbourne && melbourne.instant.toISOString()).toBe("2026-11-02T23:00:00.000Z");
    const london = localToInstant("2026-07-01", 9, 30, "Europe/London");
    expect("instant" in london && london.instant.toISOString()).toBe("2026-07-01T08:30:00.000Z");
    expect(new Date(startOfDay("2026-11-03", "Australia/Melbourne")).toISOString()).toBe("2026-11-02T13:00:00.000Z");
  });

  it("refuses a time the clocks jump over, and names the first one after it", () => {
    // Melbourne, Sunday 4 October 2026: 02:00 becomes 03:00.
    expect(localToInstant("2026-10-04", 2, 30, "Australia/Melbourne")).toEqual({ missing: true, next: "2026-10-04T03:00" });
    expect(() => parseWhen("--start", "2026-10-04T02:30", "Australia/Melbourne")).toThrowError(/does not exist in Australia\/Melbourne/);
    try {
      parseWhen("--start", "2026-10-04T02:30", "Australia/Melbourne");
    } catch (error) {
      expect(error).toBeInstanceOf(TimeError);
      expect((error as TimeError).code).toBe("nonexistent_local_time");
      expect((error as TimeError).next).toBe("2026-10-04T03:00");
    }
    // Brisbane has no daylight saving: the same wall time exists there.
    expect("instant" in localToInstant("2026-10-04", 2, 30, "Australia/Brisbane")).toBe(true);
  });

  it("a time that happens twice is the first, and says so", () => {
    // Melbourne, Sunday 5 April 2026: 03:00 becomes 02:00 again.
    const twice = localToInstant("2026-04-05", 2, 30, "Australia/Melbourne");
    expect(twice).toMatchObject({ twice: true });
    expect("instant" in twice && twice.instant.toISOString()).toBe("2026-04-04T15:30:00.000Z");
    expect(localToInstant("2026-04-05", 12, 0, "Australia/Melbourne")).toMatchObject({ twice: false });
  });
});

describe("what a date or time on the command line may be", () => {
  const now = at("2026-10-09T01:00:00Z"); // Friday midday in Melbourne

  it("a date, a local time with a zone, a time with an offset; nothing looser", () => {
    expect(parseWhen("--start", "2026-11-03", undefined)).toEqual({ kind: "day", day: "2026-11-03" });
    expect(parseWhen("--start", "2026-11-03T10:00", "Australia/Melbourne")).toMatchObject({ kind: "instant", instant: at("2026-11-02T23:00:00Z"), local: "2026-11-03T10:00" });
    expect(parseWhen("--start", "2026-11-03T10:00:00+11:00", undefined)).toMatchObject({ instant: at("2026-11-02T23:00:00Z") });
    expect(parseWhen("--start", "2026-11-03T10:00:00Z", undefined)).toMatchObject({ instant: at("2026-11-03T10:00:00Z") });
    for (const bad of ["tomorrow", "3pm", "11/03/2026", "2026-13-01", "2026-02-30", "next tuesday", "2026-11-03T25:00"]) expect(() => parseWhen("--start", bad, "Australia/Melbourne"), bad).toThrowError(TimeError);
  });

  it("a local time without a zone is an error, never the machine's zone", () => {
    try {
      parseWhen("--start", "2026-11-03T10:00", undefined);
      expect.unreachable();
    } catch (error) {
      expect((error as TimeError).code).toBe("invalid_local_time");
      expect((error as TimeError).message).toBe("--start 2026-11-03T10:00 has no time zone, and CALMONKEY_TZ is not set");
    }
  });

  it("reads also take today, tomorrow and +7d, as days in the zone (not in UTC)", () => {
    const read = (v: string, tz = "Australia/Melbourne") => parseWhen("--from", v, tz, { relative: true, now });
    expect(read("today")).toEqual({ kind: "day", day: "2026-10-09" });
    expect(read("tomorrow")).toEqual({ kind: "day", day: "2026-10-10" });
    expect(read("+7d")).toEqual({ kind: "day", day: "2026-10-16" });
    expect(read("-2d")).toEqual({ kind: "day", day: "2026-10-07" });
    // 01:00 UTC on the 9th is still the 8th in Los Angeles.
    expect(read("today", "America/Los_Angeles")).toEqual({ kind: "day", day: "2026-10-08" });
    expect(() => parseWhen("--from", "today", undefined, { relative: true })).toThrowError(/needs a time zone/);
  });

  it("shows weekday, date and both ends; the offset travels with JSON", () => {
    expect(span("2026-10-11T21:00:00Z", "2026-10-11T21:30:00Z", "Australia/Melbourne")).toBe("Mon 2026-10-12 08:00-08:30");
    expect(span("2026-10-12T12:00:00Z", "2026-10-12T14:00:00Z", "Australia/Melbourne")).toBe("Mon 2026-10-12 23:00-01:00+1");
    expect(span("2026-11-03", "2026-11-04", "Australia/Melbourne")).toBe("Tue 2026-11-03 all day");
    expect(span("2026-11-03", "2026-11-06", "Australia/Melbourne")).toBe("Tue 2026-11-03..Thu 2026-11-05 all day");
    expect(isoInZone(at("2026-10-11T21:00:00Z"), "Australia/Melbourne")).toBe("2026-10-12T08:00:00+11:00");
    expect([parseDuration("30m"), parseDuration("45"), parseDuration("1h"), parseDuration("1h30m"), parseDuration("soon"), parseDuration("0m")]).toEqual([30, 45, 60, 90, null, null]);
  });
});

describe("repeating events", () => {
  it("works out the days of a rule, so the answer can name the last one", () => {
    expect(occurrences("2026-11-03", { frequency: "weekly", count: 10 }).days.at(-1)).toBe("2027-01-05");
    expect(occurrences("2026-11-03", { frequency: "weekly", count: 4, by_day: [{ day: "tuesday" }, { day: "thursday" }] }).days).toEqual(["2026-11-03", "2026-11-05", "2026-11-10", "2026-11-12"]);
    expect(occurrences("2026-11-03", { frequency: "weekly", interval: 2, until: "2026-12-02" }).days).toEqual(["2026-11-03", "2026-11-17", "2026-12-01"]);
    expect(occurrences("2026-01-31", { frequency: "monthly", count: 3 }).days).toEqual(["2026-01-31", "2026-03-31", "2026-05-31"]);
    expect(occurrences("2026-11-03", { frequency: "daily" })).toMatchObject({ open: true });
    expect(describeRule("2026-11-03", { frequency: "weekly", count: 10, by_day: [{ day: "tuesday" }] }, ["2026-11-17"])).toBe("weekly on Tue, 10 times, last Tue 2027-01-05; skipped: 2026-11-17");
    expect(parseDays("tue,THU")).toEqual([2, 4]);
    expect(parseDays("tuesday")).toEqual([2]);
    expect(parseDays("someday")).toBeNull();
  });
});
