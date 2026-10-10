# Quickstart

From nothing to a connected calendar, free/busy, a written event and verified webhooks. The examples use curl; any HTTP client works. Replace `$CLIENT_SECRET` with your client secret.

> Made from the CalMonkey documentation (https://calmonkey.com/docs/quickstart.md). Changes go to the documentation, not to this file.

## Contents

- [1. Create an application](#quickstart-application)
- [2. Send your user to connect a calendar](#quickstart-connect)
- [3. Exchange the code for tokens](#quickstart-token)
- [4. List the calendars](#quickstart-calendars)
- [5. Read free/busy](#quickstart-free-busy)
- [6. Write an event](#quickstart-events)
- [7. Get told about changes](#quickstart-webhooks)
- [8. Test without a real calendar](#quickstart-application-calendars)
- [9. Disconnect](#quickstart-disconnect)

<a id="quickstart-application"></a>

## 1. Create an application

> Fastest path: run `npx calmonkey init` in your project. It signs you in, picks or creates a test application, writes its client id and secret into your environment file and installs the CalMonkey skill, so your AI coding agent runs `calmonkey` commands. See [AI coding tools](ai-tools.md).

Sign in at [app.calmonkey.com/sign-in](https://app.calmonkey.com/sign-in) and create an application in the [dashboard](https://app.calmonkey.com/dashboard). You get:

- a **client id**, which is public: it goes in the connect link;
- a **client secret** (`cmsec_…`), shown once, when it is created or rotated. Keep it on your server only. It authenticates your token requests and is also the key of the webhook signature. After a rotation the previous secret keeps working for 24 hours, so you can deploy the new one without downtime;
- the **redirect URIs** your users may be sent back to. They must match exactly (no wildcards, no prefix matching, no forgiving trailing slash): https addresses, http only on `localhost`, `127.0.0.1` or `[::1]` (any http host while the application is in test mode), or an app link such as `yourapp://calendar`. No fragments, no credentials.

New applications start in **test mode**: the connect page then shows a “Test mode” label, so a trial run is never mistaken for the real thing.

<a id="quickstart-connect"></a>

## 2. Send your user to connect a calendar

Redirect the user’s browser to `/oauth/authorize` on the app host. They pick Google, Microsoft 365, Outlook.com or Apple iCloud, sign in with the provider and come back to your redirect URI with a code.

```sh
https://app.calmonkey.com/oauth/authorize
  ?response_type=code
  &client_id=V2msxgA-kN7GMgxrsWLaCXL_NhKGLLGd
  &redirect_uri=https%3A%2F%2Fyourapp.example%2Fcalendar%2Fcallback
  &scope=read_write
  &state=4f1c2a9e7b
```

| Name | Type | Description |
| --- | --- | --- |
| `response_type` (required) | `string` | Always `code`. |
| `client_id` (required) | `string` | Your application's client id. |
| `redirect_uri` (required) | `string` | One of the application's redirect URIs, exactly as registered. |
| `scope` | `string` | Defaults to `read_write`. |
| `state` | `string` | Any value; it comes back unchanged. Use it to tie the callback to the user's session and to stop cross-site request forgery. |
| `provider_name` | `string` | Skip the chooser: `google`, `office365` (Microsoft 365 work or school), `live_connect` (Outlook.com, Hotmail, Live) or `apple` (iCloud). |
| `link_token` | `string` | From [POST /v1/link_tokens](connect-and-tokens.md#api-link-tokens): the calendar account connected in this run joins an existing account instead of starting a new one. |

When the user has connected, the browser comes back to your redirect URI:

```
https://yourapp.example/calendar/callback?code=cmac_syNmBk3GTXqpLQVNfyoZ0iofd3uXDmunIBaksd9i1u0&state=4f1c2a9e7b
```

If they cancel or decline, it comes back with `error=access_denied` (and your `state`), sometimes with an `error_description`. An unknown client id or a redirect URI that is not registered never redirects: the user sees an error page instead, so the endpoint cannot be used to send people to other sites.

<a id="quickstart-token"></a>

## 3. Exchange the code for tokens

From your server, within 10 minutes. A code works once, and only with the `redirect_uri` it was issued for.

```sh
curl https://api.calmonkey.com/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "V2msxgA-kN7GMgxrsWLaCXL_NhKGLLGd",
    "client_secret": "'"$CLIENT_SECRET"'",
    "grant_type": "authorization_code",
    "code": "cmac_syNmBk3GTXqpLQVNfyoZ0iofd3uXDmunIBaksd9i1u0",
    "redirect_uri": "https://yourapp.example/calendar/callback"
  }'
```

200 OK

```json
{
  "token_type": "bearer",
  "access_token": "cmat_Tz5vTHRrZ5QIIK0Ng0zRJCkt9ZqmjBrNn1mv7x4DbGg",
  "expires_in": 10800,
  "refresh_token": "cmrt_D0L78QVguUuBnvOcex1VPdSP0uPRYOCtQMGeFi8Qku8",
  "scope": "read_write",
  "account_id": "acc_38da51e7b1345bb5fae3656a",
  "sub": "acc_38da51e7b1345bb5fae3656a",
  "linking_profile": {
    "provider_name": "google",
    "profile_id": "pro_7782a96ff1609061631ebc5b",
    "profile_name": "dana@example.com"
  }
}
```

Store `access_token`, `refresh_token` and `sub` (the account id) against your user. `linking_profile` says which calendar account was just connected. The body may also be sent as `application/x-www-form-urlencoded`.

<a id="quickstart-refresh"></a>

### Refreshing

Access tokens last 3 hours (`expires_in` is in seconds). A `401` from `/v1` means the token expired or was revoked: refresh it and retry once. The refresh token does not change.

```sh
curl https://api.calmonkey.com/oauth/token \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "V2msxgA-kN7GMgxrsWLaCXL_NhKGLLGd",
    "client_secret": "'"$CLIENT_SECRET"'",
    "grant_type": "refresh_token",
    "refresh_token": "cmrt_D0L78QVguUuBnvOcex1VPdSP0uPRYOCtQMGeFi8Qku8"
  }'
```

200 OK

```json
{
  "token_type": "bearer",
  "access_token": "cmat_8yWq0eYb2Hn6R1sVdKp3LmXc5ZtA9uGf4JoQiNwE7Bv",
  "expires_in": 10800,
  "refresh_token": "cmrt_D0L78QVguUuBnvOcex1VPdSP0uPRYOCtQMGeFi8Qku8",
  "scope": "read_write"
}
```

A refresh token that has been revoked answers `400 {"error":"invalid_grant"}`: the user has to connect again.

<a id="quickstart-calendars"></a>

## 4. List the calendars

```sh
curl https://api.calmonkey.com/v1/calendars \
  -H "Authorization: Bearer cmat_Tz5vTHRrZ5QIIK0Ng0zRJCkt9ZqmjBrNn1mv7x4DbGg"
```

200 OK

```json
{
  "calendars": [
    {
      "provider_name": "google",
      "profile_id": "pro_7782a96ff1609061631ebc5b",
      "profile_name": "dana@example.com",
      "calendar_id": "cal_89645320138ae1ac547189a1",
      "calendar_name": "dana@example.com",
      "calendar_readonly": false,
      "calendar_deleted": false,
      "calendar_primary": true,
      "calendar_integrated_conferencing_available": true,
      "calendar_attachments_available": false,
      "permission_level": "unrestricted"
    },
    {
      "provider_name": "google",
      "profile_id": "pro_7782a96ff1609061631ebc5b",
      "profile_name": "dana@example.com",
      "calendar_id": "cal_2f6c8e1a9b3d4f5a6b7c8d9e",
      "calendar_name": "Public holidays",
      "calendar_readonly": true,
      "calendar_deleted": false,
      "calendar_primary": false,
      "calendar_integrated_conferencing_available": false,
      "calendar_attachments_available": false,
      "permission_level": "unrestricted"
    }
  ],
  "sub": "acc_38da51e7b1345bb5fae3656a"
}
```

The shape is the same for every provider. Write to calendars whose `calendar_readonly` is false; most products use the one with `calendar_primary: true`. The list is read from the provider during the connect flow, so it is normally there as soon as you have the token.

<a id="quickstart-free-busy"></a>

## 5. Read free/busy

```sh
curl -G https://api.calmonkey.com/v1/free_busy \
  -H "Authorization: Bearer cmat_Tz5vTHRrZ5QIIK0Ng0zRJCkt9ZqmjBrNn1mv7x4DbGg" \
  --data-urlencode "tzid=Australia/Melbourne" \
  --data-urlencode "from=2026-11-03" \
  --data-urlencode "to=2026-11-04" \
  --data-urlencode "calendar_ids[]=cal_89645320138ae1ac547189a1" \
  --data-urlencode "include_managed=true" \
  --data-urlencode "include_ids=true"
```

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

- `from` and `to` are days in `tzid` (or times with an offset); `to` is exclusive.
- One period per event. Events marked “show as free” are `free`, tentative ones `tentative`, everything else `busy`; cancelled events are left out.
- Events your application wrote are left out unless you pass `include_managed=true`; with `include_ids=true` they carry your own `event_id`, so you can tell your bookings from the person’s other commitments.
- More than 1,000 periods come in pages: follow `pages.next_page`, an absolute URL, as it is.

<a id="quickstart-events"></a>

## 6. Write an event

Events are created and updated by **your** id, `event_id`. Sending the same body twice leaves one event; sending a changed one updates it.

```sh
curl https://api.calmonkey.com/v1/calendars/cal_89645320138ae1ac547189a1/events \
  -H "Authorization: Bearer cmat_Tz5vTHRrZ5QIIK0Ng0zRJCkt9ZqmjBrNn1mv7x4DbGg" \
  -H "Content-Type: application/json" \
  -d '{
  "event_id": "booking-1042",
  "summary": "Lash lift with Grace",
  "description": "Booked through Your App",
  "start": "2026-11-03T03:00:00Z",
  "end": "2026-11-03T04:00:00Z",
  "tzid": "Australia/Melbourne",
  "location": { "description": "12 Harbour St, Melbourne" },
  "url": "https://yourapp.example/bookings/1042",
  "transparency": "opaque"
}'
```

```http
HTTP/1.1 202 Accepted
```

The event is in free/busy and in `GET /v1/events` as soon as the 202 is sent; the write to the provider follows within moments. For an all-day event send two dates, the end exclusive: `"start": "2026-11-03", "end": "2026-11-04"`. To remove it:

```sh
curl -X DELETE https://api.calmonkey.com/v1/calendars/cal_89645320138ae1ac547189a1/events \
  -H "Authorization: Bearer cmat_Tz5vTHRrZ5QIIK0Ng0zRJCkt9ZqmjBrNn1mv7x4DbGg" \
  -H "Content-Type: application/json" \
  -d '{ "event_id": "booking-1042" }'
```

Also `202`, including when there was no such event. A read-only calendar answers `403`, an unknown one `404`.

The same call does more when you need it: `attendees` invites guests and reads their replies back, `recurrence` makes the event repeat, and `conferencing` adds a Google Meet or Microsoft Teams link. See [guests](events.md#api-guests), [repeating events](events.md#api-recurrence) and [meeting links](events.md#api-conferencing) in the API reference.

<a id="quickstart-webhooks"></a>

## 7. Get told about changes

Create a channel per account. CalMonkey sends a notification to your callback URL whenever the person’s calendars change.

```sh
curl https://api.calmonkey.com/v1/channels \
  -H "Authorization: Bearer cmat_Tz5vTHRrZ5QIIK0Ng0zRJCkt9ZqmjBrNn1mv7x4DbGg" \
  -H "Content-Type: application/json" \
  -d '{
  "callback_url": "https://yourapp.example/calmonkey/notifications",
  "filters": {
    "calendar_ids": ["cal_89645320138ae1ac547189a1"],
    "only_managed": false
  }
}'
```

200 OK

```json
{
  "channel": {
    "channel_id": "chn_633d9797c6e79a681d8ba688",
    "callback_url": "https://yourapp.example/calmonkey/notifications",
    "filters": { "calendar_ids": ["cal_89645320138ae1ac547189a1"] },
    "signing_secret": "whsec_jHsZ7xVMwTVOJBnkmfDpreMncVmdh-pg_mWfWApj36M"
  }
}
```

- The callback URL must be https on port 443 and on a public host. A `verification` notification is sent to it straight away.
- While you build, a test-mode application can also register a callback URL on your own machine, such as `http://localhost:3000/webhooks/calmonkey`. CalMonkey holds those notifications and `calmonkey listen` brings them to it, signed as usual: see [Webhooks on your own machine](channels-and-webhooks.md#ai-listen).
- `signing_secret` is returned once, here. Store it with the channel: it keys the `Calmonkey-Signature` header. (Applications in [compatibility mode](https://calmonkey.com/docs/compatibility.md#mode) get the response without it, and their notifications carry no `Calmonkey-Signature`.)
- Changes your application made through the API are never notified back to it. With `only_managed: true` the channel only hears about events your application created.

What your callback URL receives

```json
{
  "notification": {
    "type": "change",
    "changes_since": "2026-10-20T01:12:09Z"
  },
  "channel": {
    "channel_id": "chn_633d9797c6e79a681d8ba688",
    "callback_url": "https://yourapp.example/calmonkey/notifications",
    "filters": { "calendar_ids": ["cal_89645320138ae1ac547189a1"] }
  }
}
```

Types: `verification`, `change` (read events changed since `changes_since`, for example with `GET /v1/events?last_modified=…`, or read free/busy again), `profile_disconnected` (the person must connect again; see `GET /v1/profiles`) and `profile_initial_sync_completed`.

<a id="quickstart-verify"></a>

### Verify every notification

Each request carries these headers:

| Name | Type | Description |
| --- | --- | --- |
| `Calmonkey-HMAC-SHA256` | `base64` | HMAC-SHA256 of the raw body, keyed with your client secret. While a rotated secret is still valid, one value per active secret, comma-separated: accept the request when any value matches. |
| `Calmonkey-Signature` | `t=…,v1=…` | `t` is the time in Unix seconds, `v1` the hex HMAC-SHA256 of `<t>.<raw body>` keyed with the channel’s `whsec_` secret. Checking `t` stops replays. |
| `Calmonkey-Delivery-Id` | `whd_…` | The same on every retry of one notification: use it to ignore repeats. |
| `Calmonkey-Delivery-Attempt` | `integer` | 1 for the first attempt. |

**Node**

```js
import crypto from "node:crypto";
import express from "express";

const app = express();
const CLIENT_SECRET = process.env.CALMONKEY_CLIENT_SECRET;
const SIGNING_SECRET = process.env.CALMONKEY_CHANNEL_SIGNING_SECRET; // whsec_…

// Verify the raw bytes: JSON parsed and serialised again will not match.
app.post("/calmonkey/notifications", express.raw({ type: "application/json" }), (req, res) => {
  const raw = req.body; // a Buffer
  const ok =
    verifyHmac(raw, req.get("Calmonkey-HMAC-SHA256"), CLIENT_SECRET) &&
    verifySignature(raw, req.get("Calmonkey-Signature"), SIGNING_SECRET);
  if (!ok) return res.sendStatus(401);

  const { notification, channel } = JSON.parse(raw.toString("utf8"));
  // Answer fast; do the work in your own queue.
  queueCalendarRefresh(channel.channel_id, notification.type, notification.changes_since);
  res.sendStatus(204);
});

const same = (a, b) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

// Base64 HMAC-SHA256 of the body, keyed with your client secret. During a secret
// rotation the header holds one value per active secret, separated by commas.
function verifyHmac(raw, header, clientSecret) {
  if (!header) return false;
  const expected = crypto.createHmac("sha256", clientSecret).update(raw).digest("base64");
  return header.split(",").some((value) => same(value.trim(), expected));
}

// t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>"> keyed with the channel's
// whsec_ secret. Refuse old timestamps so a recorded request cannot be replayed.
function verifySignature(raw, header, signingSecret, toleranceSeconds = 300) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.trim().split("=", 2)));
  const t = Number(parts.t);
  if (!Number.isInteger(t) || !parts.v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSeconds) return false;
  const expected = crypto.createHmac("sha256", signingSecret).update(`${t}.`).update(raw).digest("hex");
  return same(parts.v1, expected);
}
```

**Python**

```python
import base64
import hashlib
import hmac
import os
import time

from flask import Flask, abort, request

app = Flask(__name__)
CLIENT_SECRET = os.environ["CALMONKEY_CLIENT_SECRET"].encode()
SIGNING_SECRET = os.environ["CALMONKEY_CHANNEL_SIGNING_SECRET"].encode()  # whsec_…


@app.post("/calmonkey/notifications")
def notifications():
    raw = request.get_data()  # the exact bytes that were signed
    if not (
        valid_hmac(raw, request.headers.get("Calmonkey-HMAC-SHA256", ""))
        and valid_signature(raw, request.headers.get("Calmonkey-Signature", ""))
    ):
        abort(401)
    body = request.get_json()
    # Answer fast; do the work in your own queue.
    queue_calendar_refresh(body["channel"]["channel_id"], body["notification"]["type"])
    return "", 204


def valid_hmac(raw: bytes, header: str) -> bool:
    # Base64 HMAC-SHA256 of the body, keyed with your client secret. During a secret
    # rotation the header holds one value per active secret, separated by commas.
    expected = base64.b64encode(hmac.new(CLIENT_SECRET, raw, hashlib.sha256).digest()).decode()
    return any(hmac.compare_digest(v.strip(), expected) for v in header.split(",") if v.strip())


def valid_signature(raw: bytes, header: str, tolerance: int = 300) -> bool:
    # t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">, keyed with the channel's whsec_ secret.
    parts = dict(p.strip().split("=", 1) for p in header.split(",") if "=" in p)
    try:
        t = int(parts["t"])
    except (KeyError, ValueError):
        return False
    if abs(time.time() - t) > tolerance:
        return False
    expected = hmac.new(SIGNING_SECRET, f"{t}.".encode() + raw, hashlib.sha256).hexdigest()
    return hmac.compare_digest(parts.get("v1", ""), expected)
```

**curl**

```sh
# Sign a test notification the way CalMonkey does and send it to your
# receiver, to check its verification before real notifications arrive.
BODY='{"notification":{"type":"verification"},"channel":{"channel_id":"chn_633d9797c6e79a681d8ba688","callback_url":"https://yourapp.example/calmonkey/notifications","filters":{}}}'
T=$(date +%s)

# Calmonkey-HMAC-SHA256: base64 HMAC-SHA256 of the body with your client secret
HMAC=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$CLIENT_SECRET" -binary | base64)

# Calmonkey-Signature: hex HMAC-SHA256 of "<t>.<body>" with the channel's whsec_ secret
SIG=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SIGNING_SECRET" | sed 's/^.*= //')

curl -i http://localhost:8080/calmonkey/notifications \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "Calmonkey-HMAC-SHA256: $HMAC" \
  -H "Calmonkey-Signature: t=$T,v1=$SIG" \
  -H "Calmonkey-Delivery-Id: whd_0c7e5b3a1d9f8e6c4b2a0d1e" \
  -H "Calmonkey-Delivery-Attempt: 1" \
  --data-raw "$BODY"
```

Answer with any 2xx within 5 seconds. Anything else, including a redirect, is retried for about 23 hours; `410 Gone` closes the channel. The schedule is on [Errors and limits](channels-and-webhooks.md#errors-webhook-retries).

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

<a id="quickstart-disconnect"></a>

## 9. Disconnect

When a user disconnects their calendar in your product, revoke the grant. Send either token:

```sh
curl https://api.calmonkey.com/oauth/token/revoke \
  -H "Content-Type: application/json" \
  -d '{
    "client_id": "V2msxgA-kN7GMgxrsWLaCXL_NhKGLLGd",
    "client_secret": "'"$CLIENT_SECRET"'",
    "token": "cmrt_D0L78QVguUuBnvOcex1VPdSP0uPRYOCtQMGeFi8Qku8"
  }'
```

`200` with an empty body, whether or not the token was known. Every token of the account stops working at once, its channels close, and its stored credentials and cached events are deleted within 24 hours. Events your application wrote are not removed from the person’s calendar: delete them first if you want them gone. An application calendar is deleted altogether.

> Next: the full [API reference](api-reference.md), [errors and limits](errors.md), and what to expect from each [provider](providers.md).
