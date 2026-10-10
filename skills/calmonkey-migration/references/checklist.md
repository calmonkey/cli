# Migration checklist

Tick these off in order. Each line comes from [switching.md](switching.md), [compatibility.md](compatibility.md) or [differences.md](differences.md), which say why.

## The code

- [ ] Every endpoint the project calls is in the compatible list ([compatibility.md](compatibility.md#compatibility-compatible)).
- [ ] Nothing depends on a product outside the compatible set ([compatibility.md](compatibility.md#compatibility-other-products)).
- [ ] The API host and the app host come from settings (or the client library's equivalents), not from a data centre name.
- [ ] No check that a callback or API URL ends in the old provider's domain is left.
- [ ] The webhook callback URL is https on port 443 on a public host.
- [ ] Webhook verification uses the client secret from settings.
- [ ] Every recurring event's start is itself an occurrence of its rule ([differences.md](differences.md#compatibility-differences)).
- [ ] The code handles a `401` by refreshing the token and repeating the request once, and an `invalid_grant` on refresh by asking the user to connect again.

## The CalMonkey application

- [ ] An application exists in the dashboard, and its client id and client secret are in the environment file (put there by the person, not pasted into a conversation).
- [ ] The redirect URIs are registered exactly as the code sends them.
- [ ] Compatibility mode is on for this application.

## Testing

- [ ] The integration runs against an application calendar: open it, list calendars, write an event, read free/busy with `include_managed=true`, delete the event.
- [ ] A webhook notification arrives and passes verification with the new client secret.
- [ ] One real account per provider the product offers has been connected and read.

## Moving the users

- [ ] For each existing connection, before the switch: the events written through the old service are deleted, its channels are closed and its token there is revoked.
- [ ] Each connection is marked as needing to reconnect, and the user sees a short message asking them to connect their calendar again.
- [ ] After a user reconnects, their upcoming events are written again (writes are idempotent by `event_id`) and a channel is created for the new account.
