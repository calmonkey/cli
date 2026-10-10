# Channels and webhooks

Being told about changes: creating and closing channels, what a notification holds, verifying its signatures, and how deliveries are retried.

> Made from the CalMonkey documentation (https://calmonkey.com/docs/api.md, https://calmonkey.com/docs/quickstart.md, https://calmonkey.com/docs/ai.md, https://calmonkey.com/docs/errors.md). Changes go to the documentation, not to this file.

## Contents

- [POST /v1/channels](#api-channels-create)
- [GET /v1/channels](#api-channels-list)
- [DELETE /v1/channels/{channel_id}](#api-channels-close)
- [Notifications](#api-notifications)
- [7. Get told about changes](#quickstart-webhooks)
- [Webhooks on your own machine](#ai-listen)
- [Webhook delivery and retries](#errors-webhook-retries)

<a id="api-channels-create"></a>

## POST /v1/channels

**POST** `https://api.calmonkey.com/v1/channels`

**Authentication:** `Authorization: Bearer <access_token>`

| Name | Type | Description |
| --- | --- | --- |
| `callback_url` (required) | `string` | https, port 443, a public host. No credentials in the URL. |
| `filters.calendar_ids` | `string[]` | Only changes in these calendars (up to 200). Default: every calendar of the account. |
| `filters.only_managed` | `boolean` | Only changes to events your application created. |

Request body

```json
{
  "callback_url": "https://yourapp.example/calmonkey/notifications",
  "filters": {
    "calendar_ids": ["cal_89645320138ae1ac547189a1"],
    "only_managed": false
  }
}
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

A `verification` notification goes to the callback URL at once. `signing_secret` is returned only here (not in compatibility mode). An account has at most 100 open channels. A URL that is not https answers `422` with `errors.invalid_callback_url`; a host CalMonkey will not call (local, private or example addresses) with `errors.invalid_callback_url_blocked`.

One exception, for building on your own machine: an application in test mode may give `http://localhost`, `http://127.0.0.1` or `http://[::1]` (any port and path). CalMonkey does not call such an address. It holds the notifications, and `calmonkey listen` collects them and posts them there, signed as usual: see [Webhooks on your own machine](#ai-listen).

<a id="api-channels-list"></a>

## GET /v1/channels

**GET** `https://api.calmonkey.com/v1/channels`

**Authentication:** `Authorization: Bearer <access_token>`

200 OK

```json
{
  "channels": [
    {
      "channel_id": "chn_633d9797c6e79a681d8ba688",
      "callback_url": "https://yourapp.example/calmonkey/notifications",
      "filters": { "calendar_ids": ["cal_89645320138ae1ac547189a1"] }
    }
  ]
}
```

The account’s open channels. Filters that were not set are left out.

<a id="api-channels-close"></a>

## DELETE /v1/channels/{channel_id}

**DELETE** `https://api.calmonkey.com/v1/channels/{channel_id}`

**Authentication:** `Authorization: Bearer <access_token>`

Closes the channel: `202`, empty body, also when it was already closed. `404` for an id the account never had, with the body `{"error":"not_found","description":"…"}`.

<a id="api-notifications"></a>

## Notifications

What CalMonkey POSTs to a channel’s callback URL: `{ "notification": { "type", "changes_since" }, "channel": { … } }`. Headers, signatures and verification code are in the [quickstart](#quickstart-verify); retries in [Errors and limits](#errors-webhook-retries).

| Name | Type | Description |
| --- | --- | --- |
| `verification` | `type` | Sent once when the channel is created. |
| `change` | `type` | Something changed in the account’s calendars. `changes_since` (UTC, whole seconds) is where to read from. |
| `profile_disconnected` | `type` | A connected calendar account needs to be connected again. |
| `profile_initial_sync_completed` | `type` | A newly connected calendar account has finished its first sync. |

> Your application is never notified of changes it made itself through the API. Several changes close together are sent as one notification.

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
- While you build, a test-mode application can also register a callback URL on your own machine, such as `http://localhost:3000/webhooks/calmonkey`. CalMonkey holds those notifications and `calmonkey listen` brings them to it, signed as usual: see [Webhooks on your own machine](#ai-listen).
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

Answer with any 2xx within 5 seconds. Anything else, including a redirect, is retried for about 23 hours; `410 Gone` closes the channel. The schedule is on [Errors and limits](#errors-webhook-retries).

<a id="ai-listen"></a>

## Webhooks on your own machine

A test-mode application can register a webhook callback URL on your own machine: `http://localhost:<port>/<path>`, or the same on `127.0.0.1` or `[::1]`, exactly as its code will register the https one in production. A live application cannot.

```sh
npx calmonkey listen
```

CalMonkey does not send those notifications itself. It holds them, for up to 24 hours, and `calmonkey listen` collects them over its signed-in connection and posts each one to the callback URL on this machine, with the body and every header as CalMonkey made them: `Calmonkey-Signature`, `Calmonkey-HMAC-SHA256` (and the second HMAC header in compatibility mode), `Calmonkey-Delivery-Id` and `Calmonkey-Delivery-Attempt`. So the code that [verifies signatures](#quickstart-webhooks) is exercised for real.

- What your endpoint answers is reported back: a 2xx counts as delivered, anything else is retried on the [usual schedule](#errors-webhook-retries), and `410` closes the channel.
- Each delivery shows in the dashboard’s webhook log, in `calmonkey logs webhooks` and in the `read_webhook_deliveries` tool.
- `--forward-to <url>` sends every notification to that one address instead of each channel’s own callback URL.
- It prints a “Ready” line, then two lines per notification: `-->` what arrived and `<--` what your endpoint answered.
- It needs an owner or admin, and works for test-mode applications only.

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
