# Overview: hosts, concepts and conventions

CalMonkey gives your product one API for your users’ Google Calendar, Microsoft 365, Outlook.com and Apple iCloud calendars. Your users connect on a hosted page, and your server reads free/busy and events, writes events (with guests, repeats and meeting links) and gets told about changes. New here? Go to the [quickstart](quickstart.md). Working with an AI coding assistant? Start with `npx calmonkey init`: see [AI coding tools](ai-tools.md).

> Made from the CalMonkey documentation (https://calmonkey.com/docs.md, https://calmonkey.com/docs/api.md). Changes go to the documentation, not to this file.

## Contents

- [Hostnames](#overview-hosts)
- [How the pieces fit](#overview-concepts)
- [Conventions](#overview-conventions)
- [Basics](#api-basics)

<a id="overview-hosts"></a>

## Hostnames

CalMonkey answers on two hostnames. Every example in these pages uses them as they are.

| Host | What is there |
| --- | --- |
| `https://api.calmonkey.com` | The API: `/oauth/token`, `/oauth/token/revoke` and everything under `/v1`. Your server calls it. |
| `https://app.calmonkey.com` | What people see in a browser: `/oauth/authorize` and the hosted connect pages your users go through, and the dashboard at `/dashboard` where you manage your applications. |

If you are moving an existing integration over, the API host takes the place of your current API host and the app host the place of the host your code sends people to for `/oauth/authorize`. See [Compatibility and migrating](https://calmonkey.com/docs/compatibility.md).

<a id="overview-concepts"></a>

## How the pieces fit

- **Application**: Your product, as CalMonkey knows it. It has a client id, a client secret and the redirect URIs your users may be sent back to. You create applications in the [dashboard](https://app.calmonkey.com/dashboard) (sign in at [app.calmonkey.com/sign-in](https://app.calmonkey.com/sign-in)). The client secret is shown once, when it is created or rotated: store it in your secret manager.
- **Account**: One of your users (`acc_…`). Your application gets an account, with an access token and a refresh token, when a user connects a calendar through the hosted connect page. Its id comes back as `sub`.
- **Profile**: One calendar account the user connected (`pro_…`): a Google account, a Microsoft 365 or Outlook.com mailbox, or an Apple ID. An account can have several.
- **Calendar**: A calendar of a profile (`cal_…`). You read free/busy and events from calendars and write events to the ones that are not read-only.
- **Event**: Something in a calendar. Your application writes events under its own `event_id`: a single event or a [repeating](events.md#api-recurrence) one, with [guests](events.md#api-guests) the calendar invites for you and a [meeting link](events.md#api-conferencing) the calendar adds. Reads return every event in the calendar, with its guests and their replies.
- **Application calendar**: A calendar CalMonkey hosts itself (`apc_…` accounts), opened with your client credentials alone. Use them for tests and demos, or for people who have no calendar to connect.
- **Channel**: A webhook subscription (`chn_…`): CalMonkey sends a signed notification to your callback URL when something changes in an account’s calendars.

<a id="overview-conventions"></a>

## Conventions

- Requests and responses are JSON. Field names are snake_case, and the ones existing calendar integrations already use (see [Compatibility and migrating](https://calmonkey.com/docs/compatibility.md)).
- `/v1` endpoints take `Authorization: Bearer <access_token>`. Access tokens last 3 hours; refresh them with the refresh token, which does not change.
- Times are ISO 8601 with an offset, returned in UTC unless you ask for local times. All-day events are dates, and their end date is exclusive.
- Every response carries a `Calmonkey-Request-Id` header. Quote it when you write to [support@calmonkey.com](mailto:support@calmonkey.com).
- Event writes answer `202 Accepted` with an empty body. The event shows in free/busy and event reads straight away; the write to Google, Microsoft or iCloud follows in the background.

<a id="api-basics"></a>

## Basics

- Base URL of the API: `https://api.calmonkey.com`. `/oauth/authorize` is on `https://app.calmonkey.com`, because a browser opens it.
- Bodies are JSON (`Content-Type: application/json`). The OAuth endpoints and `/v1/application_calendars` also take `application/x-www-form-urlencoded`.
- Booleans in query strings are `true`, `false`, `1` or `0`. Repeated parameters use brackets: `calendar_ids[]=a&calendar_ids[]=b`.
- Ids: accounts `acc_…` (application calendars `apc_…`), profiles `pro_…`, calendars `cal_…`, channels `chn_…`, events `evt_…`. Treat them as opaque strings.
- Errors and rate limits: [Errors and limits](errors.md).
