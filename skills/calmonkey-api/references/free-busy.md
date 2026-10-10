# Free/busy

When a person's calendars are busy: the read behind booking and scheduling features.

> Made from the CalMonkey documentation (https://calmonkey.com/docs/api.md). Changes go to the documentation, not to this file.

<a id="api-free-busy"></a>

## GET /v1/free_busy

**GET** `https://api.calmonkey.com/v1/free_busy`

**Authentication:** `Authorization: Bearer <access_token>`

| Name | Type | Description |
| --- | --- | --- |
| `tzid` (required) | `string` | Time zone the request’s dates are read in, e.g. `Australia/Melbourne`. |
| `from` | `date or time` | Start, a day (`2026-11-03`) in `tzid` or a time with an offset. Defaults to 42 days ago. |
| `to` | `date or time` | End, exclusive. Defaults to 201 days from now. |
| `calendar_ids[]` | `string, repeatable` | Only these calendars (up to 100). Default: every calendar of the account. |
| `include_managed` | `boolean` | Include events your application created. Default `false`. |
| `include_ids` | `boolean` | Add `event_id` to the periods of events your application created. |
| `localized_times` | `boolean` | Times with the offset of `tzid` instead of UTC. |

200 OK

```json
{
  "pages": { "current": 1, "total": 1 },
  "free_busy": [
    {
      "calendar_id": "cal_89645320138ae1ac547189a1",
      "event_uid": "evt_d589a60f0b07d0e721482ee2",
      "start": "2026-11-02T22:00:00Z",
      "end": "2026-11-02T23:30:00Z",
      "free_busy_status": "busy"
    },
    {
      "calendar_id": "cal_89645320138ae1ac547189a1",
      "event_uid": "evt_6a1f2c3d4e5b6a7c8d9e0f12",
      "start": "2026-11-03T03:00:00Z",
      "end": "2026-11-03T04:00:00Z",
      "free_busy_status": "busy",
      "event_id": "booking-1042"
    }
  ]
}
```

| Name | Type | Description |
| --- | --- | --- |
| `calendar_id` | `string` | The calendar of the event. |
| `event_uid` | `string` | Identifies the event (evt\_…). |
| `start / end` | `string` | Times in UTC (or local with localized_times), or dates for all-day events with an exclusive end. Not clipped to the window. |
| `free_busy_status` | `string` | `busy`, `tentative` or `free` (an event shown as free). |
| `event_id` | `string` | Only with `include_ids=true`, only on your application’s own events: the id you chose. |

A repeating event gives one period for each occurrence in the window. Invitations the person declined are never busy and are left out.

Up to 1,000 periods per page. When there are more, `pages.next_page` is an absolute URL for the next page: request it with the same token, as it is.
