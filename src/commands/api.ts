import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { COMMON, flag, list, on, str, type Command } from "../command.js";
import { EXIT, Failure } from "../fail.js";
import { NetworkError, request } from "../http.js";
import { compact, print, redactJson, writeOutput } from "../out.js";
import { projectSetting } from "../project.js";
import { networkFailure } from "../tools.js";
import { write } from "./data.js";

// `calmonkey api`: one raw request to the API, for what no command covers (creating a channel,
// userinfo, a link token). It is sent the way the project's own server would send it: with the
// client id and secret of the env file, as an application calendar's account. The secret and
// every token stay inside this program; nothing of them is printed.
//
// Before anything is sent the server is asked (tool api_check, the same access and confirmation
// code as every other command): the application must be one this sign-in may use, a write needs
// an owner or admin, and a DELETE, a body that invites guests, or a live application is
// described first and sent only with --confirm.

const METHODS = ["GET", "POST", "PUT", "DELETE"];
const CREDENTIAL_PATHS = new Set(["/v1/application_calendars", "/oauth/token", "/oauth/token/revoke"]);

const apiCommand: Command = {
  name: "api",
  group: "other",
  summary: "One raw API request for what no command covers, sent with the project's own credentials as an application calendar (the secret and tokens are never shown). A DELETE or a body that invites guests is described first",
  operation: "tool api_check, then the request itself",
  usage: "<METHOD> <path>",
  write: true,
  flags: [
    flag.list("query", "<name=value>", "a query parameter"),
    flag.value("from-file", "<file|->", "the JSON body, from a file or stdin"),
    flag.value("as", "<calendar id>", "the application calendar whose account makes the call (default test-calendar-1)"),
    COMMON.output,
    COMMON.force,
    COMMON.dryRun,
    COMMON.confirm,
    COMMON.app,
  ],
  examples: ["calmonkey api GET /v1/userinfo", "calmonkey api GET /v1/events --query tzid=Australia/Melbourne --query from=2026-11-03", "calmonkey api POST /v1/channels --from-file channel.json"],
  seeAlso: "calmonkey schema <operationId> (fields of a call), calmonkey schema (every operation)",
  async run(input) {
    const { ctx, flags } = input;
    const method = (input.args[0] ?? "").toUpperCase();
    const route = input.args[1] ?? "";
    if (!METHODS.includes(method) || !/^\/(v1|oauth)\/[A-Za-z0-9_\-./]*$/.test(route) || route.includes("..")) {
      throw new Failure({ code: "bad_argument", message: "calmonkey api takes a method (GET, POST, PUT, DELETE) and an API path without a query string", exit: EXIT.usage, write: true, fix: ["calmonkey api GET /v1/calendars", "(query parameters: --query name=value; every path: calmonkey schema)"] });
    }
    const id = str(flags, "app") ? { value: str(flags, "app")! } : projectSetting(ctx, "CALMONKEY_CLIENT_ID");
    const secret = projectSetting(ctx, "CALMONKEY_CLIENT_SECRET");
    const bearer = ctx.env.CALMONKEY_ACCESS_TOKEN?.trim();
    if (!id || (!secret && !bearer)) throw new Failure({ code: "no_credentials", message: `this project's env file has no ${id ? "CALMONKEY_CLIENT_SECRET" : "CALMONKEY_CLIENT_ID"}, which a raw API call is made with`, exit: EXIT.usage, write: true, fix: ["npx calmonkey init   (writes both; the secret goes straight into the file)"] });

    let body: Record<string, unknown> | undefined;
    const file = str(flags, "from-file");
    if (file !== undefined) {
      let text: string;
      if (file === "-") text = ctx.stdin.isTTY ? "" : readFileSync(0, "utf8");
      else {
        const full = path.resolve(ctx.cwd, file);
        if (!existsSync(full) || !statSync(full).isFile() || statSync(full).size > 256 * 1024) throw new Failure({ code: "invalid_file", message: "--from-file names no file of at most 256 KB", exit: EXIT.usage, write: true });
        text = readFileSync(full, "utf8");
      }
      try {
        const parsed: unknown = JSON.parse(text);
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
        body = parsed as Record<string, unknown>;
      } catch {
        throw new Failure({ code: "invalid_file", message: "--from-file must hold one JSON object (its content is not shown)", exit: EXIT.usage, write: true });
      }
      if ("client_secret" in body || "client_id" in body) throw new Failure({ code: "invalid_file", message: "leave client_id and client_secret out of the body: the tool adds the project's own where a call needs them", exit: EXIT.usage, write: true });
    }
    if (method === "GET" && body) throw new Failure({ code: "bad_flag", message: "a GET has no body: use --query name=value", exit: EXIT.usage, write: true });
    const query = new URLSearchParams();
    for (const pair of list(flags, "query")) {
      const at = pair.indexOf("=");
      if (at < 1) throw new Failure({ code: "bad_flag", message: "--query is name=value, e.g. --query tzid=Australia/Melbourne", exit: EXIT.usage, write: true });
      query.append(pair.slice(0, at), pair.slice(at + 1));
    }
    const attendees = body?.attendees as { invite?: unknown[] } | undefined;
    const invites = Array.isArray(attendees?.invite) && attendees.invite.length > 0 && body?.notify_attendees !== false;
    const url = `${ctx.endpoints.api}${route}${[...query].length ? `?${query}` : ""}`;
    const as = str(flags, "as") ?? "test-calendar-1";
    if (on(flags, "dry-run")) {
      print(ctx, `dry run: would send ${method} ${route}${[...query].length ? `?${query}` : ""}${body ? ` with a body of ${Object.keys(body).length} field${Object.keys(body).length === 1 ? "" : "s"} (${Object.keys(body).join(", ")})` : ""} as application calendar ${JSON.stringify(as)}; nothing was sent`);
      return EXIT.ok;
    }

    return write<{ api_url: string; application: string; mode: string }>(input, "api_check", { application_id: id.value, method, path: route, ...(invites ? { invites_guests: true } : {}), ...(body ? { body_sha256: createHash("sha256").update(JSON.stringify(body)).digest("hex") } : {}) }, {
      done: () => void 0,
    }).then(async (code) => {
      if (code !== EXIT.ok) return code;
      try {
        const credentials = { client_id: id.value, client_secret: secret?.value };
        let headers: Record<string, string> = {};
        let json: unknown = body;
        if (CREDENTIAL_PATHS.has(route)) json = { ...credentials, ...body };
        else {
          let token = bearer;
          if (!token) {
            const opened = await request(ctx, `${ctx.endpoints.api}/v1/application_calendars`, { json: { ...credentials, application_calendar_id: as } });
            token = (opened.json as { access_token?: string } | undefined)?.access_token;
            if (opened.status !== 200 || !token) throw new Failure({ code: opened.status === 401 ? "bad_credentials" : `http_${opened.status}`, message: opened.status === 401 ? "the API does not accept this project's client id and secret" : `opening the application calendar answered ${opened.status}`, http: opened.status, exit: EXIT.failed, write: true, fix: ["calmonkey doctor"] });
          }
          headers = { Authorization: `Bearer ${token}` };
        }
        const res = await request(ctx, url, { method: method as "GET", headers, ...(json !== undefined && method !== "GET" ? { json } : {}) });
        const requestId = res.headers.get("calmonkey-request-id");
        const head = `HTTP ${res.status} ${method} ${route}${requestId ? ` | request ${requestId}` : ""}${CREDENTIAL_PATHS.has(route) ? "" : bearer ? " | with CALMONKEY_ACCESS_TOKEN" : ` | as application calendar ${JSON.stringify(as)}`}`;
        const shown = res.json !== undefined ? compact(redactJson(res.json)) : undefined;
        const output = str(flags, "output");
        if (output && shown !== undefined) {
          print(ctx, head);
          writeOutput(ctx, output, shown, "the answer", Object.keys(shown as object).slice(0, 12), on(flags, "force"));
        } else print(ctx, shown !== undefined ? `${head}\n${JSON.stringify(shown)}` : `${head}${res.text ? `\n${res.text.slice(0, 2000)}` : "\n(empty body)"}`, { explicit: true, argv: input.argv });
        return res.status < 300 ? EXIT.ok : res.status === 404 ? EXIT.notFound : res.status === 403 ? EXIT.notAllowed : res.status === 422 ? EXIT.refused : res.status === 429 ? EXIT.rateLimited : EXIT.failed;
      } catch (error) {
        if (error instanceof NetworkError) throw networkFailure(ctx, error, { write: method !== "GET" });
        throw error;
      }
    });
  },
};

export const API_COMMANDS: Command[] = [apiCommand];
