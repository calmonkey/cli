import { spawn } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { CliError, type Context } from "./context.js";
import { clearSession, loadSession, saveSession, type StoredSession } from "./credentials.js";
import { request } from "./http.js";
import type { Ui } from "./ui.js";

// Signing in. The tool is a public OAuth client (RFC 8252, OAuth 2.1): authorization code with
// PKCE (S256), the answer delivered to a port on 127.0.0.1 that exists for the length of the
// sign-in. No secret exists, none is put in an address or on the command line.
//
// The client identifies itself with a Client ID Metadata Document that CalMonkey publishes for
// it on the app host (`<app>/agent-auth/cli/client.json`), the registration the MCP
// specification prefers. The tokens are issued for the MCP endpoint (RFC 8707 `resource`), the
// one resource this tool talks to.

/** What the connection asks for. `calmonkey:secrets` only puts a tick on the approval page; the person decides. */
export const SCOPE_BASE = "calmonkey:test";
export const SCOPE_SECRETS = "calmonkey:secrets";

export type ServerMetadata = { issuer: string; authorization_endpoint: string; token_endpoint: string; revocation_endpoint?: string };

const sameOrigin = (a: string, b: string) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

/** RFC 8414 metadata of the sign-in, read from the app host and checked: it must describe that host and offer PKCE with S256. */
export async function discover(ctx: Context): Promise<ServerMetadata> {
  const url = `${ctx.endpoints.app}/.well-known/oauth-authorization-server`;
  const res = await request(ctx, url);
  if (res.status === 404) throw new CliError(`${new URL(ctx.endpoints.app).host} does not offer sign-in for this tool (${url} answered 404). Check CALMONKEY_APP_URL.`);
  const meta = res.json as Partial<ServerMetadata & { code_challenge_methods_supported: string[]; client_id_metadata_document_supported: boolean }> | undefined;
  if (res.status !== 200 || !meta || typeof meta.issuer !== "string" || typeof meta.authorization_endpoint !== "string" || typeof meta.token_endpoint !== "string") {
    throw new CliError(`Could not read the sign-in settings from ${url} (HTTP ${res.status}).`);
  }
  // The issuer and every endpoint must be on the host that was asked: nothing else gets the code or the tokens.
  if (meta.issuer !== ctx.endpoints.app || !sameOrigin(meta.authorization_endpoint, ctx.endpoints.app) || !sameOrigin(meta.token_endpoint, ctx.endpoints.app)) {
    throw new CliError(`The sign-in settings at ${url} name another host. Not continuing.`);
  }
  if (!meta.code_challenge_methods_supported?.includes("S256")) throw new CliError("The sign-in does not offer PKCE with S256. Not continuing.");
  if (meta.client_id_metadata_document_supported !== true) throw new CliError("The sign-in does not accept client metadata documents, which this tool identifies itself with.");
  return { issuer: meta.issuer, authorization_endpoint: meta.authorization_endpoint, token_endpoint: meta.token_endpoint, ...(typeof meta.revocation_endpoint === "string" && sameOrigin(meta.revocation_endpoint, ctx.endpoints.app) ? { revocation_endpoint: meta.revocation_endpoint } : {}) };
}

/** The tool's client id: the address of its metadata document on the app host. */
export const clientIdOf = (ctx: Pick<Context, "endpoints">) => `${ctx.endpoints.app}/agent-auth/cli/client.json`;

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier, "ascii").digest("base64url") };
}

const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const page = (title: string, text: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:4rem auto;max-width:32rem;padding:0 1.5rem;color:#14231f;background:#f1f5f2}@media (prefers-color-scheme:dark){body{color:#e9f1ec;background:#0d1714}}</style></head><body><h1>${title}</h1><p>${text}</p></body></html>`;

export type Callback = { port: number; redirectUri: string; wait: (timeoutMs: number, signal?: AbortSignal) => Promise<URLSearchParams>; close: () => void };

/**
 * Listens on a free port of 127.0.0.1 for the browser's return (RFC 8252 §7.3: the address
 * literal, never `localhost`, and never another interface). Only GET /callback is answered,
 * and only the first one counts.
 */
export async function startCallbackServer(): Promise<Callback> {
  let deliver: (params: URLSearchParams) => void = () => {};
  const arrived = new Promise<URLSearchParams>((resolve) => (deliver = resolve));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const headers = { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" };
    if (req.method !== "GET" || url.pathname !== "/callback") {
      res.writeHead(404, headers).end(page("Not found", "This address only finishes a CalMonkey sign-in."));
      return;
    }
    const failed = url.searchParams.has("error") || !url.searchParams.has("code");
    res.writeHead(200, headers).end(failed ? page("Not signed in", "Nothing was connected. You can close this tab and go back to the terminal.") : page("Signed in", "You can close this tab and go back to the terminal."));
    deliver(url.searchParams);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  const close = () => {
    server.closeAllConnections?.();
    server.close();
  };
  return {
    port,
    redirectUri: `http://127.0.0.1:${port}/callback`,
    close,
    wait: (timeoutMs, signal) =>
      new Promise<URLSearchParams>((resolve, reject) => {
        const timer = setTimeout(() => reject(new CliError("Timed out waiting for the sign-in in the browser. Run the command again.")), timeoutMs);
        timer.unref?.();
        signal?.addEventListener("abort", () => reject(new CliError("Cancelled.")), { once: true });
        void arrived.then((params) => {
          clearTimeout(timer);
          resolve(params);
        });
      }),
  };
}

/** Opens the default browser. Returns false when nothing could be started; the address is printed either way. */
export function openBrowser(ctx: Pick<Context, "platform" | "env">, url: string): boolean {
  // Only an http(s) address is ever handed to the system, and never through a shell.
  if (!/^https?:\/\//.test(url)) return false;
  const [command, args]: [string, string[]] =
    ctx.platform === "darwin" ? ["open", [url]] : ctx.platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]] : ctx.env.WSL_DISTRO_NAME ? ["wslview", [url]] : ["xdg-open", [url]];
  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

export type TokenResponse = { access_token: string; refresh_token: string; expires_in: number; scope: string };

function tokensOf(res: { status: number; json: unknown }, doing: string): TokenResponse {
  const body = res.json as Partial<TokenResponse & { error: string; error_description: string }> | undefined;
  if (res.status === 200 && body && typeof body.access_token === "string" && typeof body.refresh_token === "string" && typeof body.expires_in === "number") {
    return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in, scope: typeof body.scope === "string" ? body.scope : "" };
  }
  throw new TokenError(body?.error ?? `http_${res.status}`, `${doing} failed${body?.error ? ` (${body.error}${body.error_description ? `: ${body.error_description}` : ""})` : ` (HTTP ${res.status})`}.`);
}

export class TokenError extends CliError {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "TokenError";
  }
}

const sessionOf = (ctx: Context, tokens: TokenResponse, signedInAt?: string): StoredSession => ({
  client_id: clientIdOf(ctx),
  access_token: tokens.access_token,
  refresh_token: tokens.refresh_token,
  expires_at: Date.now() + tokens.expires_in * 1000,
  scope: tokens.scope,
  resource: ctx.endpoints.mcp,
  signed_in_at: signedInAt ?? new Date().toISOString(),
});

export type LoginOptions = { secrets?: boolean; browser?: boolean; timeoutMs?: number; signal?: AbortSignal; /** Wait for the person even without a terminal (they were given the address some other way). */ wait?: boolean };

/** The whole sign-in: browser, approval, code, tokens. The new sign-in is stored before the previous one is ended. */
export async function login(ctx: Context, ui: Ui, opts: LoginOptions = {}): Promise<StoredSession> {
  // Signing in takes a person and a browser. Without a terminal, in CI, or when an AI agent runs
  // the command, nobody is there: say so at once instead of waiting five minutes for nobody.
  if (!ctx.interactive && !opts.wait) throw new NeedsPersonError();
  const meta = await discover(ctx);
  const previous = loadSession(ctx);
  const callback = await startCallbackServer();
  try {
    const { verifier, challenge } = pkcePair();
    const state = randomBytes(24).toString("base64url");
    const scope = opts.secrets === false ? SCOPE_BASE : `${SCOPE_BASE} ${SCOPE_SECRETS}`;
    const authorize = new URL(meta.authorization_endpoint);
    authorize.search = new URLSearchParams({ response_type: "code", client_id: clientIdOf(ctx), redirect_uri: callback.redirectUri, code_challenge: challenge, code_challenge_method: "S256", state, scope, resource: ctx.endpoints.mcp }).toString();

    const opened = opts.browser !== false && ctx.interactive && openBrowser(ctx, authorize.toString());
    ui.info(opened ? "Opening your browser to sign in to CalMonkey. If it does not open, go to:" : "Open this address in a browser to sign in to CalMonkey:");
    ui.detail(authorize.toString());
    ui.detail(ui.paint("dim", "Waiting for you to press Connect…"));

    const params = await callback.wait(opts.timeoutMs ?? 5 * 60_000, opts.signal);
    // Checked in this order: who answered, whether it answers our request, what the answer is.
    const iss = params.get("iss");
    if (iss !== null && iss !== meta.issuer) throw new CliError("The sign-in answer came from another issuer. Not continuing.");
    if (!equal(params.get("state") ?? "", state)) throw new CliError("The sign-in answer does not belong to this run (state mismatch). Run the command again.");
    const error = params.get("error");
    if (error) throw new CliError(error === "access_denied" ? "The request was declined in the browser. Nothing was connected." : `Sign-in failed: ${error}${params.get("error_description") ? ` (${params.get("error_description")})` : ""}.`);
    const code = params.get("code");
    if (!code) throw new CliError("The sign-in answer carried no code. Run the command again.");

    const res = await request(ctx, meta.token_endpoint, { form: { grant_type: "authorization_code", client_id: clientIdOf(ctx), code, code_verifier: verifier, redirect_uri: callback.redirectUri, resource: ctx.endpoints.mcp } });
    const session = sessionOf(ctx, tokensOf(res, "Signing in"));
    saveSession(ctx, session);
    // The previous connection is ended only now that the new one is safely stored.
    if (previous && meta.revocation_endpoint) await revoke(ctx, meta.revocation_endpoint, previous).catch(() => {});
    return session;
  } finally {
    callback.close();
  }
}

async function revoke(ctx: Context, endpoint: string, session: StoredSession): Promise<void> {
  await request(ctx, endpoint, { form: { token: session.refresh_token, token_type_hint: "refresh_token", client_id: session.client_id }, timeoutMs: 10_000 });
}

/** Ends the connection on the server (RFC 7009) and forgets the tokens. True when there was a sign-in. */
export async function logout(ctx: Context): Promise<{ wasSignedIn: boolean; revoked: boolean }> {
  const session = loadSession(ctx);
  if (!session) return { wasSignedIn: false, revoked: false };
  let revoked = false;
  try {
    const meta = await discover(ctx);
    if (meta.revocation_endpoint) {
      await revoke(ctx, meta.revocation_endpoint, session);
      revoked = true;
    }
  } catch {
    // Signing out locally must work without the network; the tokens run out by themselves.
  }
  clearSession(ctx);
  return { wasSignedIn: true, revoked };
}

/** Can this process write in the tool's folder? Tried, not guessed: a sandbox's rules are not visible in the file mode. */
function canWrite(dir: string): boolean {
  const probe = path.join(dir, `.write-check-${process.pid}`);
  try {
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** The sign-in has to be refreshed, and the new tokens could not be kept here. Exit code 3. */
export class ConfigNotWritableError extends CliError {
  constructor(dir: string) {
    super(
      `error config_not_writable: the sign-in has to be refreshed, and this command cannot write ${dir} (a sandbox?), where the new sign-in is kept\nnothing was changed\nfix: ask the person to run \`calmonkey status\` once in their own terminal (it refreshes the sign-in for the next hour)\n     or, under Codex, allow the folder: -c 'sandbox_workspace_write.writable_roots=["${dir}"]'`,
      3,
    );
    this.name = "ConfigNotWritableError";
  }
}

/** Thrown when a sign-in is needed and nobody is there to do it. Exit code 3, at once. */
export class NeedsPersonError extends CliError {
  constructor() {
    super("error not_signed_in: signing in needs a person and a browser, and this command has no terminal (or an AI agent is running it)\nnothing was changed\nfix: ask the person to run this in their own terminal: calmonkey login\n     (or: calmonkey login --wait   prints the address and waits 5 minutes for them to press Connect)", 3);
    this.name = "NeedsPersonError";
  }
}

/** Thrown when there is no usable sign-in: the commands turn it into "run calmonkey login". */
export class NotSignedInError extends CliError {
  constructor(message = "Not signed in. Run: calmonkey login") {
    super(message);
    this.name = "NotSignedInError";
  }
}

const REFRESH_MARGIN_MS = 60_000;

/**
 * An access token that works for at least another minute. The file is read each time, so a
 * long-running `calmonkey listen` picks up a token another run has refreshed instead of
 * presenting a refresh token that was already replaced (which would end the connection).
 */
export async function accessToken(ctx: Context, opts: { forceRefresh?: boolean } = {}): Promise<string> {
  const session = loadSession(ctx);
  if (!session) throw new NotSignedInError();
  if (!opts.forceRefresh && session.expires_at - Date.now() > REFRESH_MARGIN_MS) return session.access_token;
  // A refresh replaces the refresh token. Where the new one could not be kept (a sandbox that
  // cannot write the tool's folder), refreshing would leave a used-up token behind, and using it
  // again ends the connection: say so instead, before anything is sent.
  if (!canWrite(ctx.configDir)) throw new ConfigNotWritableError(ctx.configDir);
  const meta = await discover(ctx);
  const res = await request(ctx, meta.token_endpoint, { form: { grant_type: "refresh_token", client_id: session.client_id, refresh_token: session.refresh_token, resource: ctx.endpoints.mcp } });
  try {
    const next = sessionOf(ctx, tokensOf(res, "Refreshing the sign-in"), session.signed_in_at);
    saveSession(ctx, next);
    return next.access_token;
  } catch (error) {
    if (error instanceof TokenError && error.code === "invalid_grant") {
      // Another run may have refreshed in the meantime: its tokens are in the file now.
      const latest = loadSession(ctx);
      if (latest && latest.refresh_token !== session.refresh_token && latest.expires_at - Date.now() > REFRESH_MARGIN_MS) return latest.access_token;
      clearSession(ctx);
      throw new NotSignedInError("The sign-in has run out or was disconnected. Run: calmonkey login");
    }
    throw error;
  }
}
