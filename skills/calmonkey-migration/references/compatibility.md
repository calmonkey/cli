# What is compatible, and compatibility mode

CalMonkey’s v1 API uses the paths, parameter names, response shapes, status codes and error shapes that many existing calendar integrations already call, for connecting calendars, free/busy, events with attendees, recurring events and conferencing, and push notifications. Such an integration usually switches with a change of hostnames and credentials, and its users reconnecting.

> Made from the CalMonkey documentation (https://calmonkey.com/docs/compatibility.md). Changes go to the documentation, not to this file.

<a id="compatibility-compatible"></a>

## What is compatible

These endpoints have the paths, parameters, response fields, status codes and error shapes that many existing calendar integrations already call. A client that uses only them switches by changing hostnames and credentials.

- `GET /oauth/authorize`
- `POST /oauth/token`
- `POST /oauth/token/revoke`
- `POST /v1/application_calendars`
- `GET /v1/account`
- `GET /v1/userinfo`
- `GET /v1/profiles`
- `GET /v1/calendars`
- `GET /v1/free_busy`
- `GET /v1/events`
- `POST /v1/calendars/{id}/events`
- `DELETE /v1/calendars/{id}/events`
- `POST /v1/calendars/{id}/events/occurrences`
- `POST /v1/channels`
- `GET /v1/channels`
- `DELETE /v1/channels/{id}`
- `POST /v1/link_tokens`

Provider names are `google`, `office365`, `live_connect` and `apple`. Every response also carries a `Calmonkey-Request-Id` header, and authenticated responses the `RateLimit-*` headers.

<a id="compatibility-events-fields"></a>

### Attendees, recurring events and conferencing

Event writes and reads take these fields and return these shapes:

- `attendees: { invite: [{ email, display_name }], remove: [{ email }] }` on writes; `attendees[]` with `email`, `display_name` and `status`, `organizer` and `participation_status` on reads. A wrong address is `errors.invalid_email` on `attendees.invite[0].email`.
- `recurrence: { rules: [{ frequency, interval, count | until, by_day: [{ day, nth_of_period }] }] }`, with one rule, a date-only `until` and these keys for what a rule cannot say: `errors.not_supported`, `errors.not_recognized`, `errors.must_be_date`, `errors.must_be_integer_greater_than_zero`, `errors.not_supported_count_until_combination`, `errors.max_recurrence_rules_exceeded`, `errors.invalid_format`. Leaving `recurrence` out keeps the series and `null` removes it. `exceptions.add` skips dates.
- `conferencing: { profile_id }` with `default`, `integrated` and `none`; reads show `{ pending: true }`, then the `join_url`.

<a id="compatibility-other-products"></a>

### Outside the compatible set

These have no counterpart on this API: availability-search and scheduling products, `conferencing.profile_id: "explicit"` with a join URL of your own, changing a participation status through the API, on-premises Exchange, and per-profile revoke (`POST /v1/profiles/{id}/revoke`). Revoke the whole grant with `/oauth/token/revoke` instead.

<a id="compatibility-mode"></a>

## Compatibility mode

Where CalMonkey’s own behaviour differs from what existing integrations expect, an application can ask for the behaviour they expect. Compatibility mode is a setting of each application, off by default. Turn it on for the application an existing client will use; leave it off for new integrations. You switch it in the application’s page in the dashboard.

| Behaviour | Compatibility on | Off (CalMonkey) |
| --- | --- | --- |
| All-day event written without transparency | transparent (free) | opaque (busy) |
| free_busy periods | event_uid only with include_ids=true | always event_uid |
| 422 wording | “\<field> must be specified”; errors.tzid_unrecognized “TZID not recognized”; errors.invalid_time_pair “end must be after start” | errors.required “required”; errors.invalid |
| POST /v1/application_calendars | no account_id; linking_profile.profile_name null; the same token pair again while it is valid | account_id; the calendar’s name; a new pair on every call |
| Refreshing a token | the same access token while it has at least 10 minutes left (expires_in = what is left) | a new access token |
| GET /v1/account for an application calendar | 403, plain text | 200 |
| GET /v1/userinfo | the type and data under the key names existing integrations read; an application calendar has application_calendar_id and no name or zoneinfo | calmonkey.type / calmonkey.data |
| Creating a channel | no signing_secret in the response | signing_secret, once |
| Webhook headers | a second HMAC header as well, under the name existing integrations verify | Calmonkey-\* headers only |
| Application calendars’ provider_name / provider_service | the name existing integrations expect | calmonkey |
| Reading a recurring event your application wrote | the first occurrence carries event_id and recurrence; later ones carry series_identifier and series_master, no event_id, and options.update false | every occurrence carries event_id, series_identifier and series_master; the first also recurrence |
| A timed recurring event written without tzid | accepted; it repeats at the same UTC time | 422 on tzid: a series repeats in local time and needs its zone |
| recurrence with an empty rules list | accepted: the event stops repeating | 422; send recurrence: null |
| attendees on a calendar that sends no invitations | errors.event.cannot_set_attendees | errors.attendees_unsupported |
| conferencing.profile_id integrated on a calendar without a link of its own | errors.integrated_conferencing_not_available | errors.conferencing_unavailable |
| An unknown conferencing.profile_id | errors.not_recognized | errors.invalid_value |

Webhook signatures: in compatibility mode a second header carries the same value as `Calmonkey-HMAC-SHA256` (base64 HMAC-SHA256 of the body, keyed with your client secret), under the header name existing integrations verify, so your existing verification keeps working once it uses the new client secret.
