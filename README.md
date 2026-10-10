# calmonkey

The command line tool for [CalMonkey](https://calmonkey.com), one calendar API for your users' Google Calendar, Microsoft 365, Outlook.com and Apple iCloud calendars.

One command sets CalMonkey up in a project:

```sh
npx calmonkey init
```

From then on you, and the AI coding agent you run in that folder, work with the calendar API by running `calmonkey` commands:

```sh
calmonkey status
calmonkey calendars open-test
calmonkey events put demo-1 --title Demo --start 2026-11-03T10:00 --duration 1h
calmonkey events list --from 2026-11-03 --to 2026-11-10
calmonkey freebusy --free --duration 45m --from 2026-11-03 --to 2026-11-10
calmonkey logs requests --errors
calmonkey docs search webhook signature
```

Node 20.12 or later. No install step, nothing to configure, no telemetry, no runtime dependencies.

## Built for AI coding agents

- **Short text by default**, the same for a person and a program; `--json` on request. A list of 20 events is about 785 tokens as text and 1,400 as `--json` (measured in `test/budgets.test.ts`, numbers in [docs/BUDGETS.md](docs/BUDGETS.md)). The first line says what the answer is and what was resolved; when there is more, the last line is the exact command that gets it.
- **An error carries its fix**: what is wrong, whether anything changed, and a corrected command. `calmonkey explain <code>` says more.
- **The tool does the arithmetic**: counts (`--count`), free slots for several people (`freebusy --free`), the weekday and UTC time of every date it prints.
- **A time needs a zone** (`--tz`, or `CALMONKEY_TZ` in the env file). The machine's own zone is never used silently.
- **Deleting, emailing guests and writing to a live application are confirmed first**: the command prints `NOT DONE: confirmation needed`, what it would do and the exact command to run once a person agrees, and exits with code 10. No flag skips it.
- **Other people's text is marked**: event titles in quotes on one line, everything else behind `| ` inside a block whose mark changes on every call. No command prints a secret.
- **It never waits for someone who is not there**: a signed-out command fails at once with what to do; nothing opens a browser or asks a question when an agent, CI or a pipe runs it.
- `calmonkey agent-guide` is the nine rules in twenty lines; `calmonkey --help` is one screen; every command has `--help` with examples.

Every command, with samples of its output: https://calmonkey.com/docs/cli.

Data commands reach CalMonkey through your sign-in and run the same functions as CalMonkey's MCP server, so what they may read and change is decided by the server: test-mode applications, unless live ones were included when signing in.

## What `init` does

Run it in your project folder. In order, it:

1. **Signs you in through the browser.** It opens app.calmonkey.com, where you sign in (or sign up) with Google or Microsoft, pick the organization and press **Connect**. The tool then shows in the dashboard under **AI clients** as "CalMonkey CLI", where it can be disconnected.
2. **Picks or creates a test-mode application.** It never uses a live application.
3. **Writes the environment file**: `CALMONKEY_CLIENT_ID`, `CALMONKEY_API_URL`, `CALMONKEY_APP_URL`, `CALMONKEY_TZ` (the time zone dates are read in: your machine's, shown first, or `--tz`) and `CALMONKEY_CLIENT_SECRET` into `.env.local` (or an existing `.env` when the project has no `.env.local`), and makes sure the file is git-ignored.
4. **Installs the CalMonkey skill** into the project and adds a short marked section to `AGENTS.md` (and to `CLAUDE.md` when the project has one: Claude Code reads `AGENTS.md` only in a project without a `CLAUDE.md`). They tell an AI coding agent to use the `calmonkey` command.
5. **Prints what to say to your AI assistant.**

With `--mcp` it also registers the MCP server `https://mcp.calmonkey.com/mcp` in the AI coding tools it finds. That is for tools that cannot run a command; an agent with a shell does not need it.

It shows what it will write and asks before writing. It never overwrites: a variable that already has a value, a server entry that points somewhere else and a skill file you edited are left as they are and reported. Running it again changes nothing.

```
  -y, --yes             ask nothing; take the safe default for every question
      --dry-run         show what would be written and change nothing
      --app <id|name>   use this test-mode application
      --name <name>     name for a new test-mode application
      --env-file <path> the environment file to write
      --no-secret       never fetch a client secret
      --rotate-secret   replace an existing application's client secret without asking
      --tz <zone>       the zone written as CALMONKEY_TZ (default: this machine's)
      --no-skills       skip the skill and AGENTS.md
      --mcp             also register the MCP server in the AI tools found
      --client <tool>   with --mcp, only these tools (repeatable): claude-code, cursor, vscode, codex, gemini, windsurf
      --no-browser      print the sign-in address instead of opening a browser
      --wait            without a terminal: print the address and wait for you to approve
```

Signing in needs a person at a browser. Without a terminal, in CI, or when an AI agent runs the command, `init` and `login` say so at once and stop (exit code 3); `--wait` makes them print the address and wait five minutes for you to press Connect.

### The client secret

The secret goes from CalMonkey into your environment file. It is never printed and never passes through an AI model.

- For an application `init` has just created, the secret is written straight into the file.
- For an existing application, a secret can only be shown when it is made. `init` asks "Replace the client secret?" first; saying yes makes a new one, and the old one keeps working for 24 hours. With `--yes` it is only replaced when you add `--rotate-secret`.
- Saying no leaves the line out and prints the page in the dashboard where the secret is.

This needs an owner or admin of the organization, and the tick "Client secrets of test applications" on the Connect page.

### Where the MCP server is registered

| Tool | File (in the project) | Entry |
|---|---|---|
| Claude Code | `.mcp.json` | `"mcpServers": { "calmonkey": { "type": "http", "url": "https://mcp.calmonkey.com/mcp" } }` |
| VS Code (GitHub Copilot) | `.mcp.json`, or `.vscode/mcp.json` under `"servers"` when the project already has that file | `{ "type": "http", "url": "…" }` |
| Cursor | `.cursor/mcp.json` | `"mcpServers": { "calmonkey": { "url": "…" } }` |
| Codex | `.codex/config.toml` | `[mcp_servers.calmonkey]` with `url = "…"` |
| Gemini CLI | `.gemini/settings.json` | `"mcpServers": { "calmonkey": { "httpUrl": "…" } }` |
| Windsurf (Devin Desktop) | `.devin/mcp_config.json` | `"mcpServers": { "calmonkey": { "url": "…" } }` |

A Windsurf from before it became Devin Desktop has no project file: there the entry goes into `~/.codeium/windsurf/mcp_config.json` (as `serverUrl`), and `init` says so before writing.

Existing files are added to, not rewritten: other servers, comments, indentation and line endings stay exactly as they were. No entry carries a key or a token: each tool signs in to CalMonkey itself the first time it uses the server.

- Claude Code: start `claude` in the folder, approve the project's MCP server, then run `/mcp`.
- Codex: start `codex` in the folder and trust the project (Codex reads a project's `.codex/config.toml` only then), then run `codex mcp login calmonkey`.
- Gemini CLI: start `gemini` in the folder, trust the folder when it asks, then run `/mcp auth calmonkey`.
- Cursor, VS Code, Windsurf: open the project and sign in when the tool asks.

Formats and locations are each vendor's own, from their documentation as of October 2026: [Claude Code](https://code.claude.com/docs/en/mcp), [Cursor](https://cursor.com/docs/mcp), [VS Code](https://code.visualstudio.com/docs/copilot/customization/mcp-servers), [Codex](https://developers.openai.com/codex/mcp), [Gemini CLI](https://geminicli.com/docs/tools/mcp-server/), [Devin Desktop](https://docs.devin.ai/desktop/cascade/mcp).

### The skill

`init` copies the `calmonkey-api` skill (from [calmonkey/skills](https://github.com/calmonkey/skills), bundled with this package) to:

- `.agents/skills/calmonkey-api/`, which Codex, Cursor, GitHub Copilot, Gemini CLI and Windsurf read;
- `.claude/skills/calmonkey-api/`, when Claude Code is in use.

The package also bundles `calmonkey-migration`, for moving an existing integration to CalMonkey's compatibility mode; `init` does not install it, so add it with `npx skills add calmonkey/skills --skill calmonkey-migration` when you need it. In `AGENTS.md` `init` keeps one section between `<!-- BEGIN:calmonkey -->` and `<!-- END:calmonkey -->`; nothing outside the markers is touched.

## Other commands

### `calmonkey listen`

Brings a test-mode application's webhook notifications to your machine.

```sh
calmonkey listen
calmonkey listen --forward-to http://localhost:3000/webhooks/calmonkey
```

A test-mode application may register a callback URL on your own machine, such as `http://localhost:3000/webhooks/calmonkey`, exactly as your code will register the https one in production. CalMonkey does not send those notifications itself: it holds them for up to 24 hours, and `calmonkey listen` collects them and posts each one to its callback URL with the body and every header as CalMonkey made them (`Calmonkey-Signature`, `Calmonkey-HMAC-SHA256`, `Calmonkey-Delivery-Id`, `Calmonkey-Delivery-Attempt`). The signatures are CalMonkey's own, so your verification code is exercised for real.

What your endpoint answers is reported back: 2xx is delivered, anything else is retried on the normal schedule, 410 closes the channel. `--forward-to` sends every notification to one address instead of each channel's own. The application is the project's `CALMONKEY_CLIENT_ID` unless you pass `--app`. It needs an owner or admin.

```
✓ Ready. Listening for test-mode notifications of “booking-app (dev)” (Ctrl+C to stop)
19:04:11  -->  verification [whd_5ba21743f408617d1269ea1e]
19:04:11  <--  [200] POST http://localhost:3000/webhooks/calmonkey
```

### `calmonkey doctor`

Checks, one line each: the Node version, the environment file, that the client credentials are accepted (with a token request that cannot succeed, so nothing is created or changed), the sign-in, that the MCP server answers, which AI tools have it registered, and the skill. Exit code 1 when something needs fixing.

### `calmonkey mcp add [--client <tool>]…`

Registers the MCP server in AI tools: what `init --mcp` adds. For tools that cannot run a command.

### `calmonkey login`, `calmonkey logout`

Sign in through the browser; end the connection at CalMonkey and remove the stored sign-in.

## How sign-in works

The tool is a public OAuth client: authorization code flow with PKCE (S256), the answer delivered to a port on `127.0.0.1` that exists for the length of the sign-in. It identifies itself with a client metadata document that CalMonkey publishes for it. No secret exists, and none is put in an address or on the command line.

The sign-in (an access token for an hour and a refresh token that is replaced each time it is used) is kept in one file readable by you only: `~/.config/calmonkey/credentials.json`, or `%APPDATA%\calmonkey\credentials.json` on Windows. The connection reaches test-mode applications, with your role in the organization and never more.

## Environment

| Variable | |
|---|---|
| `CALMONKEY_APP_URL`, `CALMONKEY_API_URL`, `CALMONKEY_MCP_URL` | Another CalMonkey than the live service (a local one, for instance) |
| `CALMONKEY_CONFIG_DIR` | Where the sign-in is kept |
| `CALMONKEY_TZ`, `CALMONKEY_CLIENT_ID` | The time zone and the application of a command, when the env file does not say (`--tz`, `--app` win) |
| `CALMONKEY_MODE` | `agent` or `human`: overrules the detection of an AI agent (which only stops questions, browsers and waiting; it never changes output) |
| `CALMONKEY_ACCESS_TOKEN` | For `calmonkey api`: call as this account instead of an application calendar. Never printed |
| `NO_COLOR` | No colour |
| `CI` | No questions are asked |
| `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY` | Honoured (Node 22.21 or later, or 24.5 or later) |

## Developing

```sh
npm ci
npm run lint && npm run typecheck && npm test    # unit tests: no network, no CalMonkey needed
npm run build                                    # dist/cli.js, one file
npm run test:e2e                                 # against a CalMonkey on this machine (below)
npm run skills:sync                              # refresh skills/ from a checkout of calmonkey/skills
npm run reference                                # docs/reference.json: the tool described by itself, for calmonkey.com/docs/cli
UPDATE_BUDGETS=1 npx vitest run test/budgets.test.ts   # docs/BUDGETS.md, after a deliberate change to help or output
```

The end-to-end test runs the built program against a real CalMonkey: `init` with the browser sign-in played over HTTP, the environment file with a secret that works, every tool's file, the skill, a second run that changes nothing, `doctor`, `listen` delivering a signed notification to a local endpoint, and `logout`. It needs a CalMonkey checkout with its development database running:

```sh
CALMONKEY_E2E_SERVER_DIR=../calmonkey npm run test:e2e                                    # starts CalMonkey itself
CALMONKEY_E2E_SERVER_DIR=../calmonkey CALMONKEY_E2E_URL=http://localhost:3080 npm run test:e2e   # uses a running one (started with WEBHOOK_RELAY=true)
```

Releases are published from GitHub Actions with npm trusted publishing: push a tag `v<version>` that matches `package.json`.

## Licence

MIT. © Swixy Pty Ltd.
