#!/usr/bin/env bash
# CalMonkey quickstart with curl: open an application calendar, list its calendar, write an
# event under your own event_id, read it back in free/busy, then delete it.
#
# An application calendar is hosted by CalMonkey and opened with your client credentials
# alone, so this needs no Google, Microsoft or Apple account and no browser.
#
#   CALMONKEY_CLIENT_ID      your application's client id          (required)
#   CALMONKEY_CLIENT_SECRET  your application's client secret      (required)
#   CALMONKEY_API_URL        the API host (default https://api.calmonkey.com)
#
# Usage: load the two credentials from your environment file, then
#   bash quickstart.sh
#
# The secret and the tokens are never printed, and never appear on a command line.
set -euo pipefail

: "${CALMONKEY_CLIENT_ID:?Set CALMONKEY_CLIENT_ID (the application page in the dashboard shows it)}"
: "${CALMONKEY_CLIENT_SECRET:?Set CALMONKEY_CLIENT_SECRET in your environment file}"
API="${CALMONKEY_API_URL:-https://api.calmonkey.com}"
API="${API%/}"
EVENT_ID="skill-quickstart-sh"

# Reads cover 42 days back to 201 days ahead, so the event goes on tomorrow (UTC).
# BSD date (macOS) and GNU date (Linux) spell "a day from now" differently.
day_from_now() { date -u -v+"$1"d +%Y-%m-%d 2>/dev/null || date -u -d "+$1 day" +%Y-%m-%d; }
DAY="$(day_from_now 1)"
NEXT_DAY="$(day_from_now 2)"

# The first string value of a key in a JSON answer.
field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -n 1; }

# Sends a request and leaves the body in $BODY and the status in $STATUS.
call() {
  local out
  out="$(curl -sS -w '\n%{http_code}' "$@")"
  STATUS="${out##*$'\n'}"
  BODY="${out%$'\n'*}"
}

expect() {
  if [ "$STATUS" != "$1" ]; then
    echo "  expected $1, got $STATUS" >&2
    [ "$STATUS" = "422" ] && echo "  $BODY" >&2
    exit 1
  fi
}

echo "1. POST /v1/application_calendars"
# The body goes in on standard input, so the secret is not in the process list.
call -X POST "$API/v1/application_calendars" -H "Content-Type: application/json" --data-binary @- <<JSON
{"client_id":"$CALMONKEY_CLIENT_ID","client_secret":"$CALMONKEY_CLIENT_SECRET","application_calendar_id":"skill-quickstart"}
JSON
expect 200
ACCESS_TOKEN="$(printf '%s' "$BODY" | field access_token)"
echo "   $STATUS  account $(printf '%s' "$BODY" | field sub)"

# The token goes to curl in a header file, for the same reason.
AUTH="$(mktemp)"
trap 'rm -f "$AUTH"' EXIT
printf 'Authorization: Bearer %s\n' "$ACCESS_TOKEN" >"$AUTH"

echo "2. GET /v1/calendars"
call "$API/v1/calendars" -H @"$AUTH"
expect 200
CALENDAR_ID="$(printf '%s' "$BODY" | field calendar_id)"
echo "   $STATUS  calendar $CALENDAR_ID"

echo "3. POST /v1/calendars/$CALENDAR_ID/events"
call -X POST "$API/v1/calendars/$CALENDAR_ID/events" -H @"$AUTH" -H "Content-Type: application/json" --data-binary @- <<JSON
{
  "event_id": "$EVENT_ID",
  "summary": "CalMonkey quickstart",
  "description": "Written by quickstart.sh",
  "start": "${DAY}T03:00:00Z",
  "end": "${DAY}T04:00:00Z",
  "tzid": "Australia/Melbourne"
}
JSON
expect 202
echo "   $STATUS  accepted (the body is empty; the event can be read at once)"

echo "4. GET /v1/free_busy"
# include_managed=true: events your own application wrote are left out without it.
# include_ids=true adds your event_id to them.
call -G "$API/v1/free_busy" -H @"$AUTH" \
  --data-urlencode "tzid=Etc/UTC" \
  --data-urlencode "from=$DAY" \
  --data-urlencode "to=$NEXT_DAY" \
  --data-urlencode "include_managed=true" \
  --data-urlencode "include_ids=true"
expect 200
if printf '%s' "$BODY" | grep -q "\"event_id\"[[:space:]]*:[[:space:]]*\"$EVENT_ID\""; then
  echo "   $STATUS  the event is busy time on $DAY, 03:00 to 04:00 UTC"
else
  echo "   $STATUS  but the event is not in the answer" >&2
  exit 1
fi

echo "5. DELETE /v1/calendars/$CALENDAR_ID/events"
call -X DELETE "$API/v1/calendars/$CALENDAR_ID/events" -H @"$AUTH" -H "Content-Type: application/json" --data-binary "{\"event_id\":\"$EVENT_ID\"}"
expect 202
echo "   $STATUS  deleted"

echo "Done."
