# Connecting calendars and tokens

Sending a person to connect a calendar, exchanging the code, refreshing and revoking tokens, adding a second calendar account, and reading who and what is connected.

> Made from the CalMonkey documentation (https://calmonkey.com/docs/api.md). Changes go to the documentation, not to this file.

## Contents

- [GET /oauth/authorize](#api-authorize)
- [POST /oauth/token](#api-token)
- [POST /oauth/token/revoke](#api-revoke)
- [POST /v1/link_tokens](#api-link-tokens)
- [GET /v1/account](#api-account)
- [GET /v1/userinfo](#api-userinfo)
- [GET /v1/profiles](#api-profiles)
- [GET /v1/calendars](#api-calendars)

<a id="api-authorize"></a>

## GET /oauth/authorize

**GET** `https://app.calmonkey.com/oauth/authorize`

Opens the hosted connect page in the user’s browser. Not called by your server. Parameters and callbacks are described in the [quickstart](quickstart.md#quickstart-connect).

| Name | Type | Description |
| --- | --- | --- |
| `response_type` (required) | `string` | `code`. Anything else returns `error=unsupported_response_type` to your redirect URI. |
| `client_id` (required) | `string` | Your client id. |
| `redirect_uri` (required) | `string` | A registered redirect URI, exactly. |
| `scope` | `string` | Default `read_write`. A malformed scope returns `error=invalid_scope`. |
| `state` | `string` | Returned unchanged. |
| `provider_name` | `string` | `google`, `office365`, `live_connect` or `apple`: go straight to that provider. |
| `link_token` | `string` | Adds the connected calendar account to an existing account ([link tokens](#api-link-tokens)). |

Back at your redirect URI: `?code=…&state=…`, or `?error=access_denied&state=…` when the user cancels, declines, or the calendar account is already connected to another account of your application.

<a id="api-token"></a>

## POST /oauth/token

**POST** `https://api.calmonkey.com/oauth/token`

**Authentication:** Your client id and client secret, in the request body.

<a id="api-token-code"></a>

### grant_type=authorization_code

| Name | Type | Description |
| --- | --- | --- |
| `client_id` (required) | `string` | Your client id. |
| `client_secret` (required) | `string` | Your client secret. |
| `grant_type` (required) | `string` | `authorization_code` |
| `code` (required) | `string` | The code from the callback. Valid once, for 10 minutes. |
| `redirect_uri` (required) | `string` | The same redirect URI the authorization request used. |

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

| Name | Type | Description |
| --- | --- | --- |
| `access_token` | `string` | For `Authorization: Bearer`. Valid for `expires_in` seconds (10,800: 3 hours). |
| `refresh_token` | `string` | Gets new access tokens. Does not rotate. |
| `scope` | `string` | `read_write` |
| `sub / account_id` | `string` | The account (acc\_…). The same value under both names. |
| `linking_profile` | `object` | The calendar account connected in this run: `provider_name`, `profile_id`, `profile_name`. |

<a id="api-token-refresh"></a>

### grant_type=refresh_token

| Name | Type | Description |
| --- | --- | --- |
| `client_id` (required) | `string` | Your client id. |
| `client_secret` (required) | `string` | Your client secret. |
| `grant_type` (required) | `string` | `refresh_token` |
| `refresh_token` (required) | `string` | The account's refresh token. |

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

Errors are `400` with `{"error": "…"}`: `invalid_client` (wrong client id or secret), `invalid_grant` (code used, expired or for another redirect URI; refresh token revoked), `invalid_request` (a field is missing), `unsupported_grant_type`.

<a id="api-revoke"></a>

## POST /oauth/token/revoke

**POST** `https://api.calmonkey.com/oauth/token/revoke`

**Authentication:** Your client id and client secret, in the request body.

| Name | Type | Description |
| --- | --- | --- |
| `client_id` (required) | `string` | Your client id. |
| `client_secret` (required) | `string` | Your client secret. |
| `token` (required) | `string` | An access token or a refresh token of the account. |

`200`, empty body, whether or not the token was known. Revokes the whole grant: every token of the account, its channels, its stored provider credentials and its cached events. An application calendar is deleted with it; opening the same `application_calendar_id` again gives a new, empty calendar.

<a id="api-link-tokens"></a>

## POST /v1/link_tokens

**POST** `https://api.calmonkey.com/v1/link_tokens`

**Authentication:** `Authorization: Bearer <access_token>`

200 OK

```json
{ "link_token": "cmlt_Hy5_QceiTdbfCgu7Ou9ok59Aa8OC_OAZmwEbQLOo3io" }
```

Pass it to `/oauth/authorize` as `link_token` to add another calendar account to the same account, for example a work calendar next to a personal one. Single use, valid for 5 minutes. If the calendar account the person connects already belongs to a different account of your application, the flow ends with `error=access_denied`.

<a id="api-account"></a>

## GET /v1/account

**GET** `https://api.calmonkey.com/v1/account`

**Authentication:** `Authorization: Bearer <access_token>`

200 OK

```json
{
  "account": {
    "account_id": "acc_38da51e7b1345bb5fae3656a",
    "type": "account",
    "email": "dana@example.com",
    "name": "",
    "scope": "read_write",
    "default_tzid": "Etc/UTC"
  }
}
```

`type` is `account`, or `application_calendar` for an application calendar.

<a id="api-userinfo"></a>

## GET /v1/userinfo

**GET** `https://api.calmonkey.com/v1/userinfo`

**Authentication:** `Authorization: Bearer <access_token>`

Who the token belongs to, with every connected profile and its calendars.

200 OK

```json
{
  "sub": "acc_38da51e7b1345bb5fae3656a",
  "email": "dana@example.com",
  "zoneinfo": "Etc/UTC",
  "calmonkey.type": "account",
  "calmonkey.data": {
    "authorization": { "scope": "read_write", "status": "active" },
    "profiles": [
      {
        "provider_name": "google",
        "provider_service": "gmail",
        "profile_id": "pro_7782a96ff1609061631ebc5b",
        "profile_name": "dana@example.com",
        "profile_connected": true,
        "profile_initial_sync_required": false,
        "profile_calendars": [
          {
            "calendar_id": "cal_89645320138ae1ac547189a1",
            "calendar_name": "dana@example.com",
            "calendar_readonly": false,
            "calendar_deleted": false,
            "calendar_primary": true,
            "calendar_integrated_conferencing_available": true,
            "calendar_attachments_available": false,
            "permission_level": "unrestricted"
          }
        ]
      }
    ]
  }
}
```

For an application calendar, `application_calendar_id` takes the place of `email`, and the data includes `application_calendar`. In [compatibility mode](https://calmonkey.com/docs/compatibility.md#mode) the two keys have the names existing integrations read.

<a id="api-profiles"></a>

## GET /v1/profiles

**GET** `https://api.calmonkey.com/v1/profiles`

**Authentication:** `Authorization: Bearer <access_token>`

200 OK

```json
{
  "profiles": [
    {
      "provider_name": "office365",
      "provider_service": "office365",
      "profile_id": "pro_7782a96ff1609061631ebc5b",
      "profile_name": "dana@contoso.example",
      "profile_connected": false,
      "profile_relink_url": null,
      "profile_initial_sync_required": false,
      "profile_calendars": [
        {
          "calendar_id": "cal_89645320138ae1ac547189a1",
          "calendar_name": "Calendar",
          "calendar_readonly": false,
          "calendar_deleted": false,
          "calendar_primary": true,
          "calendar_integrated_conferencing_available": true,
          "calendar_attachments_available": false,
          "permission_level": "unrestricted"
        }
      ]
    }
  ]
}
```

- `profile_connected: false` means the person has to connect that calendar account again (the provider refused our access, or the password was revoked). Send them through `/oauth/authorize` with the same `provider_name`: the same profile, calendars and account come back.
- `provider_service`: `gmail`, `gsuite`, `office365`, `outlook_com`, `icloud`, or `calmonkey` for an application calendar.
- `profile_relink_url` is `null`: a profile is reconnected through `/oauth/authorize`, as above.
- `profile_initial_sync_required` is true until the profile’s first sync has finished.

<a id="api-calendars"></a>

## GET /v1/calendars

**GET** `https://api.calmonkey.com/v1/calendars`

**Authentication:** `Authorization: Bearer <access_token>`

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

Calendars deleted at the provider stay in the list with `calendar_deleted: true`. `calendar_integrated_conferencing_available` is true on a calendar that adds a meeting link of its own, so [`conferencing.profile_id: "integrated"`](events.md#api-conferencing) is accepted there: a Google calendar, and a Microsoft calendar that allows online meetings, when your application can write to it ([provider table](providers.md#providers-features)). `calendar_attachments_available` is false for every calendar.
