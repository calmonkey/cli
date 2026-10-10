# Errors and limits

What a failed request looks like, how fast you may call, how to trace a request, and what happens when your webhook endpoint is down.

> Made from the CalMonkey documentation (https://calmonkey.com/docs/errors.md, https://calmonkey.com/docs/api.md). Changes go to the documentation, not to this file.

## Contents

- [Error shapes](#errors-shapes)
- [401: refresh and retry once](#errors-unauthorized)
- [422: field errors](#errors-validation)
- [OAuth errors](#errors-oauth)
- [Rate limits](#errors-rate-limits)
- [Request ids and the request log](#errors-request-ids)
- [Webhook delivery and retries](#errors-webhook-retries)
- [422 keys of event writes](#api-event-errors)

<a id="errors-shapes"></a>

## Error shapes

The status code says what went wrong. Bodies follow the conventions existing calendar integrations already read, so those clients read them unchanged.

| Status | Body | When |
| --- | --- | --- |
| 400 | `{"error": "…"}` | OAuth endpoints only (`/oauth/token`, `/oauth/token/revoke`), including wrong client credentials. |
| 401 | empty, with `WWW-Authenticate` | The access token is missing, expired or revoked; or wrong client credentials on `/v1/application_calendars`. |
| 403 | empty | Writing to a read-only calendar. |
| 404 | empty | A calendar or channel the account does not have. Another customer’s id is “not found” too. (`DELETE /v1/channels/…` sends a small JSON body.) |
| 422 | `{"errors": {…}}` | The request is invalid; the body says which fields and why. |
| 429 | empty, with `Retry-After` | Rate limited ([below](#errors-rate-limits)). |
| 5xx | empty | Our fault. Retry with backoff; if it persists, write to [support@calmonkey.com](mailto:support@calmonkey.com) with the request id. |

<a id="errors-unauthorized"></a>

## 401: refresh and retry once

```http
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer realm="calmonkey", error="invalid_token", error_description="The access token is missing, invalid, expired or revoked."
Calmonkey-Request-Id: req_4b0d7c2e9f1a46d38b5e0c7a2f9d1e63
```

A request without a token says `error="invalid_request"`. On a 401, get a new access token with the refresh token and repeat the request once. If the refresh answers `invalid_grant`, the user revoked access or was disconnected: ask them to connect again.

<a id="errors-validation"></a>

## 422: field errors

GET /v1/free_busy without tzid, and with a bad from

```json
{
  "errors": {
    "tzid": [
      { "key": "errors.required", "description": "required" }
    ],
    "from": [
      {
        "key": "errors.invalid",
        "description": "must be a date (YYYY-MM-DD) or an ISO 8601 time with an offset, e.g. 2026-10-10T01:00:00Z"
      }
    ]
  }
}
```

Each field maps to a list of `{ key, description }`. Match on `key`; `description` is for people and may be reworded. Nested fields are written `location.description`, array items `calendar_ids[0]`, problems with the whole body `base`.

| Name | Type | Description |
| --- | --- | --- |
| `errors.required` | `key` | The field is missing. |
| `errors.invalid` | `key` | The value is not acceptable (a time, a time zone, end before start…). |
| `errors.invalid_type` | `key` | Wrong type, such as a number where a string belongs. |
| `errors.invalid_format` | `key` | Wrong format. |
| `errors.invalid_value` | `key` | Not one of the allowed values (e.g. `transparency`). |
| `errors.too_small / errors.too_big` | `key` | Too short or too long, or too many items. |
| `errors.invalid_json` | `key` | The body is not a JSON object (`base`). |
| `errors.invalid_callback_url` | `key` | The callback URL is not an https URL. |
| `errors.invalid_callback_url_blocked` | `key` | CalMonkey will not call that host: local, private or example addresses, or a port other than 443. (A test-mode application may register `http://localhost…`: see [Webhooks on your own machine](channels-and-webhooks.md#ai-listen).) |
| `errors.too_many_channels` | `key` | The account already has 100 open channels. |

Event writes have keys of their own for guests, repeating events and meeting links, such as `errors.invalid_email`, `errors.attendees_unsupported`, `errors.not_an_occurrence` and `errors.conferencing_unavailable`. They are listed in the [API reference](events.md#api-event-errors).

Applications in [compatibility mode](https://calmonkey.com/docs/compatibility.md#mode) get the wording existing integrations expect instead: `"tzid must be specified"`-style descriptions, `errors.tzid_unrecognized` for a missing or unknown `tzid`, and `errors.invalid_time_pair` when an event ends before it starts.

<a id="errors-oauth"></a>

## OAuth errors

400 Bad Request

```json
{ "error": "invalid_grant" }
```

| Name | Type | Description |
| --- | --- | --- |
| `invalid_client` | `error` | Unknown client id or wrong client secret (the two are not told apart). |
| `invalid_grant` | `error` | The code is used, expired or was issued for another redirect URI; or the refresh token is revoked or belongs to another application. |
| `invalid_request` | `error` | A required field is missing or the body cannot be read; `error_description` says which. |
| `unsupported_grant_type` | `error` | Only `authorization_code` and `refresh_token` are supported. |

On `/oauth/authorize` errors go back to your redirect URI as `error=` (`access_denied`, `unsupported_response_type`, `invalid_scope`), except an unknown client id or redirect URI, which shows an error page.

<a id="errors-rate-limits"></a>

## Rate limits

Two token buckets apply to every authenticated request. A request needs room in both.

| Bucket | Burst | Sustained |
| --- | --- | --- |
| Per application | 600 requests | 100 a second |
| Per authorised account (access token) | 150 requests | 25 a second |

Responses carry the state of the tighter bucket:

```http
RateLimit-Limit: 150
RateLimit-Remaining: 149
RateLimit-Reset: 1
```

`RateLimit-Reset` is the number of seconds until the bucket is full again. Over the limit the answer is `429` with an empty body and `Retry-After` (seconds): wait that long, then retry.

<a id="errors-request-ids"></a>

## Request ids and the request log

Every response has a `Calmonkey-Request-Id` header. Send your own in the request’s `Calmonkey-Request-Id` header (8 to 64 letters, digits, dots, dashes or underscores) and it comes back unchanged, which ties our logs to yours.

Authenticated API requests are kept in your request log in the dashboard for 30 days (7 days on the Developer plan): method, path, status, duration and the bodies, with tokens, credentials and event text replaced by `[redacted]`.

<a id="errors-webhook-retries"></a>

## Webhook delivery and retries

A notification counts as delivered when your callback URL answers with a 2xx status within 5 seconds. Redirects are not followed and count as failures. Anything else is retried:

| Attempt | When |
| --- | --- |
| 1 | Straight away (a change waits about a second, so changes close together share one notification) |
| 2 | 15 seconds after the first failure |
| 3 | 1 minute later |
| 4 | 5 minutes later |
| 5 | 15 minutes later |
| 6 | 1 hour later |
| 7 | 2 hours later |
| 8 | 4 hours later |
| 9 | 6 hours later |
| 10 | 10 hours later, the last attempt (about 23 hours after the first) |

- Each wait has up to 10% added at random, so a recovering endpoint is not hit by every waiting notification in the same second.
- After the tenth failed attempt, or 48 hours after the notification was created, the delivery is marked failed.
- `410 Gone` closes the channel: no more notifications are sent to it.
- Every attempt of one notification has the same `Calmonkey-Delivery-Id`, and `Calmonkey-Delivery-Attempt` counts up. Delivery is at least once: ignore an id you have already handled.
- Deliveries and their attempts are listed in the dashboard for 30 days.

<a id="api-event-errors"></a>

## 422 keys of event writes

Event writes answer `422` in the usual shape ([field errors](#errors-validation)). These are the keys of the guest, repeating-event and meeting-link fields; the field name is the path into your body, such as `attendees.invite[0].email` or `recurrence.rules[0].until`.

| Name | Type | Description |
| --- | --- | --- |
| `errors.invalid_format` | `attendees` | `attendees` is not an object with `invite` and / or `remove`. Also on `recurrence` that is not an object or null, and on a `by_day` entry that is not an object. |
| `errors.invalid_email` | `attendees.…email` | Not an email address. |
| `errors.required` | `any` | A guest without `email`; `conferencing` without `profile_id`; a changed occurrence with only one of `start` and `end`. |
| `errors.too_big` | `any` | Over a limit: more than 100 entries in `invite` or `remove`, an address over 254 or a name over 256 characters, `interval` over 99, `count` over 730, more than 64 entries in `exceptions.add` or `exceptions.change`. |
| `errors.too_many_attendees` | `attendees` | The event would have more than 100 guests. |
| `errors.attendees_unsupported` | `attendees` | Guests were added on a calendar that sends no invitations ([provider table](providers.md#providers-features)). On an application calendar, send `notify_attendees: false` to store them without telling anybody. |
| `errors.notify_attendees_unsupported` | `notify_attendees` | `notify_attendees: false` on an event with guests in a calendar that always tells them (Microsoft). |
| `errors.notify_attendees_cannot_change` | `notify_attendees` | A `notify_attendees` that is the opposite of how the event was first given guests, on an iCloud calendar. Leave it out, or delete the event and create it again. |
| `errors.invalid_value` | `conferencing.profile_id` | Not `default`, `integrated` or `none`. |
| `errors.conferencing_unavailable` | `conferencing.profile_id` | `integrated` on a calendar that adds no meeting link of its own. |
| `errors.max_recurrence_rules_exceeded` | `recurrence.rules` | More than one rule. |
| `errors.too_small` | `recurrence.rules` | No rule. (To stop a series send `"recurrence": null`.) |
| `errors.not_recognized` | `…frequency` | Not `daily`, `weekly`, `monthly` or `yearly`. |
| `errors.not_supported` | `recurrence.…` | A field a rule does not have (`by_month_day`, `by_month`, `by_set_pos`, `week_start`…), a field of a `by_day` entry other than `day` and `nth_of_period`, or a list under `exceptions` other than `add` and `change`. Nothing in a rule is ever dropped silently. |
| `errors.must_be_integer_greater_than_zero` | `…interval, …count` | Not a whole number above zero. |
| `errors.must_be_date` | `…until` | Not a date (`YYYY-MM-DD`). |
| `errors.not_supported_count_until_combination` | `…until` | `count` and `until` together. |
| `errors.invalid` | `recurrence.…, tzid` | The rule does not fit the event: the start is not an occurrence of it (`…by_day`), `by_day` is wrong for the frequency, a monthly series starts on the 29th to 31st or a yearly one on 29 February (`…frequency`), `until` is before the start, a timed series has no `tzid`, or an exception’s `date` is not a date or is named twice. The description says which. |
| `errors.not_recurring` | `occurrence_date` | The event does not repeat. |
| `errors.not_an_occurrence` | `occurrence_date` | The series has no occurrence on that day. |

The body is checked first and the calendar second: a body with a mistake in it answers with the mistake, and a well-formed body the calendar cannot carry out answers with the calendar’s key. Nothing is written in either case.

<a id="every-422-key"></a>

## Every 422 key

Each key a `422` can carry, with the section above that says what it means. Match on these; the descriptions beside them in an answer are for people.

- `errors.required`: [422: field errors](#errors-validation), [422 keys of event writes](#api-event-errors)
- `errors.invalid`: [422: field errors](#errors-validation), [422 keys of event writes](#api-event-errors)
- `errors.invalid_type`: [422: field errors](#errors-validation)
- `errors.invalid_format`: [422: field errors](#errors-validation), [422 keys of event writes](#api-event-errors)
- `errors.invalid_value`: [422: field errors](#errors-validation), [422 keys of event writes](#api-event-errors)
- `errors.too_small`: [422: field errors](#errors-validation), [422 keys of event writes](#api-event-errors)
- `errors.too_big`: [422: field errors](#errors-validation), [422 keys of event writes](#api-event-errors)
- `errors.invalid_json`: [422: field errors](#errors-validation)
- `errors.invalid_callback_url`: [422: field errors](#errors-validation)
- `errors.invalid_callback_url_blocked`: [422: field errors](#errors-validation)
- `errors.too_many_channels`: [422: field errors](#errors-validation)
- `errors.invalid_email`: [422: field errors](#errors-validation), [422 keys of event writes](#api-event-errors)
- `errors.too_many_attendees`: [422 keys of event writes](#api-event-errors)
- `errors.attendees_unsupported`: [422: field errors](#errors-validation), [422 keys of event writes](#api-event-errors)
- `errors.notify_attendees_unsupported`: [422 keys of event writes](#api-event-errors)
- `errors.conferencing_unavailable`: [422: field errors](#errors-validation), [422 keys of event writes](#api-event-errors)
- `errors.max_recurrence_rules_exceeded`: [422 keys of event writes](#api-event-errors)
- `errors.not_recognized`: [422 keys of event writes](#api-event-errors)
- `errors.not_supported`: [422 keys of event writes](#api-event-errors)
- `errors.must_be_integer_greater_than_zero`: [422 keys of event writes](#api-event-errors)
- `errors.must_be_date`: [422 keys of event writes](#api-event-errors)
- `errors.not_supported_count_until_combination`: [422 keys of event writes](#api-event-errors)
- `errors.not_recurring`: [422 keys of event writes](#api-event-errors)
- `errors.not_an_occurrence`: [422: field errors](#errors-validation), [422 keys of event writes](#api-event-errors)

Applications in compatibility mode get these keys in place of some of the above: `errors.tzid_unrecognized`, `errors.invalid_time_pair`, `errors.event.cannot_set_attendees`, `errors.integrated_conferencing_not_available`. See https://calmonkey.com/docs/compatibility.md.
