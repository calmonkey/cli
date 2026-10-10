# API reference: where each part is

Every endpoint of the v1 API. Field names and shapes are the ones existing calendar integrations already use; the few additions are listed under [Compatibility and migrating](https://calmonkey.com/docs/compatibility.md). Examples use made-up ids in the real formats.

> Made from the CalMonkey documentation (https://calmonkey.com/docs/api.md). Changes go to the documentation, not to this file.

| Section | File |
| --- | --- |
| Basics | [overview.md](overview.md#api-basics) |
| `GET /oauth/authorize` | [connect-and-tokens.md](connect-and-tokens.md#api-authorize) |
| `POST /oauth/token` | [connect-and-tokens.md](connect-and-tokens.md#api-token) |
| `POST /oauth/token/revoke` | [connect-and-tokens.md](connect-and-tokens.md#api-revoke) |
| `POST /v1/application_calendars` | [application-calendars.md](application-calendars.md#api-application-calendars) |
| `GET /v1/account` | [connect-and-tokens.md](connect-and-tokens.md#api-account) |
| `GET /v1/userinfo` | [connect-and-tokens.md](connect-and-tokens.md#api-userinfo) |
| `GET /v1/profiles` | [connect-and-tokens.md](connect-and-tokens.md#api-profiles) |
| `GET /v1/calendars` | [connect-and-tokens.md](connect-and-tokens.md#api-calendars) |
| `GET /v1/free_busy` | [free-busy.md](free-busy.md#api-free-busy) |
| `GET /v1/events` | [events.md](events.md#api-events-read) |
| `POST /v1/calendars/{calendar_id}/events` | [events.md](events.md#api-events-upsert) |
| Guests | [events.md](events.md#api-guests) |
| Repeating events | [events.md](events.md#api-recurrence) |
| Meeting links | [events.md](events.md#api-conferencing) |
| `DELETE /v1/calendars/{calendar_id}/events` | [events.md](events.md#api-events-delete) |
| `POST /v1/calendars/{calendar_id}/events/occurrences` | [events.md](events.md#api-events-occurrences) |
| 422 keys of event writes | [events.md](events.md#api-event-errors) |
| `POST /v1/channels` | [channels-and-webhooks.md](channels-and-webhooks.md#api-channels-create) |
| `GET /v1/channels` | [channels-and-webhooks.md](channels-and-webhooks.md#api-channels-list) |
| `DELETE /v1/channels/{channel_id}` | [channels-and-webhooks.md](channels-and-webhooks.md#api-channels-close) |
| `POST /v1/link_tokens` | [connect-and-tokens.md](connect-and-tokens.md#api-link-tokens) |
| Notifications | [channels-and-webhooks.md](channels-and-webhooks.md#api-notifications) |

Every request and response shape as a schema (OpenAPI 3.1): https://calmonkey.com/openapi.json.
