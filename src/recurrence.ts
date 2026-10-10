import { WEEKDAYS, WEEKDAY_NAMES, addDays, weekdayIndex, weekdayOf } from "./time.js";

// A repeating event's days, worked out here so the answer to a write can say when the series
// ends and so a `--skip` or `--on` that fits no occurrence is refused before anything is sent
// (the API drops a skipped day the rule does not have, without a word).

export type Rule = { frequency: "daily" | "weekly" | "monthly" | "yearly"; interval?: number; count?: number; until?: string; by_day?: { day: string; nth_of_period?: number }[] };

const SHORT: Record<string, number> = Object.fromEntries([...WEEKDAYS.map((d, i) => [d.toLowerCase(), i] as const), ...WEEKDAY_NAMES.map((d, i) => [d, i] as const)]);

/** `tue,thu` / `tuesday` as weekday numbers (0 = Sunday); null for a word that is no day. */
export function parseDays(value: string): number[] | null {
  const out: number[] = [];
  for (const word of value.split(",").map((w) => w.trim().toLowerCase()).filter(Boolean)) {
    const n = SHORT[word] ?? SHORT[word.slice(0, 3)];
    if (n === undefined) return null;
    if (!out.includes(n)) out.push(n);
  }
  return out.length ? out.sort((a, b) => a - b) : null;
}

const MAX_LOOK = 5000;

/** The days a rule gives, from the first occurrence on: up to `max` of them. `open` when the rule has no end. */
export function occurrences(startDay: string, rule: Rule, max = 800): { days: string[]; open: boolean } {
  const interval = Math.max(1, rule.interval ?? 1);
  const limit = Math.min(max, rule.count ?? max);
  const days: string[] = [];
  const fits = (day: string) => !rule.until || day <= rule.until;
  if (rule.frequency === "daily") {
    for (let i = 0; days.length < limit && i < MAX_LOOK; i++) {
      const day = addDays(startDay, i * interval);
      if (!fits(day)) break;
      days.push(day);
    }
  } else if (rule.frequency === "weekly") {
    const wanted = rule.by_day?.length ? rule.by_day.map((d) => SHORT[d.day]!).filter((n) => n !== undefined) : [weekdayIndex(startDay)];
    const weekStart = addDays(startDay, -weekdayIndex(startDay));
    for (let week = 0; days.length < limit && week < MAX_LOOK; week += interval) {
      let stop = false;
      for (const n of [...wanted].sort((a, b) => a - b)) {
        const day = addDays(weekStart, week * 7 + n);
        if (day < startDay) continue;
        if (!fits(day)) {
          stop = true;
          break;
        }
        if (days.length < limit) days.push(day);
      }
      if (stop) break;
    }
  } else {
    const [y, m, d] = [Number(startDay.slice(0, 4)), Number(startDay.slice(5, 7)), Number(startDay.slice(8, 10))];
    for (let i = 0; days.length < limit && i < MAX_LOOK; i++) {
      const months = rule.frequency === "monthly" ? i * interval : i * interval * 12;
      const date = new Date(Date.UTC(y, m - 1 + months, d));
      // A month without that day (the 31st, 29 February) has no occurrence.
      if (date.getUTCDate() !== d) continue;
      const day = date.toISOString().slice(0, 10);
      if (!fits(day)) break;
      days.push(day);
    }
  }
  return { days, open: rule.count === undefined && rule.until === undefined };
}

/** "weekly on Tue, 10 times, last Tue 2027-01-05; skipped: 2026-11-17" */
export function describeRule(startDay: string, rule: Rule, skipped: string[] = []): string {
  const every = rule.interval && rule.interval > 1 ? `every ${rule.interval} ${{ daily: "days", weekly: "weeks", monthly: "months", yearly: "years" }[rule.frequency]}` : rule.frequency;
  const onDays = rule.frequency === "weekly" ? ` on ${(rule.by_day?.length ? rule.by_day.map((d) => WEEKDAYS[SHORT[d.day]!] ?? d.day) : [weekdayOf(startDay)]).join(", ")}` : "";
  const { days, open } = occurrences(startDay, rule);
  const last = days[days.length - 1];
  const length = open ? "no end date" : rule.count !== undefined ? `${rule.count} times${last ? `, last ${weekdayOf(last)} ${last}` : ""}` : `until ${rule.until}${last ? ` (${days.length} times, last ${weekdayOf(last)} ${last})` : ""}`;
  return `${every}${onDays}, ${length}${skipped.length ? `; skipped: ${skipped.join(", ")}` : ""}`;
}
