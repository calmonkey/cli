// The tool's own error codes, for `calmonkey explain <code>`. The API's 422 keys are in
// src/generated/errors.json, made from the documentation.

export const CLI_CODES: Record<string, { means: string; fix: string }> = {
  not_signed_in: { means: "This machine has no sign-in for CalMonkey, or it ran out or was disconnected in the dashboard (AI clients).", fix: "A person runs `calmonkey login` in a terminal: it opens a browser where they sign in and press Connect. An agent cannot do this step; ask the person." },
  config_not_writable: { means: "The sign-in lasts an hour and is then refreshed, which writes the tool's folder (~/.config/calmonkey). Inside a sandbox that cannot write there (Codex's default) it is not refreshed, because the new tokens could not be kept.", fix: "A person runs `calmonkey status` once in their own terminal, or Codex is started with -c 'sandbox_workspace_write.writable_roots=[\"<the folder>\"]'." },
  network_blocked: { means: "The command runs inside the Codex sandbox, which has no network unless it is switched on.", fix: "Ask the person to approve network for the command, or start Codex with `-c sandbox_workspace_write.network_access=true`." },
  network: { means: "CalMonkey could not be reached: no connection, a proxy in the way, or the address is wrong.", fix: "`calmonkey doctor` checks the addresses and the sign-in. Behind a proxy set HTTPS_PROXY." },
  timeout: { means: "No answer came in 20 seconds. A write may or may not have gone through.", fix: "Run the `check:` command of the error. Reads and event writes are safe to run again: an event is keyed by its id." },
  invalid_local_time: { means: "A date or time was given without a time zone. The machine's zone is never assumed: a cloud sandbox runs in UTC, and the event would land on the wrong day.", fix: "Add `--tz Australia/Melbourne` (the zone of the calendar's owner), or put CALMONKEY_TZ in the env file." },
  nonexistent_local_time: { means: "The clocks go forward over that time on that day in that zone, so it never happens.", fix: "Choose a time that exists; the error names the first one after the change." },
  invalid_time: { means: "Not a date or time this tool reads.", fix: "Use 2026-11-03, 2026-11-03T10:00 with --tz, or 2026-11-03T10:00:00+11:00. Reads also take today, tomorrow, +7d, -2d." },
  invalid_zone: { means: "Not a time zone name.", fix: "Use an IANA name: Australia/Melbourne, Europe/London, America/New_York, Etc/UTC." },
  weekday_mismatch: { means: "The start is not on the day of the week the command says (--on or --weekday). A weekly series starts on one of its own days.", fix: "Move --start to the date in the error's fix line, or change --on." },
  not_an_occurrence: { means: "The day named is not one the series has. A skipped or changed occurrence is named by its original date.", fix: "`calmonkey events get <id>` shows the rule; the error lists the first days." },
  account_required: { means: "The application has more than one account (or none), so the command will not guess which calendar owner is meant.", fix: "Add `--account <id>` from the error's list or `calmonkey accounts list`. With none: `calmonkey calendars open-test`." },
  calendar_required: { means: "The account has more than one calendar that can be written to (or none).", fix: "Add `--calendar <id>` from the error's list or `calmonkey calendars list`." },
  application_required: { means: "The organization has more than one application and the project names none.", fix: "Add `--app <client id>`, or run `npx calmonkey init` so CALMONKEY_CLIENT_ID is in the env file." },
  ambiguous_id: { means: "A shortened id fits more than one thing.", fix: "Use the whole id; `--json` prints whole ids." },
  event_not_found: { means: "This application has written no event with that id in that calendar. Events other people or applications wrote can be read (by evt_… id) and never changed.", fix: "`calmonkey events list --ours` shows what can be changed." },
  confirmation_needed: { means: "Deleting an event, a write that makes the calendar email guests, and any write to a live application are described first and change nothing. Exit code 10.", fix: "Show the `would:` lines to the person. Only after they agree, run the printed command with its --confirm token (valid once, 10 minutes, for exactly that command)." },
  confirmation_invalid: { means: "The --confirm token is used up, older than 10 minutes, from another sign-in, or the command differs from the one that was described.", fix: "Run the command without --confirm to get a new description and token." },
  forbidden: { means: "The sign-in may not do this: a live application that was not included when signing in, or a read-only member trying to write.", fix: "The message says which. Live applications are chosen on the approval page of `calmonkey login`, by an owner or admin." },
  too_large: { means: "The answer is over 24 KB, more than an agent keeps of one command's output.", fix: "Add `--output <file>` and read the file in parts, or narrow with --limit, --fields, --from/--to." },
  invalid_file: { means: "--from-file must be one JSON object whose keys are an event's own fields, at most 256 KB. Its content is never shown.", fix: "`calmonkey events get <id> --as-put` prints a body of the right shape." },
  unknown_command: { means: "No such command.", fix: "`calmonkey --help` lists them all on one screen." },
  unknown_flag: { means: "The command has no such flag.", fix: "`calmonkey <command> --help` lists its flags with examples." },
  rate_limited: { means: "Too many calls in a short time from this sign-in.", fix: "Wait the seconds named and run the same command again." },
};
