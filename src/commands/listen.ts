import { ApiError, listApplications, listenRound, type Notification, type Report } from "../api.js";
import { CliError, type Context } from "../context.js";
import { findInEnvFiles } from "../envfile.js";
import { NetworkError, describeNetworkError, request } from "../http.js";
import { NotSignedInError } from "../oauth.js";
import type { Ui } from "../ui.js";

// `calmonkey listen`: brings a test-mode application's webhook notifications to this machine.
//
// A test-mode application may register a callback URL such as
// http://localhost:3000/webhooks/calmonkey. CalMonkey cannot call that from its servers, so it
// holds those notifications; this command collects them over the sign-in's connection (a long
// poll: it waits up to 25 seconds per call for something to arrive) and posts each one to the
// address on this machine, with the body and every header exactly as CalMonkey made them.
// The signatures are CalMonkey's own, so the code that verifies them is exercised for real.
// What the local endpoint answers is reported back and decides what happens next, as it would
// in production: 2xx is delivered, 410 closes the channel, anything else is retried later.

export type ListenOptions = { forwardTo?: string; app?: string; envFile?: string };

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** Is this an address on this machine? The only kind a notification is posted to unless `--forward-to` says otherwise. */
export function isLocalUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && LOOPBACK.has(url.hostname) && !url.username && !url.password;
  } catch {
    return false;
  }
}

export function forwardTarget(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`--forward-to is not a URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CliError("--forward-to must be an http:// or https:// address.");
  return url.toString();
}

const clock = () => new Date().toLocaleTimeString("en-GB", { hour12: false });

// Set by fetch itself, or meaningless on a second hop.
const SKIPPED_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding", "accept-encoding"]);

/** Posts one notification to the local address and says what came back. Never throws: no answer is an answer too. */
export async function forward(ctx: Context, n: Notification, target: string, signal?: AbortSignal): Promise<Report> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(n.headers)) if (!SKIPPED_HEADERS.has(name.toLowerCase())) headers[name] = value;
  try {
    // The server's sender follows no redirect and allows a few seconds; the same here, a little more patient for a debugger.
    const res = await request(ctx, target, { method: "POST", headers: { ...headers, Accept: "*/*" }, body: n.body, timeoutMs: 30_000, redirect: "manual", signal });
    return { delivery_id: n.delivery_id, attempt: n.attempt, status: res.status };
  } catch (error) {
    const reason = error instanceof NetworkError ? describeNetworkError(error.original, target) : error instanceof Error ? error.message : "no answer";
    return { delivery_id: n.delivery_id, attempt: n.attempt, status: 0, error: reason.slice(0, 200) };
  }
}

export async function runListen(ctx: Context, ui: Ui, opts: ListenOptions, signal: AbortSignal): Promise<number> {
  const forwardTo = forwardTarget(opts.forwardTo);
  const ref = opts.app ?? findInEnvFiles(ctx.cwd, "CALMONKEY_CLIENT_ID", opts.envFile ? [opts.envFile] : [])?.value;
  let applicationId = ref;
  if (!applicationId) {
    const tests = (await listApplications(ctx)).applications.filter((a) => a.mode === "test");
    if (tests.length !== 1) throw new CliError(`Which application? ${tests.length ? `Pass --app with one of: ${tests.map((a) => `${a.client_id} (${a.name})`).join(", ")}.` : "This organization has no test-mode application. Run: npx calmonkey init"}`);
    applicationId = tests[0]!.client_id;
  }

  let reports: Report[] = [];
  let announced = false;
  let failures = 0;
  while (!signal.aborted) {
    let round;
    try {
      // With reports to hand in the call returns at once; otherwise it waits for a notification.
      round = await listenRound(ctx, { application_id: applicationId, reports, wait_seconds: 25 }, signal);
      reports = [];
      failures = 0;
    } catch (error) {
      if (signal.aborted) break;
      if (error instanceof NotSignedInError) throw error;
      if (error instanceof ApiError) {
        if (error.status === 404) throw new CliError(`No test-mode application “${applicationId}” in this organization. ${error.message}`);
        if (error.status === 403) throw new CliError(error.message);
        if (error.status !== 429 && error.status < 500) throw error;
      } else if (!(error instanceof NetworkError)) throw error;
      // The network, or CalMonkey for a moment: wait and go on. Unreported answers are kept and sent with the next call.
      failures++;
      const wait = Math.min(30, 2 ** Math.min(failures, 5));
      ui.warn(`${clock()}  ${error instanceof Error ? error.message : "Lost the connection."} Trying again in ${wait} s.`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, wait * 1000);
        signal.addEventListener("abort", () => (clearTimeout(timer), resolve(undefined)), { once: true });
      });
      continue;
    }
    if (!announced) {
      announced = true;
      ui.ok(`Ready. Listening for test-mode notifications of “${round.application.name}” ${ui.paint("dim", "(Ctrl+C to stop)")}`);
      ui.detail(forwardTo ? `Every notification goes to ${forwardTo}` : "Each notification goes to its channel's own callback URL on this machine.");
      if (!round.local_channels) ui.detail(ui.paint("dim", "No channel with a local callback URL yet. Create one with POST /v1/channels and callback_url http://localhost:<port>/<path>."));
    }
    for (const n of round.notifications) {
      if (signal.aborted) break;
      const target = forwardTo ?? n.callback_url;
      ui.out(`${ui.paint("dim", clock())}  -->  ${n.type} ${ui.paint("dim", `[${n.delivery_id}${n.attempt > 1 ? `, attempt ${n.attempt}` : ""}]`)}`);
      // CalMonkey only ever holds notifications for addresses on this machine; this is the check on our side of that promise.
      if (!forwardTo && !isLocalUrl(target)) {
        ui.warn(`${clock()}  Not sent: ${target} is not an address on this machine.`);
        reports.push({ delivery_id: n.delivery_id, attempt: n.attempt, status: 0, error: "not a local address" });
        continue;
      }
      const report = await forward(ctx, n, target, signal);
      if (signal.aborted) break;
      const ok = report.status >= 200 && report.status < 300;
      ui.out(`${ui.paint("dim", clock())}  <--  ${ui.paint(ok ? "green" : "red", `[${report.status || "no answer"}]`)} POST ${target}${report.error ? ui.paint("dim", `  ${report.error}`) : ""}`);
      reports.push(report);
    }
  }
  ui.out("\nStopped.");
  return 0;
}
