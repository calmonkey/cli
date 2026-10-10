// CalMonkey quickstart in TypeScript: open an application calendar, list its calendar, write
// an event under your own event_id, read it back in free/busy, then delete it.
//
// An application calendar is hosted by CalMonkey and opened with your client credentials
// alone, so this needs no Google, Microsoft or Apple account and no browser.
//
//   CALMONKEY_CLIENT_ID      your application's client id          (required)
//   CALMONKEY_CLIENT_SECRET  your application's client secret      (required)
//   CALMONKEY_API_URL        the API host (default https://api.calmonkey.com)
//
// No dependencies. Run it with `npx tsx quickstart.ts` (Node 20 or later), or with
// `node quickstart.ts` on Node 22.18 or later. Load the credentials from your environment
// file, for example `npx tsx --env-file=.env.local quickstart.ts`.
//
// The secret and the tokens are never printed.

const API = (process.env.CALMONKEY_API_URL ?? "https://api.calmonkey.com").replace(/\/+$/, "");
const EVENT_ID = "skill-quickstart-ts";

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in your environment file.`);
  return value;
}

type TokenResponse = { access_token: string; refresh_token: string; expires_in: number; sub: string };
type Calendar = { calendar_id: string; calendar_name: string; calendar_readonly: boolean; calendar_primary: boolean };
type Period = { calendar_id: string; start: string; end: string; free_busy_status: "busy" | "tentative" | "free"; event_id?: string };

/** One call. Every answer has a Calmonkey-Request-Id header: quote it when something needs looking into. */
async function call(method: string, path: string, init: { token?: string; body?: unknown; expect: number }): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  console.log(`${method} ${path.split("?")[0]} -> ${res.status}`);
  if (res.status !== init.expect) {
    // A 422 says which fields are wrong: {"errors":{"<field>":[{"key","description"}]}}. A 401 has no body.
    const detail = res.status === 422 ? ` ${text}` : "";
    throw new Error(`Expected ${init.expect}, got ${res.status} (request ${res.headers.get("calmonkey-request-id") ?? "unknown"}).${detail}`);
  }
  return text ? JSON.parse(text) : null;
}

async function main(): Promise<void> {
  // 1. Open the application calendar. The same application_calendar_id always opens the same calendar.
  const tokens = (await call("POST", "/v1/application_calendars", {
    body: { client_id: need("CALMONKEY_CLIENT_ID"), client_secret: need("CALMONKEY_CLIENT_SECRET"), application_calendar_id: "skill-quickstart" },
    expect: 200,
  })) as TokenResponse;
  const token = tokens.access_token;
  console.log(`  account ${tokens.sub}, access token valid for ${tokens.expires_in} seconds`);

  // 2. List the calendars and take the one it has.
  const { calendars } = (await call("GET", "/v1/calendars", { token, expect: 200 })) as { calendars: Calendar[] };
  const calendar = calendars.find((c) => c.calendar_primary && !c.calendar_readonly) ?? calendars.find((c) => !c.calendar_readonly);
  if (!calendar) throw new Error("The account has no calendar that can be written to.");
  console.log(`  calendar ${calendar.calendar_id}`);

  // Reads cover 42 days back to 201 days ahead, so the event goes on tomorrow (UTC).
  const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
  const [tomorrow, dayAfter] = [day(1), day(2)];

  // 3. Write the event under your own event_id. The same call with the same id updates it.
  await call("POST", `/v1/calendars/${calendar.calendar_id}/events`, {
    token,
    body: {
      event_id: EVENT_ID,
      summary: "CalMonkey quickstart",
      description: "Written by quickstart.ts",
      start: `${tomorrow}T03:00:00Z`,
      end: `${tomorrow}T04:00:00Z`,
      tzid: "Australia/Melbourne",
    },
    expect: 202, // Accepted, with an empty body. The event can be read at once.
  });

  // 4. Read free/busy. include_managed=true: events your own application wrote are left out
  //    without it. include_ids=true adds your event_id to them.
  const query = new URLSearchParams({ tzid: "Etc/UTC", from: tomorrow, to: dayAfter, include_managed: "true", include_ids: "true" });
  const { free_busy } = (await call("GET", `/v1/free_busy?${query}`, { token, expect: 200 })) as { free_busy: Period[] };
  const mine = free_busy.find((p) => p.event_id === EVENT_ID);
  if (!mine) throw new Error("The event is not in free/busy.");
  console.log(`  ${mine.free_busy_status} from ${mine.start} to ${mine.end}`);

  // 5. Delete it again, by the same event_id.
  await call("DELETE", `/v1/calendars/${calendar.calendar_id}/events`, { token, body: { event_id: EVENT_ID }, expect: 202 });
  console.log("Done.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
