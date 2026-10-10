# Differences in every mode

What CalMonkey does differently from what existing integrations expect, whether or not an application has compatibility mode on.

> Made from the CalMonkey documentation (https://calmonkey.com/docs/compatibility.md). Changes go to the documentation, not to this file.

<a id="compatibility-differences"></a>

## Differences in every mode

- **Callback URLs** must be https on port 443 and on a public host. A test-mode application may also register `http://localhost…` for [webhooks on your own machine](https://calmonkey.com/docs/ai.md#listen).
- **Channels** have no `scheduling_conversations` key.
- **Profiles** carry two added keys, which existing clients ignore: `profile_calendars` (each profile’s calendars, so one call is enough) and `profile_relink_url` (always null: a profile is reconnected through `/oauth/authorize`).
- **Events** always carry `event_private` (false), `extended_transparency` (the same as `transparency`), `organizer`, and `url` when one was written. **Calendars** carry `calendar_attachments_available` (false). **Profiles** carry `provider_service`.
- **Attendees.** `notify_attendees` (on writes and deletes) is CalMonkey’s own field. With `notify_attendees: false` an application calendar stores guests; taking guests off with `remove` alone is always accepted. A body with a mistake in it answers with the mistake first, and with the calendar’s refusal once the body is valid.
- **Recurring events.** The event’s start must itself be an occurrence of the rule (a rule for Tuesdays needs a start on a Tuesday, in the event’s time zone). A monthly rule without `by_day` starts on the 1st to the 28th, a yearly one on any date but 29 February. `count` goes up to 730 and `interval` to 99. `start` and `end` are also accepted as `{ time, tzid }` objects.
- **Single occurrences.** `recurrence.exceptions.change`, `DELETE` with `occurrence_date` and `POST /v1/calendars/{id}/events/occurrences` are CalMonkey’s own, and every occurrence carries an added `occurrence_date`. Other keys under `exceptions` (`exclude` among them) are `errors.not_supported`.
- **Conferencing.** A made link reads `{ provider_name, join_url }`: `provider_name` is added. `profile_id: "default"` on a calendar without a link of its own (iCloud, application calendars) writes the event without one and reads show no `conferencing` key. `profile_id: "explicit"` is refused with `422` on `conferencing.profile_id`.
- **Wrong client credentials** are `400 {"error":"invalid_client"}` on `/oauth/*` and `401` with an empty body on `POST /v1/application_calendars`.
- **Webhooks** are retried for about 23 hours ([schedule](https://calmonkey.com/docs/errors.md#webhook-retries)); `410 Gone` closes the channel.
