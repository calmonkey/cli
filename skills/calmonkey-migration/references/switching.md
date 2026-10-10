# Switching, step by step

The order to do things in when an existing client moves to CalMonkey.

> Made from the CalMonkey documentation (https://calmonkey.com/docs/compatibility.md). Changes go to the documentation, not to this file.

<a id="compatibility-steps"></a>

## Switching, step by step

1. **Create an application** in the [dashboard](https://app.calmonkey.com/dashboard). Copy the client id and the client secret (shown once).
2. **Register your redirect URIs**, exactly as your code sends them, and turn on compatibility mode.
3. **Point your client at CalMonkey.** If it reads the hosts from settings, that is four values (under the names your code already reads):

   ```sh
   CALENDAR_CLIENT_ID=<your CalMonkey client id>
   CALENDAR_CLIENT_SECRET=<your CalMonkey client secret>
   CALENDAR_API_HOST=https://api.calmonkey.com
   CALENDAR_SITE_HOST=https://app.calmonkey.com
   ```

   The API host replaces your current API host; the app host replaces the host your code sends people to for `/oauth/authorize`. If your code checks that callback or API URLs end in your current provider’s domain, change that check to compare with the CalMonkey hosts exactly.
4. **Check webhook verification** with the new client secret, and that your callback URL is https on port 443.
5. **Move your users.** Tokens cannot be carried over from another service: each user connects their calendar again through CalMonkey. Before switching, for each connection: delete the events you wrote through the old service, close its channels and revoke its token there; then mark the connection as needing to reconnect, and show the user a short message (“Calendar sync was upgraded. Connect your calendar again.”). When they reconnect, write their upcoming events again: writes are idempotent by `event_id`.
6. **Test first** with an [application calendar](https://calmonkey.com/docs/quickstart.md#application-calendars), which needs no browser, then with one real account per provider you offer.

> CalMonkey is hosted in Australia. There is no choice of data centre, so there is no data centre in the hostnames.
