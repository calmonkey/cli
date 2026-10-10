# Application calendars

Calendars CalMonkey hosts itself, opened with your client credentials alone: for tests, demos and people with no calendar to connect.

> Made from the CalMonkey documentation (https://calmonkey.com/docs/api.md, https://calmonkey.com/docs/quickstart.md, https://calmonkey.com/docs/providers.md). Changes go to the documentation, not to this file.

## Contents

- [POST /v1/application_calendars](#api-application-calendars)
- [8. Test without a real calendar](#quickstart-application-calendars)
- [Application calendars](#providers-application-calendars)

<a id="api-application-calendars"></a>

## POST /v1/application_calendars

**POST** `https://api.calmonkey.com/v1/application_calendars`

**Authentication:** Your client id and client secret, in the request body. Wrong credentials answer 401 with an empty body.

| Name | Type | Description |
| --- | --- | --- |
| `client_id` (required) | `string` | Your client id. |
| `client_secret` (required) | `string` | Your client secret. |
| `application_calendar_id` (required) | `string` | Your name for the calendar, up to 255 characters. The same id always opens the same calendar. |

200 OK

```json
{
  "token_type": "bearer",
  "access_token": "cmat_3kVb7Qx1Lr9Zs5Hd0Wn2Pc8Fy4Mj6Tg1Ae5Ku7Oi3Ys0",
  "expires_in": 10800,
  "refresh_token": "cmrt_9Xc2Vb6Nm1Lk4Jh8Gf3Ds7Aq0Pw5Oe2Iu9Yt6Rr1Ee4",
  "scope": "read_write",
  "account_id": "apc_c4a4b70dce47c34ad4d384f8",
  "sub": "apc_c4a4b70dce47c34ad4d384f8",
  "linking_profile": {
    "provider_name": "calmonkey",
    "profile_id": "pro_1b9e64c0d2a7f3e85c6d4a21",
    "profile_name": "test-calendar-1"
  },
  "application_calendar_id": "test-calendar-1"
}
```

Creates the calendar on first use and returns tokens for it: a token response with `sub` `apc_…` and your `application_calendar_id`. Each call returns a new token pair (in compatibility mode, the pair the calendar already has while it is valid). The account has one profile and one writable, primary calendar.

<a id="quickstart-application-calendars"></a>

## 8. Test without a real calendar

Application calendars are hosted by CalMonkey and opened with your client credentials alone, no browser involved. The same `application_calendar_id` always opens the same calendar. Everything above works on them, which makes them the quickest way to try the API and to run integration tests.

```sh
curl https://api.calmonkey.com/v1/application_calendars \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "V2msxgA-kN7GMgxrsWLaCXL_NhKGLLGd",
    "client_secret": "'"$CLIENT_SECRET"'",
    "application_calendar_id": "test-calendar-1"
  }'
```

200 OK

```json
{
  "token_type": "bearer",
  "access_token": "cmat_3kVb7Qx1Lr9Zs5Hd0Wn2Pc8Fy4Mj6Tg1Ae5Ku7Oi3Ys0",
  "expires_in": 10800,
  "refresh_token": "cmrt_9Xc2Vb6Nm1Lk4Jh8Gf3Ds7Aq0Pw5Oe2Iu9Yt6Rr1Ee4",
  "scope": "read_write",
  "account_id": "apc_c4a4b70dce47c34ad4d384f8",
  "sub": "apc_c4a4b70dce47c34ad4d384f8",
  "linking_profile": {
    "provider_name": "calmonkey",
    "profile_id": "pro_1b9e64c0d2a7f3e85c6d4a21",
    "profile_name": "test-calendar-1"
  },
  "application_calendar_id": "test-calendar-1"
}
```

<a id="providers-application-calendars"></a>

## Application calendars

Calendars hosted by CalMonkey itself, with `provider_name` `calmonkey` (another name in [compatibility mode](https://calmonkey.com/docs/compatibility.md#mode)). They need no user and no provider, and are always up to date. See the [quickstart](#quickstart-application-calendars). Repeating events work as on any calendar. An application calendar has no mail service behind it, so guests are stored and returned when you write them with `notify_attendees: false`, and nobody is emailed.
