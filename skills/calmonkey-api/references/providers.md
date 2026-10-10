# Providers

What each calendar provider asks of your users, what each calendar does with guests, repeating events and meeting links, and how quickly changes arrive.

> Made from the CalMonkey documentation (https://calmonkey.com/docs/providers.md). Changes go to the documentation, not to this file.

## Contents

- [At a glance](#providers-overview)
- [Guests, repeating events and meeting links](#providers-features)
- [How fresh the data is](#providers-freshness)
- [Google Calendar](#providers-google)
- [Microsoft 365 and Outlook.com](#providers-microsoft)
- [Apple iCloud](#providers-apple)
- [Application calendars](#providers-application-calendars)

<a id="providers-overview"></a>

## At a glance

| Provider | `provider_name` | How the user connects | How changes reach CalMonkey |
| --- | --- | --- | --- |
| Google Calendar | `google` | Google sign-in and consent | Push from Google |
| Microsoft 365 (work or school) | `office365` | Microsoft sign-in and consent | Push from Microsoft Graph |
| Outlook.com, Hotmail, Live | `live_connect` | Microsoft sign-in and consent | Push from Microsoft Graph |
| Apple iCloud | `apple` | Apple ID and an app-specific password, on a CalMonkey form | Polling every 5 minutes |

Your code is the same for all of them: the same endpoints, fields and notifications. Pass `provider_name` to `/oauth/authorize` to skip the chooser.

<a id="providers-features"></a>

## Guests, repeating events and meeting links

The fields are the same for every calendar ([guests](events.md#api-guests), [repeating events](events.md#api-recurrence), [meeting links](events.md#api-conferencing)). Invitations and meeting links are made by the calendar’s own service, so what happens depends on the calendar:

| Calendar | Writing `attendees` | With `notify_attendees: false` | Read back | Repeating events | Meeting link (`conferencing`) |
| --- | --- | --- | --- | --- | --- |
| Google Calendar | Google sends the invitation, updates and the cancellation | Guests are put on the event and nobody is emailed | Guests, organiser and replies | Yes | Google Meet |
| Microsoft 365 | Microsoft Exchange sends the invitation, updates and the cancellation | 422 errors.notify_attendees_unsupported: Exchange always tells guests | Guests, organiser and replies | Yes | Microsoft Teams, on calendars that allow online meetings |
| Outlook.com | Outlook.com sends the invitation, updates and the cancellation | 422 errors.notify_attendees_unsupported: Outlook.com always tells guests | Guests, organiser and replies | Yes | Microsoft Teams |
| Apple iCloud | iCloud sends Apple’s invitation, an update when the time or place changes, and the cancellation | Guests are put on the event and nobody is emailed. Decided when the event first gets guests | Guests, organiser, and replies given from Apple’s invitation | Yes | None: default writes the event without a link, integrated answers 422 |
| Application calendar | 422 errors.attendees_unsupported: an application calendar has no mail service | Guests are stored and returned, and nobody is emailed | The guests you stored, as needs_action | Yes | None: default writes the event without a link, integrated answers 422 |

- **Invitations** come from the person’s own calendar account, in Google’s, Microsoft’s or Apple’s own format, with their name as the organiser. CalMonkey sends no email itself. Guests answer in their own calendar or mail, and the answer shows as the attendee’s `status` in your next read (for an iCloud calendar, see [Apple iCloud](#providers-apple)).
- **Repeating events** work the same everywhere: a whole series, one skipped occurrence, one changed occurrence. A series repeats in local time in its time zone, across changes of the clocks. Your application can change the series it wrote; a series the person made in their own calendar is read as its occurrences.
- **Meeting links** are the calendar’s own: a Google Meet link belongs to the Google event, a Teams link to the Microsoft one. Events the person made with a link of their own are read with it too.
- Whatever a calendar answers with `422` is refused before anything is written, so an event is never half made.

<a id="providers-freshness"></a>

## How fresh the data is

- CalMonkey keeps a copy of each calendar’s events from **42 days back to 201 days ahead**. Free/busy and event reads are answered from it, so they are fast and look the same for every provider. Events outside that window are not kept.
- Calendars your application uses are kept current: Google and Microsoft tell CalMonkey about changes as they happen (with a full check every hour as a safety net), and iCloud is asked every 5 minutes. A change in the person’s calendar reaches you as a `change` notification.
- A calendar nobody has read or written for 14 days is left idle. Reading it again brings it up to date: if its copy is older than 2 minutes (30 minutes while push is on), CalMonkey checks the provider during your request, for up to 4 seconds, then answers.
- The list of calendars is refreshed daily, and read straight away when someone connects.
- Your writes are visible in your reads at once; the write to the provider follows within moments and is retried if the provider is unavailable. Changes your application makes are never notified back to it.

<a id="providers-google"></a>

## Google Calendar

- Permissions asked: see and edit events (`calendar.events`) and see the list of calendars (`calendar.calendarlist.readonly`), plus the person’s email address to name the profile. Nothing else in their Google account.
- Google lets people untick permissions on the consent screen. If either calendar permission is missing, nothing is connected and the hosted page asks them to try again with both ticked.
- The consent screen names CalMonkey, because the connection goes through CalMonkey’s Google OAuth app.
- Cancelled events and working-location entries are left out. Invitations the person declined are returned by `GET /v1/events` with `participation_status: "declined"` and never count as busy.
- Guests: Google emails the invitation, every update and the cancellation. Google keeps each guest’s answer through your later writes, and asks guests to answer again when the event’s time changes.
- Meeting links are Google Meet links, made by Google for the event and returned as `provider_name: "google_meet"`.
- `provider_service` is `gmail` for gmail.com and googlemail.com addresses and `gsuite` for every other domain.
- When the account is disconnected, CalMonkey revokes its access at Google too, unless the same person is still connected through another application that uses the same Google app.

<a id="providers-microsoft"></a>

## Microsoft 365 and Outlook.com

- One sign-in for both. `office365` sends people to the work or school sign-in, `live_connect` to the personal one; from the chooser they pick. The profile’s `provider_name` follows the account they actually signed in with.
- Permissions asked: read and write calendars (`Calendars.ReadWrite`), keep access (`offline_access`), and the sign-in basics (`openid email profile`).
- **Work accounts that need admin approval.** Many organisations do not let their people approve applications themselves. Microsoft then stops the person on its own page, “Need admin approval”. When they come back, CalMonkey’s hosted page tells them that an administrator of their organisation (usually their IT team) has to approve CalMonkey for calendar access, and shows a link to send to that administrator. The administrator opens the link, signs in and accepts once for the whole organisation; after that everyone in it can connect, and the person presses “Try again”. Nothing is connected until then. If the person gives up instead, your `redirect_uri` gets `error=access_denied` with an `error_description` that says an administrator must approve the application. If your customers are such organisations, tell their IT team in advance.
- Events shown as free or “working elsewhere” are `transparent`, tentative ones `tentative`; busy and out of office block time. Cancelled events are left out. Invitations the person declined are returned by `GET /v1/events` with `participation_status: "declined"` and never count as busy.
- Guests: Microsoft sends the invitation, every update and the cancellation, and always does: an event with guests cannot be written or deleted with `notify_attendees: false` (`422`, `errors.notify_attendees_unsupported`).
- Meeting links are Microsoft Teams links (`provider_name: "ms_teams"`), on calendars that allow online meetings. Microsoft also writes the join details into the event’s description in the person’s calendar; your reads return the description you wrote.
- A repeating event with a time is written in its own time zone, so it shows at the same local time in Outlook all year.
- When the person deletes or moves one occurrence of your series in Outlook and your application later moves the whole series, their occurrence stays deleted, or stays at the time they gave it, unless your write says something else about that day. An occurrence they only renamed follows the series and takes its text again.
- On-premises Exchange servers are not supported, only Microsoft 365 and Outlook.com.
- Microsoft offers applications no way to withdraw their own access. On disconnect CalMonkey deletes its copy of the tokens; the app stays listed among the apps with access in the person’s Microsoft account until they remove it.

<a id="providers-apple"></a>

## Apple iCloud

Apple has no OAuth for iCloud calendars. People connect with their Apple ID and an **app-specific password** on a CalMonkey form, which walks them through creating one at [account.apple.com](https://account.apple.com) (formerly appleid.apple.com): two-factor authentication must be on, then Sign-In and Security, App-Specific Passwords.

> <a id="providers-apple-disclosure"></a>
>
> ### What your users must know
>
> - **An app-specific password is not limited to calendars.** Apple gives it the same reach as any app the person signs in to with their Apple ID, which includes iCloud Mail and Contacts. Apple offers nothing narrower.
> - CalMonkey uses it only to read and write their iCloud calendars, and only sends it to Apple’s iCloud servers. It is stored encrypted (AES-256, with keys held in a hardware-backed key management service), never logged, and never shown to you, the application.
> - **They can end it at any time:** at account.apple.com, Sign-In and Security, App-Specific Passwords, remove it. The connection stops at the next check (within 5 minutes for a calendar in use): the profile shows `profile_connected: false` and you get `profile_disconnected`. Changing the Apple ID password removes every app-specific password too.
> - Disconnecting in your product deletes CalMonkey’s copy of the password, but Apple has no way for us to remove it from their Apple account: it stays listed there until they remove it. Say so in your disconnect screen.
>
> The CalMonkey form says all of this before the person types anything. Do not soften it in your own help pages.

- The form refuses anything that is not 16 letters without sending it anywhere, which catches someone typing their normal Apple ID password. It says plainly when Apple refuses the password, when the Apple ID has no iCloud calendar yet, and when iCloud is unreachable.
- Attempts are limited per connect run, per Apple ID and per network address, so the form cannot be used to guess passwords or get an Apple ID locked.
- Managed Apple IDs from schools and businesses usually cannot create app-specific passwords.
- Changes are found by polling: every 5 minutes for accounts with a calendar in use, every 30 minutes otherwise. A change made in Apple’s Calendar can take a few minutes longer to reach you than with Google or Microsoft.
- Reminder lists and subscribed calendars are not listed. Calendars shared to the person read-only are read-only here too.
- Repeating events are written as one iCloud event with its rule, its skipped days and its changed occurrences, so your write of a series replaces the whole series.
- iCloud calendars: guests receive Apple’s own invitation email, and an update when the time or place changes or the event is cancelled. Changes to the title or description are not sent. A guest’s answer is read back when they answer from Apple’s invitation.
- The invitation names the person’s Apple account as the organiser, with the name and address Apple holds for it. When the time or the place of an event changes, iCloud asks every guest to answer again: their `status` goes back to `needs_action`. A new title or description keeps the answers.
- Whether guests are told is decided when an event first gets guests: with `notify_attendees: false` they are put on the event and iCloud emails nobody, then or later. Writes and deletes that leave `notify_attendees` out keep the event as it is, and one that says the opposite answers `422` with `errors.notify_attendees_cannot_change`. To change it, delete the event and create it again.
- Guests, organisers and replies on events the person made themselves are read. iCloud has no meeting links of its own.

<a id="providers-application-calendars"></a>

## Application calendars

Calendars hosted by CalMonkey itself, with `provider_name` `calmonkey` (another name in [compatibility mode](https://calmonkey.com/docs/compatibility.md#mode)). They need no user and no provider, and are always up to date. See the [quickstart](application-calendars.md#quickstart-application-calendars). Repeating events work as on any calendar. An application calendar has no mail service behind it, so guests are stored and returned when you write them with `notify_attendees: false`, and nobody is emailed.
