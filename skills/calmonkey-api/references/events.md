# Events: reading, writing, guests, repeating events and meeting links

Reading events, writing and deleting them by your own `event_id`, inviting guests, making an event repeat, changing or skipping one occurrence, and adding a meeting link.

> Made from the CalMonkey documentation (https://calmonkey.com/docs/api.md). Changes go to the documentation, not to this file.

## Contents

- [GET /v1/events](#api-events-read)
- [POST /v1/calendars/{calendar_id}/events](#api-events-upsert)
- [Guests](#api-guests)
- [Repeating events](#api-recurrence)
- [Meeting links](#api-conferencing)
- [DELETE /v1/calendars/{calendar_id}/events](#api-events-delete)
- [POST /v1/calendars/{calendar_id}/events/occurrences](#api-events-occurrences)
- [422 keys of event writes](#api-event-errors)

<a id="api-events-read"></a>

## GET /v1/events

**GET** `https://api.calmonkey.com/v1/events`

**Authentication:** `Authorization: Bearer <access_token>`

| Name | Type | Description |
| --- | --- | --- |
| `tzid` (required) | `string` | Time zone the request’s dates are read in, e.g. `Australia/Melbourne`. |
| `from` | `date or time` | Start, a day (`2026-11-03`) in `tzid` or a time with an offset. Defaults to 42 days ago. |
| `to` | `date or time` | End, exclusive. Defaults to 201 days from now. |
| `calendar_ids[]` | `string, repeatable` | Only these calendars (up to 100). Default: every calendar of the account. |
| `include_managed` | `boolean` | Include events your application created. Default `false`. |
| `only_managed` | `boolean` | Only the events your application created. |
| `include_deleted` | `boolean` | Include events deleted since they were cached (`deleted: true`). |
| `last_modified` | `time` | Only events changed at or after this time. Use a change notification’s `changes_since`. |
| `localized_times` | `boolean` | Times with the offset of `tzid` instead of UTC. |

200 OK

```json
{
  "pages": { "current": 1, "total": 1 },
  "events": [
    {
      "calendar_id": "cal_89645320138ae1ac547189a1",
      "event_uid": "evt_6a1f2c3d4e5b6a7c8d9e0f12",
      "event_id": "booking-1042",
      "summary": "Lash lift with Grace",
      "description": "Booked through Your App",
      "start": "2026-11-03T03:00:00Z",
      "end": "2026-11-03T04:00:00Z",
      "deleted": false,
      "created": "2026-10-20T01:12:09Z",
      "updated": "2026-10-20T01:12:09Z",
      "location": { "description": "12 Harbour St, Melbourne" },
      "url": "https://yourapp.example/bookings/1042",
      "participation_status": "accepted",
      "attendees": [],
      "transparency": "opaque",
      "extended_transparency": "opaque",
      "event_private": false,
      "organizer": null,
      "status": "confirmed",
      "categories": [],
      "recurring": false,
      "options": { "delete": true, "update": true, "change_participation_status": false }
    },
    {
      "calendar_id": "cal_89645320138ae1ac547189a1",
      "event_uid": "evt_0b9d4e7f2a1c3b5d6e8f9a01",
      "event_id": "consult-88",
      "summary": "Colour consultation",
      "description": "",
      "start": "2026-11-05T00:00:00Z",
      "end": "2026-11-05T00:30:00Z",
      "deleted": false,
      "created": "2026-10-20T01:15:40Z",
      "updated": "2026-10-21T22:03:11Z",
      "participation_status": "accepted",
      "attendees": [
        { "email": "grace@example.com", "display_name": "Grace Park", "status": "accepted" },
        { "email": "alex@example.com", "display_name": "Alex Rivera", "status": "needs_action" }
      ],
      "transparency": "opaque",
      "extended_transparency": "opaque",
      "event_private": false,
      "organizer": { "email": "dana@example.com", "display_name": "Dana Lee" },
      "status": "confirmed",
      "categories": [],
      "recurring": false,
      "conferencing": { "provider_name": "google_meet", "join_url": "https://meet.google.com/abc-defg-hij" },
      "options": { "delete": true, "update": true, "change_participation_status": false }
    },
    {
      "calendar_id": "cal_89645320138ae1ac547189a1",
      "event_uid": "evt_5c2e8a1f7b3d9e0a4c6f1b23",
      "event_id": "class-7",
      "summary": "Tuesday pilates",
      "description": "",
      "start": "2026-11-02T23:00:00Z",
      "end": "2026-11-03T00:00:00Z",
      "deleted": false,
      "created": "2026-10-20T01:20:02Z",
      "updated": "2026-10-20T01:20:02Z",
      "participation_status": "accepted",
      "attendees": [],
      "transparency": "opaque",
      "extended_transparency": "opaque",
      "event_private": false,
      "organizer": null,
      "status": "confirmed",
      "categories": [],
      "recurring": true,
      "recurrence": {
        "rules": [{ "frequency": "weekly", "count": 10, "by_day": [{ "day": "tuesday" }] }]
      },
      "series_identifier": "9f2c4b7e1a6d8035c2e4f6a8b0d1e3f5",
      "series_master": { "event_id": "class-7", "event_uid": "evt_5c2e8a1f7b3d9e0a4c6f1b23" },
      "occurrence_date": "2026-11-03",
      "options": { "delete": true, "update": true, "change_participation_status": false }
    }
  ]
}
```

- Up to 300 events per page; follow `pages.next_page`.
- `event_id` appears only on events your application created, and `options.update` / `options.delete` are true only for those.
- Cancelled events are not included.

| Name | Type | Description |
| --- | --- | --- |
| `attendees` | `object[]` | The guests: `email` (lower case), `display_name` (string or null) and `status`, their reply: `needs_action`, `accepted`, `declined`, `tentative` or `unknown`. Empty for an event without guests. |
| `organizer` | `object or null` | Who the event belongs to: `email` and `display_name` (string or null). Null when the calendar names nobody. |
| `participation_status` | `string` | The calendar owner’s own reply, with the same values as a guest’s `status`. An invitation they declined is returned with `declined`, and never counts as busy in `/v1/free_busy`. |
| `conferencing` | `object` | The event’s meeting link: `{ "provider_name": "…", "join_url": "…" }`, or `{ "pending": true }` from the moment you ask for one until the calendar has made it. `provider_name` is `google_meet`, `ms_teams`, `google_hangouts`, `skype_for_business`, `skype` or `other`. Left out when the event has no link. |
| `recurring` | `boolean` | True on every occurrence of a repeating event. A repeating event is returned as its occurrences, one event each. |
| `series_identifier` | `string` | On every occurrence of a repeating event: the same value for all occurrences of one series, and for nothing else. |
| `occurrence_date` | `date` | On every occurrence: its original day in the series’ time zone (`2026-11-24`). An occurrence that was moved keeps it. This is the day [DELETE](#api-events-delete) and [/events/occurrences](#api-events-occurrences) name an occurrence by. |
| `series_master` | `object` | On the occurrences of a series your application wrote: `event_id` (the id you wrote the series with) and `event_uid` of its first occurrence. |
| `recurrence` | `object` | On the first occurrence of a series your application wrote: `{ "rules": [ … ] }`, the rule as you sent it (`interval` is left out when it is 1). |

- Every occurrence of a series your application wrote carries your `event_id`, so `only_managed` and `include_managed` treat the whole series as yours. Tell the occurrences apart by `occurrence_date` or `event_uid`.
- Guests, organisers, replies and meeting links are returned for every event in the calendar, whoever created it. Events are read from 42 days back to 201 days ahead, and a series gives the occurrences inside that window.

<a id="api-events-upsert"></a>

## POST /v1/calendars/{calendar_id}/events

**POST** `https://api.calmonkey.com/v1/calendars/{calendar_id}/events`

**Authentication:** `Authorization: Bearer <access_token>`

Creates the event with this `event_id`, or replaces it. The same call invites [guests](#api-guests), makes the event [repeat](#api-recurrence) and adds a [meeting link](#api-conferencing).

| Name | Type | Description |
| --- | --- | --- |
| `event_id` (required) | `string` | Your id for the event, up to 512 characters. Unique per calendar and application. |
| `summary` (required) | `string` | Title, up to 2,000 characters. |
| `description` | `string` | Up to 50,000 characters. |
| `start` (required) | `string or object` | A time with an offset (`2026-11-03T03:00:00Z`), a date for an all-day event, or `{ "time": "…", "tzid": "…" }`. |
| `end` (required) | `string or object` | As start. A date when start is a date (exclusive), a time when start is a time, not before start. |
| `tzid` | `string` | The event's time zone, used by the provider to show it. |
| `location.description` | `string` | Up to 2,000 characters. |
| `url` | `string` | A link, returned on reads. Up to 2,048 characters. |
| `transparency` | `string` | `opaque` (busy, the default) or `transparent` (shown as free). |
| `attendees.invite` | `object[]` | Guests to add: `{ "email": "…", "display_name": "…" }`, the name optional. See [Guests](#api-guests). |
| `attendees.remove` | `object[]` | Guests to take off: `{ "email": "…" }`. |
| `notify_attendees` | `boolean` | Whether the calendar tells the guests about this write. Default `true`. |
| `recurrence` | `object or null` | How the event repeats: `rules` and `exceptions`. `null` stops it repeating. See [Repeating events](#api-recurrence). |
| `conferencing.profile_id` | `string` | `default`, `integrated` or `none`. See [Meeting links](#api-conferencing). |

Request body

```json
{
  "event_id": "booking-1042",
  "summary": "Lash lift with Grace",
  "description": "Booked through Your App",
  "start": "2026-11-03T03:00:00Z",
  "end": "2026-11-03T04:00:00Z",
  "tzid": "Australia/Melbourne",
  "location": { "description": "12 Harbour St, Melbourne" },
  "url": "https://yourapp.example/bookings/1042",
  "transparency": "opaque"
}
```

`202 Accepted`, empty body. Fields the API does not have (reminders, for example) are accepted and ignored. `404` for a calendar the account does not have, `403` for a read-only one, `422` for an invalid body or for something the calendar cannot do ([the keys](#api-event-errors)).

<a id="api-guests"></a>

## Guests

Add guests to an event with `attendees.invite`. The calendar’s own service sends each guest the invitation, sends an update when you change the event and a cancellation when you delete it, exactly as if the person had invited them from their calendar. Guests answer in their own calendar or mail, and the answers come back as each attendee’s `status` in [GET /v1/events](#api-events-read); a `change` notification tells you when one arrives.

Invite two guests and add a meeting link

```json
{
  "event_id": "consult-88",
  "summary": "Colour consultation",
  "start": "2026-11-05T00:00:00Z",
  "end": "2026-11-05T00:30:00Z",
  "tzid": "Australia/Melbourne",
  "attendees": {
    "invite": [
      { "email": "grace@example.com", "display_name": "Grace Park" },
      { "email": "sam@example.com" }
    ]
  },
  "conferencing": { "profile_id": "default" }
}
```

A later write: one guest added, one taken off

```json
{
  "event_id": "consult-88",
  "summary": "Colour consultation",
  "start": "2026-11-05T00:00:00Z",
  "end": "2026-11-05T00:30:00Z",
  "tzid": "Australia/Melbourne",
  "attendees": {
    "invite": [{ "email": "alex@example.com", "display_name": "Alex Rivera" }],
    "remove": [{ "email": "sam@example.com" }]
  }
}
```

- `attendees` describes a change, not the whole list. The event’s guests after the write are the guests it had, plus `invite`, minus `remove`. An address in both lists is removed. Inviting a guest again keeps them once; a `display_name` sent with it replaces the name.
- A write without `attendees` keeps the guests as they are, so you can move or rename an event without sending the list again. To take every guest off, name them in `remove`.
- `notify_attendees: false` makes the write without telling anybody: the guests are on the event and nobody is emailed. It also applies to [DELETE](#api-events-delete). Which calendars take it is in the [provider table](providers.md#providers-features). On an iCloud calendar it is decided once, when the event first gets guests: a later write or delete that leaves it out keeps the event as it is, and one that says the opposite answers `422` (`errors.notify_attendees_cannot_change`).
- Limits: 100 guests on an event, and 100 entries in each of `invite` and `remove`; an email address up to 254 characters, a name up to 256. Addresses are trimmed and compared in lower case, and one named twice counts once.
- A guest’s `status` is the answer the calendar holds, and your later writes keep it. Moving an event to another time can ask the guests again: Google sets them back to `needs_action` when the time changes, and iCloud when the time or the place does.
- A calendar can add a guest of its own: somebody who answers from another address than the one you invited, or who was forwarded the invitation. They appear in `attendees` with their answer, and your later writes keep them. To take one off, name the address in `remove`.
- The calendar’s owner is the event’s `organizer`.

<a id="api-recurrence"></a>

## Repeating events

`recurrence` makes the event a series. `start` and `end` are its first occurrence, and `rules` holds one rule that says how it repeats. `exceptions` skips occurrences (`add`) and gives single occurrences their own time or text (`change`).

Tuesdays at 10 am Melbourne time, ten times; one skipped, one moved to the afternoon

```json
{
  "event_id": "class-7",
  "summary": "Tuesday pilates",
  "start": "2026-11-02T23:00:00Z",
  "end": "2026-11-03T00:00:00Z",
  "tzid": "Australia/Melbourne",
  "recurrence": {
    "rules": [
      { "frequency": "weekly", "interval": 1, "count": 10, "by_day": [{ "day": "tuesday" }] }
    ],
    "exceptions": {
      "add": [{ "date": "2026-11-17" }],
      "change": [
        {
          "date": "2026-11-24",
          "start": "2026-11-24T03:00:00Z",
          "end": "2026-11-24T04:00:00Z",
          "summary": "Tuesday pilates (afternoon)"
        }
      ]
    }
  }
}
```

| Name | Type | Description |
| --- | --- | --- |
| `frequency` (required) | `string` | `daily`, `weekly`, `monthly` or `yearly`. |
| `interval` | `integer` | Every how many days, weeks, months or years: 1 to 99. Default 1. |
| `count` | `integer` | How many occurrences in all, the first included: 1 to 730. |
| `until` | `date` | The last day an occurrence may fall on (`2027-12-31`, inclusive, in the event’s time zone). Not together with `count`. With neither, the series has no end. |
| `by_day` | `object[]` | Weekly: the days of the week, `[{ "day": "tuesday" }, { "day": "thursday" }]`. Monthly: a day with its place in the month, `[{ "day": "monday", "nth_of_period": 1 }]` for the first Monday; `nth_of_period` is 1 to 4, or -1 for the last. |

All day on the first Monday of every month, until the end of 2027

```json
{
  "event_id": "stocktake",
  "summary": "Stocktake",
  "start": "2026-11-02",
  "end": "2026-11-03",
  "recurrence": {
    "rules": [
      { "frequency": "monthly", "until": "2027-12-31", "by_day": [{ "day": "monday", "nth_of_period": 1 }] }
    ]
  }
}
```

<a id="api-recurrence-rules"></a>

### How a rule is read

- The start is the first occurrence, so it has to fit the rule: a weekly rule for Tuesdays needs a start on a Tuesday. A weekly rule without `by_day` repeats on the start’s weekday.
- A monthly rule without `by_day` repeats on the start’s day of the month, and a yearly rule on the start’s date. Start a monthly series on the 1st to the 28th, and a yearly one on any date but 29 February; use `by_day` with `nth_of_period: -1` for “the last Friday of the month”.
- A series with a time needs `tzid`, and repeats at the same local time all year: 10 am stays 10 am when the clocks change. An all-day series needs none.
- `until` is not before the start. A rule has the five fields above and no others.

<a id="api-recurrence-exceptions"></a>

### Skipped and changed occurrences

- An occurrence is named by its **original day** in the event’s time zone, `YYYY-MM-DD`: the day the rule puts it on, also after it was moved. Reads return it as `occurrence_date`.
- `exceptions.add`: up to 64 days to skip, `{ "date": "2026-11-17" }`.
- `exceptions.change`: up to 64 occurrences with something of their own: `date`, and any of `start` + `end` (both, of the same kind as the series: times for a timed series, dates for an all-day one), `summary`, `description` and `location.description`. What is left out is the series’ own.
- A day is skipped or changed, not both, and named once.

<a id="api-recurrence-updates"></a>

### Writing a series again

- Send the event again with the same `event_id` to move it, rename it or change its rule: every occurrence follows.
- Leave `recurrence` out and the event keeps repeating as it does (and keeps its time zone when you send none). `"recurrence": null` makes it a single event again.
- Leave `exceptions.add` or `exceptions.change` out and that list is kept; send one and it replaces the series’ list. Exceptions on days the new rule no longer has are dropped.
- For one occurrence there are two shorter calls: [DELETE with `occurrence_date`](#api-events-delete) skips it, and [POST …/events/occurrences](#api-events-occurrences) changes it.
- Deleting the event deletes the whole series. A series can have guests and a meeting link like any other event.

The event stops repeating and becomes one event

```json
{
  "event_id": "class-7",
  "summary": "Tuesday pilates",
  "start": "2026-11-02T23:00:00Z",
  "end": "2026-11-03T00:00:00Z",
  "tzid": "Australia/Melbourne",
  "recurrence": null
}
```

<a id="api-conferencing"></a>

## Meeting links

`conferencing.profile_id` asks the calendar to add its own meeting link to the event: Google Meet on Google calendars, Microsoft Teams on Microsoft 365 and Outlook.com.

| Name | Type | Description |
| --- | --- | --- |
| `default` | `value` | Add the calendar's own link where it has one. On a calendar without one the event is written without a link, and the write still succeeds. |
| `integrated` | `value` | Add the calendar’s own link, and answer `422` (`errors.conferencing_unavailable`) on a calendar that has none. |
| `none` | `value` | Take the link off the event. |

- Reads show `"conferencing": { "pending": true }` as soon as the write is accepted, then `{ "provider_name", "join_url" }` once the calendar has made the link, usually within seconds. You get no notification for your own write, so read the event again a moment later.
- A link stays on the event through later writes, also ones that leave `conferencing` out. The same link is kept when the event moves.
- Guests get the link with their invitation. On Microsoft calendars the join details are also added to the event’s description in the person’s calendar; reads return your description without them.

<a id="api-events-delete"></a>

## DELETE /v1/calendars/{calendar_id}/events

**DELETE** `https://api.calmonkey.com/v1/calendars/{calendar_id}/events`

**Authentication:** `Authorization: Bearer <access_token>`

| Name | Type | Description |
| --- | --- | --- |
| `event_id` (required) | `string` | The id the event was written with. |
| `occurrence_date` | `date` | Cancel only this occurrence of a repeating event: its original day in the event’s time zone (`2026-12-01`). The rest of the series stays. |
| `notify_attendees` | `boolean` | Whether guests are sent the cancellation. Default `true`. |

Cancel the occurrence of 1 December

```json
{
  "event_id": "class-7",
  "occurrence_date": "2026-12-01"
}
```

Delete an event and send no cancellations

```json
{
  "event_id": "consult-88",
  "notify_attendees": false
}
```

`202 Accepted`, empty body, also when there is no such event. Without `occurrence_date` a repeating event is deleted with all its occurrences. With it, `422` on `occurrence_date` when the event does not repeat (`errors.not_recurring`) or has no occurrence on that day (`errors.not_an_occurrence`); skipping a day that is already skipped is fine.

<a id="api-events-occurrences"></a>

## POST /v1/calendars/{calendar_id}/events/occurrences

**POST** `https://api.calmonkey.com/v1/calendars/{calendar_id}/events/occurrences`

**Authentication:** `Authorization: Bearer <access_token>`

Gives one occurrence of a repeating event its own time, text or both, without sending the series again.

| Name | Type | Description |
| --- | --- | --- |
| `event_id` (required) | `string` | The id the series was written with. |
| `occurrence_date` (required) | `date` | The occurrence’s original day in the event’s time zone. |
| `start / end` | `string or object` | A new time for this occurrence: both or neither, times for a timed series and dates for an all-day one. |
| `tzid` | `string` | The time zone of the new time. Default: the series' own. |
| `summary` | `string` | A title for this occurrence, up to 2,000 characters. |
| `description` | `string` | Up to 50,000 characters. |
| `location.description` | `string` | Up to 2,000 characters. |
| `notify_attendees` | `boolean` | Whether guests are told. Default `true`. |

The class of 8 December moves to midday and gets its own title

```json
{
  "event_id": "class-7",
  "occurrence_date": "2026-12-08",
  "start": "2026-12-08T01:00:00Z",
  "end": "2026-12-08T02:00:00Z",
  "summary": "Tuesday pilates (midday)"
}
```

- `202 Accepted`, empty body. The body is everything that differs for this occurrence: it replaces an earlier change of the same occurrence, and a field left out is the series’ own again. At least one of the new time, `summary`, `description` and `location` is needed.
- Changing an occurrence that was skipped brings it back.
- `404` for an `event_id` your application has not written to the calendar. `422` on `occurrence_date` with `errors.not_recurring` or `errors.not_an_occurrence`, as for DELETE.
- The same change can be made with the series itself, in `recurrence.exceptions.change`.

<a id="api-event-errors"></a>

## 422 keys of event writes

Event writes answer `422` in the usual shape ([field errors](errors.md#errors-validation)). These are the keys of the guest, repeating-event and meeting-link fields; the field name is the path into your body, such as `attendees.invite[0].email` or `recurrence.rules[0].until`.

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
