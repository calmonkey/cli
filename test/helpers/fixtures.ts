import type { ToolEvent } from "../../src/render.js";

// The calendar the output contract was measured on: a working
// week in Melbourne with 57 events, of which lists show 20. Made by rule, so every run is the same.

const TITLES = ["Stand-up", "School pickup", "Sprint planning", "Lash lift with Grace", "Customer demo – Playcorp", "1:1 Sam / Chris", "Design review: booking flow", "Dentist", "Lunch with Mia", "Quarterly numbers", "Interview: senior engineer", "Deploy window"];
const hex = (n: number) => (0x4205a75c + n * 0x9e3779b1).toString(16).padStart(8, "0").slice(-8);

export const ACCOUNT = "acc_38da51e7b1345bb5fae3656a";
export const CALENDAR = "cal_89645320138ae1ac547189a1";
export const RESOLVED = { application: { application_id: "0".repeat(24), client_id: "client1", name: "booking-app (dev)", mode: "test" as const }, account_id: ACCOUNT, calendar_id: CALENDAR };

export function event(i: number): ToolEvent {
  const day = 12 + Math.floor(i / 12);
  // 08:00 Melbourne (+11:00) is 21:00 UTC the day before.
  const start = new Date(Date.UTC(2026, 9, day - 1, 21, 0) + (i % 12) * 45 * 60_000);
  const ours = i % 3 === 1;
  return {
    calendar_id: CALENDAR,
    event_uid: `evt_${"0".repeat(16)}${hex(i)}`,
    ...(ours ? { event_id: `booking-${1041 + i}` } : {}),
    summary: { untrusted_text: TITLES[i % TITLES.length]! },
    ...(i % 4 === 0 ? { description: { untrusted_text: "Agenda and notes" } } : {}),
    start: start.toISOString().replace(".000Z", "Z"),
    end: new Date(start.getTime() + 30 * 60_000).toISOString().replace(".000Z", "Z"),
    status: i % 9 === 8 ? "tentative" : "confirmed",
    transparency: "opaque",
    participation_status: "accepted",
    deleted: false,
    recurring: i % 5 === 0,
    ...(i % 4 === 0 ? { guests: [{ email: { untrusted_text: "grace@example.com" }, status: "accepted" }, { email: { untrusted_text: "sam@example.org" }, status: "needs_action" }] } : {}),
    updated: "2026-10-08T05:42:51Z",
  };
}

export const EVENTS = Array.from({ length: 20 }, (_, i) => event(i));

/** The event of §3.2: somebody else's, with guests, a link and a description. */
export const DESIGN_REVIEW: ToolEvent = {
  calendar_id: CALENDAR,
  event_uid: "evt_a1c09d3e5f7b2a686ebb4744",
  summary: { untrusted_text: "Design review: booking flow" },
  description: { untrusted_text: "Agenda:\n1. New month view\n2. Held requests\n3. Open questions from last week's test round. Please read the doc before the meeting." },
  location: { untrusted_text: "12 Harbour St, Melbourne VIC 3000" },
  start: "2026-10-15T03:00:00Z",
  end: "2026-10-15T03:30:00Z",
  status: "confirmed",
  transparency: "opaque",
  participation_status: "accepted",
  deleted: false,
  recurring: false,
  organizer: { email: { untrusted_text: "chris@example.com" }, display_name: { untrusted_text: "Chris Mosely" } },
  guests: [
    { email: { untrusted_text: "grace@example.com" }, display_name: { untrusted_text: "Grace Park" }, status: "accepted" },
    { email: { untrusted_text: "sam.oduya@example.org" }, display_name: { untrusted_text: "Sam Oduya" }, status: "needs_action" },
    { email: { untrusted_text: "mia@fabu.example" }, status: "tentative" },
  ],
  meeting_link: { provider_name: "google_meet", join_url: { untrusted_text: "https://meet.google.com/abc-defg-hij" } },
  updated: "2026-10-08T05:42:51Z",
};

/** Three busy periods a day for fourteen days: the fullest a default free/busy answer gets in the budget's terms. */
export function busyPeriods(days = 14): { calendar_id: string; start: string; end: string; free_busy_status: string }[] {
  const out = [];
  for (let d = 0; d < days; d++) {
    for (const [h, len, status] of [[21, 120, "busy"], [24, 45, "busy"], [27.5, 60, d % 3 === 2 ? "tentative" : "busy"]] as const) {
      const start = new Date(Date.UTC(2026, 9, 11 + d, 0, 0) + h * 3600_000);
      out.push({ calendar_id: CALENDAR, start: start.toISOString().replace(".000Z", "Z"), end: new Date(start.getTime() + len * 60_000).toISOString().replace(".000Z", "Z"), free_busy_status: status });
    }
  }
  return out;
}
