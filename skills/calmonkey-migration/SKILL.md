---
name: calmonkey-migration
description: "Move an existing calendar API integration to CalMonkey: an integration whose code calls /oauth/authorize, /oauth/token, /v1/calendars, /v1/free_busy, /v1/events and /v1/channels, reads its client id, client secret and API and site hosts from settings, and verifies webhooks with an HMAC header keyed with the client secret. Use when the user wants to switch such an integration to, try or compare it with CalMonkey, or asks what differs, for calendar sync, free/busy, events and push notifications."
license: MIT
metadata:
  author: CalMonkey
  documentation: https://calmonkey.com/docs/compatibility
---

# Moving an existing integration to CalMonkey

CalMonkey's v1 API uses the paths, parameter names, response shapes, status codes and error shapes that many existing calendar integrations already call, for connecting calendars, free/busy, events with attendees, recurring events and conferencing, and push notifications. Such an integration usually switches with a change of hostnames and credentials, and its users reconnecting.

## Before changing anything

1. **Find what the project uses.** Search for the calendar API's client library, the settings that hold its client id, client secret and hosts, the hosts themselves, and the webhook signature check. List every endpoint the code calls.
2. **Compare that list** with the compatible endpoints in [references/compatibility.md](references/compatibility.md). The same file names what has no counterpart on this API. If the project depends on one of those, say so before going further.
3. **Read [references/differences.md](references/differences.md)** against the code: the callback URL rule, the start of a recurring event, and what a test asserts about error wording are the usual places.

## The switch

1. Create an application
2. Register your redirect URIs
3. Point your client at CalMonkey
4. Check webhook verification
5. Move your users
6. Test first

Each step in full: [references/switching.md](references/switching.md).

When the client reads its hosts from settings, the change is four values (under the names the code already reads):

```sh
CALENDAR_CLIENT_ID=<your CalMonkey client id>
CALENDAR_CLIENT_SECRET=<your CalMonkey client secret>
CALENDAR_API_HOST=https://api.calmonkey.com
CALENDAR_SITE_HOST=https://app.calmonkey.com
```

| Setting | Becomes |
| --- | --- |
| The client id | The CalMonkey application's client id |
| The client secret | The CalMonkey application's client secret |
| The API host | `https://api.calmonkey.com` |
| The site host (for `/oauth/authorize`) | `https://app.calmonkey.com` |

The client secret is shown once, in the dashboard: the person puts it into the environment file themselves. Never ask for it in the conversation, and never print it.

## Rules that decide whether the switch works

- **Turn on compatibility mode** for the application the existing client will use. It is a setting of each application, off by default, on the application's page in the dashboard. With it on, the application gets the behaviour existing integrations expect where CalMonkey's own differs: the table is in [references/compatibility.md](references/compatibility.md).
- **Webhook verification keeps working.** In compatibility mode notifications also carry a second HMAC header under the name existing integrations verify, with the same value as `Calmonkey-HMAC-SHA256` (base64 HMAC-SHA256 of the body, keyed with the client secret), so the existing check passes once it uses the new client secret.
- **Callback URLs must be https on port 443 on a public host.**
- **Hostname checks.** If the code checks that callback or API URLs end in the old provider's domain, change that check to compare with the CalMonkey hosts exactly.
- **Tokens cannot be carried over.** Each user connects their calendar again through CalMonkey. Before switching a connection, delete the events written through the old service, close its channels and revoke its token there; when the user has reconnected, write their upcoming events again (writes are idempotent by `event_id`).
- **There is no choice of data centre**, so there is none in the hostnames: one API host and one app host.
- **Test first** with an application calendar, which needs no browser, then with one real account per provider the product offers.

## Where to look

| Task | Read |
| --- | --- |
| Which endpoints and fields are compatible, what is outside the set, and what compatibility mode changes | [references/compatibility.md](references/compatibility.md) |
| What differs in every mode | [references/differences.md](references/differences.md) |
| The steps, in order, with the settings | [references/switching.md](references/switching.md) |
| A list to tick off, for the code and for the roll-out | [references/checklist.md](references/checklist.md) |

For the API itself (events, free/busy, webhooks, errors) use the `calmonkey-api` skill, or the documentation: https://calmonkey.com/llms.txt.
