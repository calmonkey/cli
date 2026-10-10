import { ApiError, createApplication, listApplications, rotateSecret, type Application } from "../api.js";
import { displayPath } from "../clients/index.js";
import { CliError, type Context } from "../context.js";
import { chooseEnvFile, findInEnvFiles, parseEnv, planEnv, planIgnore, writeEnv, writeIgnore, type EnvValues } from "../envfile.js";
import { existsSync, readFileSync } from "node:fs";
import { STARTER_PROMPT } from "../guide.js";
import { isZone, machineZone } from "../time.js";
import { installSkills } from "./skill.js";
import type { Ui } from "../ui.js";
import { describeSession, ensureSignedIn, projectName, registerMcp } from "./shared.js";

// `npx calmonkey init`: the one command. In a project folder it signs the developer in, picks
// or creates a test-mode application, writes the environment file (with the project's time
// zone), installs the skill and the short section in AGENTS.md, and says what to ask the assistant.
//
// Rules it keeps throughout:
//   - It shows what it will write before writing, and `--dry-run` only shows.
//   - It never overwrites: a variable that has a value, a server entry that points elsewhere, a
//     skill file the person edited are all left as they are and reported.
//   - Running it again changes nothing.
//   - The client secret goes from CalMonkey into the environment file. It is never printed.
//
// The command line tool is what an AI coding tool uses from here on (the skill and the section
// in AGENTS.md say so). The MCP server is for tools that cannot run a command: it is
// registered only when asked for with --mcp (or `calmonkey mcp add`).

export type InitOptions = {
  yes: boolean;
  dryRun: boolean;
  clients: string[];
  app?: string;
  name?: string;
  envFile?: string;
  /** --no-secret: never fetch a client secret. */
  secret: boolean;
  /** --rotate-secret: replace an existing application's secret without asking. */
  rotateSecret: boolean;
  /** --mcp: also register the MCP server in the AI tools found. */
  mcp: boolean;
  /** --tz: the zone written as CALMONKEY_TZ (default: this machine's). */
  tz?: string;
  skills: boolean;
  browser: boolean;
  /** --wait: wait for the person to approve in a browser even without a terminal. */
  wait?: boolean;
};

export { STARTER_PROMPT };

const mask = (secret: string) => `${secret.slice(0, 6)}…  (hidden: ${secret.length} characters, written to the file only)`;

type Chosen = { app: Application | null; created: boolean; secret?: string; plannedName?: string; why?: string };

async function chooseApplication(ctx: Context, ui: Ui, opts: InitOptions, role: string, configuredClientId: string | null): Promise<Chosen> {
  const { applications, live_applications_not_included: liveHidden } = await listApplications(ctx);
  const tests = applications.filter((a) => a.mode === "test");
  const byRef = (ref: string) => tests.find((a) => a.client_id === ref || a.application_id === ref) ?? tests.find((a) => a.name.toLowerCase() === ref.toLowerCase());

  if (opts.app) {
    const found = byRef(opts.app);
    if (!found) throw new CliError(`No test-mode application "${opts.app}" in this organization.${tests.length ? ` Test-mode applications: ${tests.map((a) => a.name).join(", ")}.` : ""}${liveHidden ? " (Live applications are never used by this command.)" : ""}`);
    return { app: found, created: false };
  }
  const wantedName = (opts.name ?? `${projectName(ctx.cwd)} (dev)`).trim();
  const create = async (name: string): Promise<Chosen> => {
    if (role === "member") throw new CliError("Creating an application needs an owner or admin of the organization. Ask one to create a test-mode application, then run this again with --app <its client id>.");
    if (opts.dryRun) {
      ui.info(`Would create a test-mode application called “${name}”.`);
      return { app: null, created: true, plannedName: name };
    }
    const made = await createApplication(ctx, name);
    ui.ok(`Created the test-mode application “${made.name}”.`);
    return { app: { application_id: made.application_id, client_id: made.client_id, name: made.name, mode: "test", connected_accounts: 0, created: new Date().toISOString(), dashboard_url: made.dashboard_url }, created: true, secret: made.client_secret };
  };

  const sameName = tests.find((a) => a.name.toLowerCase() === wantedName.toLowerCase());
  if (opts.name) return sameName ? { app: sameName, created: false } : create(wantedName);
  // The project is already set up for an application: that is the one, so a second run changes nothing.
  if (configuredClientId) {
    const found = byRef(configuredClientId);
    if (found) return { app: found, created: false, why: "its client id is already in your environment file" };
  }
  if (!tests.length) {
    const name = await ui.input("No test-mode application yet. Name for a new one:", { default: wantedName });
    return create(name);
  }
  const NEW = Symbol("new");
  // Without questions: the application named after this project when there is one, else the only one, else a new one named after the project.
  const whenYes = sameName ?? (tests.length === 1 ? tests[0]! : NEW);
  const picked = await ui.select<Application | typeof NEW>(
    "Which test-mode application is this project for?",
    [...tests.map((a) => ({ label: a.name, value: a as Application | typeof NEW, hint: a.client_id })), { label: "Create a new test-mode application", value: NEW }],
    { whenYes, flag: "--yes, or --app <client id>" },
  );
  if (picked !== NEW) return { app: picked, created: false };
  return create(opts.yes ? wantedName : await ui.input("Name for the new application:", { default: wantedName }));
}

export async function runInit(ctx: Context, ui: Ui, opts: InitOptions): Promise<number> {
  ui.heading(`CalMonkey: setting up ${displayPath(ctx, ctx.cwd) || "this project"}${opts.dryRun ? ui.paint("yellow", "  (dry run: nothing is written)") : ""}`);

  // 1. Sign in.
  ui.heading("1. Sign in");
  const session = await ensureSignedIn(ctx, ui, { secrets: opts.secret, browser: opts.browser, wait: opts.wait });
  ui.ok(`Signed in to ${describeSession(session)}.`);

  // 2. The application.
  ui.heading("2. Test application");
  const envFile = chooseEnvFile(ctx.cwd, opts.envFile);
  const envRel = displayPath(ctx, envFile);
  const configured = findInEnvFiles(ctx.cwd, "CALMONKEY_CLIENT_ID", opts.envFile ? [opts.envFile] : []);
  const chosen = await chooseApplication(ctx, ui, opts, session.role, configured?.value ?? null);
  const app = chosen.app;
  if (app && !chosen.created) ui.ok(`Using the test-mode application “${app.name}”${chosen.why ? `: ${chosen.why}` : ""}.`);

  // 3. The environment file.
  ui.heading("3. Environment file");
  const have = existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : {};
  const clientId = app?.client_id ?? "<the new application's client id>";
  const wanted: EnvValues = { CALMONKEY_CLIENT_ID: clientId, CALMONKEY_API_URL: ctx.endpoints.api, CALMONKEY_APP_URL: ctx.endpoints.app };
  // The zone every command reads dates in. This machine's is the suggestion; it is shown, and a zone that is already set stays.
  const zone = opts.tz ?? machineZone();
  if (!isZone(zone)) throw new CliError(`--tz ${zone} is not a time zone. Use an IANA name such as Australia/Melbourne.`);
  if (!have.CALMONKEY_TZ) wanted.CALMONKEY_TZ = zone;
  // Only when the file is (or will be) set up for this very application does a secret belong in it.
  const fileIsForThisApp = !have.CALMONKEY_CLIENT_ID || have.CALMONKEY_CLIENT_ID === clientId;
  // --no-secret holds even when CalMonkey sends one with a new application: it is dropped here, unwritten.
  let secret = opts.secret ? chosen.secret : undefined;
  let secretNote = "";
  if (!opts.secret) secretNote = "Client secret: skipped (--no-secret).";
  else if (have.CALMONKEY_CLIENT_SECRET) secretNote = `Client secret: ${envRel} already has one. Left as it is.`;
  else if (!fileIsForThisApp) secretNote = `Client secret: not written, because ${envRel} is set up for another application (CALMONKEY_CLIENT_ID).`;
  else if (chosen.created && opts.dryRun) secretNote = "Client secret: the new application's secret would be written to the file.";
  else if (!secret && app) {
    if (!session.access.test_client_secrets) {
      secretNote = session.role === "member" ? "Client secret: only an owner or admin can fetch it." : "Client secret: this sign-in was approved without “Client secrets of test applications”. Run `calmonkey login` to change that.";
    } else if (chosen.created) {
      secretNote = "Client secret: not received.";
    } else {
      // A secret can only be shown when it is made, so an existing application needs a new one.
      const go = opts.rotateSecret || (await ui.confirm(`Replace the client secret of “${app.name}” and write the new one to ${envRel}? The current secret keeps working for 24 hours.`, { default: false, whenYes: false }));
      if (!go) secretNote = `Client secret: not replaced${opts.yes ? " (with --yes it is only replaced when you add --rotate-secret)" : ""}.`;
      else if (opts.dryRun) secretNote = "Client secret: would be replaced and written to the file.";
      else {
        try {
          secret = (await rotateSecret(ctx, app.client_id)).client_secret;
        } catch (error) {
          if (!(error instanceof ApiError)) throw error;
          secretNote = `Client secret: not fetched. ${error.message}`;
        }
      }
    }
  }
  if (secret) wanted.CALMONKEY_CLIENT_SECRET = secret;

  const envPlan = planEnv(envFile, wanted);
  if (envPlan.add.length) {
    ui.info(`${envPlan.exists ? "Add to" : "Create"} ${envRel}:`);
    ui.block(ui.paint("dim", envPlan.add.map(([name, value]) => `${name}=${name === "CALMONKEY_CLIENT_SECRET" ? mask(value) : value}`).join("\n")));
  }
  for (const name of envPlan.same) ui.ok(`${name} is already in ${envRel}.`);
  for (const kept of envPlan.kept) ui.warn(`${kept.name} is already set to another value in ${envRel}. Left as it is${kept.name === "CALMONKEY_CLIENT_SECRET" ? "" : ` (${kept.existing})`}.`);
  const ignore = planIgnore(ctx.cwd, envFile);
  if (ignore.status === "add") ui.info(`Add ${ignore.entry} to .gitignore, so the file is never committed.`);
  if (wanted.CALMONKEY_TZ) ui.info(`CALMONKEY_TZ=${zone} is the time zone dates are read in${opts.tz ? "" : ": this machine's. Change the line if the calendars' owners are elsewhere (or run init with --tz)"}.`);
  if (secretNote) ui.info(secretNote);
  if (!secret && app && opts.secret && !have.CALMONKEY_CLIENT_SECRET) ui.detail(`The secret is on the application's page: ${app.dashboard_url} (Rotate secret shows a new one once). It goes in ${envRel} as CALMONKEY_CLIENT_SECRET.`);

  let envWritten = false;
  if (!opts.dryRun && (envPlan.add.length || ignore.status === "add")) {
    // A secret that was just made exists nowhere else: it is written without a second question.
    const go = secret ? true : await ui.confirm(`Write ${[envPlan.add.length ? envRel : "", ignore.status === "add" ? ".gitignore" : ""].filter(Boolean).join(" and ")}?`);
    if (go) {
      writeEnv(envPlan);
      // The ignore rule comes with the file: a secret must never be left where a commit would pick it up.
      writeIgnore(ignore);
      envWritten = true;
      if (envPlan.add.length) ui.ok(`Wrote ${envRel}${secret ? " (with the client secret)" : ""}.`);
      if (ignore.status === "add") ui.ok(`Added ${ignore.entry} to .gitignore.`);
    } else ui.info("Left as it is.");
  }

  // 4. The MCP server.
  let nextSteps: string[] = [];
  if (opts.mcp) {
    ui.heading("4. MCP server in your AI tools");
    const outcome = await registerMcp(ctx, ui, { clients: opts.clients, dryRun: opts.dryRun });
    nextSteps = outcome.clients.map((c) => c.next);
  }

  // The skill and the always-loaded section.
  if (opts.skills) {
    ui.heading(`${opts.mcp ? "5" : "4"}. Skill and AGENTS.md`);
    await installSkills(ctx, ui, { dryRun: opts.dryRun, envFile: envRel });
  }

  // 6. What to say.
  ui.heading("Say this to your AI assistant");
  ui.block(STARTER_PROMPT.join("\n"));
  if (nextSteps.length) {
    ui.out("");
    ui.out(ui.paint("dim", "The MCP server: each tool signs in to CalMonkey itself the first time:"));
    for (const step of nextSteps) ui.detail(ui.paint("dim", step));
  }
  if (opts.dryRun) ui.out(`\n${ui.paint("yellow", "Dry run:")} nothing was written. Run it again without --dry-run.`);
  else if (!envWritten && envPlan.add.length) ui.out(`\n${ui.paint("yellow", "Note:")} ${envRel} was not written.`);
  return 0;
}
