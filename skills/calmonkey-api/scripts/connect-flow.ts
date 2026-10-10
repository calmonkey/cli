// Connecting a person's calendar: build the link they open, exchange the code they come back
// with, and refresh the access token later. The three functions are what your server needs;
// the command line at the bottom lets you try each step.
//
//   CALMONKEY_CLIENT_ID      your application's client id          (required)
//   CALMONKEY_CLIENT_SECRET  your application's client secret      (exchange and refresh)
//   CALMONKEY_API_URL        the API host (default https://api.calmonkey.com)
//   CALMONKEY_APP_URL        the host people's browsers open (default https://app.calmonkey.com)
//   CALMONKEY_REDIRECT_URI   one of the application's redirect URIs, exactly as registered
//   CALMONKEY_REFRESH_TOKEN  an account's refresh token            (refresh only)
//
//   npx tsx connect-flow.ts url [google|office365|live_connect|apple]
//       prints the link. Open it in a browser, connect a calendar, and you come back to the
//       redirect URI with ?code=...&state=...
//   npx tsx connect-flow.ts exchange <code>
//       exchanges the code (valid once, for 10 minutes) for the account's tokens
//   npx tsx connect-flow.ts refresh
//       gets a new access token with CALMONKEY_REFRESH_TOKEN
//
// No dependencies. Run it with `npx tsx connect-flow.ts` (Node 20 or later); on Node 22.18 or
// later `node connect-flow.ts` works too. Tokens are shown shortened: store the real ones on
// your server.

import { randomBytes } from "node:crypto";
import { pathToFileURL } from "node:url";

const API = (process.env.CALMONKEY_API_URL ?? "https://api.calmonkey.com").replace(/\/+$/, "");
const APP = (process.env.CALMONKEY_APP_URL ?? "https://app.calmonkey.com").replace(/\/+$/, "");

function need(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Set ${name} in your environment file.`);
  return value;
}

export type Provider = "google" | "office365" | "live_connect" | "apple";

export type TokenResponse = {
  token_type: "bearer";
  access_token: string;
  /** Seconds the access token is valid for (10,800: three hours). */
  expires_in: number;
  /** Does not change when it is used. */
  refresh_token: string;
  scope: string;
  /** The account, acc_... Only in the answer to a code. */
  sub?: string;
  /** The calendar account connected in this run. Only in the answer to a code. */
  linking_profile?: { provider_name: string; profile_id: string; profile_name: string | null };
};

/**
 * The link to send the person's browser to. `state` comes back unchanged on the redirect:
 * keep it in the person's session and compare it there, which stops cross-site request forgery.
 * Without `provider` the page lets them choose Google, Microsoft 365, Outlook.com or Apple iCloud.
 */
export function authorizeUrl(opts: { clientId: string; redirectUri: string; state: string; provider?: Provider; linkToken?: string }): string {
  const url = new URL(`${APP}/oauth/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", "read_write");
  url.searchParams.set("state", opts.state);
  if (opts.provider) url.searchParams.set("provider_name", opts.provider);
  if (opts.linkToken) url.searchParams.set("link_token", opts.linkToken);
  return url.toString();
}

/** POST /oauth/token. The client credentials go in the body. Errors are 400 with {"error": "..."}. */
async function tokenRequest(fields: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch(`${API}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: need("CALMONKEY_CLIENT_ID"), client_secret: need("CALMONKEY_CLIENT_SECRET"), ...fields }),
  });
  if (!res.ok) {
    const { error } = (await res.json().catch(() => ({}))) as { error?: string };
    // invalid_grant: the code is used or expired, or the refresh token was revoked (the person has to connect again).
    throw new Error(`POST /oauth/token -> ${res.status} ${error ?? ""}`.trim());
  }
  return (await res.json()) as TokenResponse;
}

/** Your redirect URI's handler calls this with the `code` it was given, after checking `state`. */
export const exchangeCode = (code: string, redirectUri: string): Promise<TokenResponse> => tokenRequest({ grant_type: "authorization_code", code, redirect_uri: redirectUri });

/** Call this when an access token has run out, or when /v1 answers 401; then repeat the request once. */
export const refreshAccessToken = (refreshToken: string): Promise<TokenResponse> => tokenRequest({ grant_type: "refresh_token", refresh_token: refreshToken });

// --- Command line -------------------------------------------------------------------------

const shortened = (token: string) => `${token.slice(0, 9)}... (${token.length} characters)`;

function show(tokens: TokenResponse): void {
  console.log(JSON.stringify({ ...tokens, access_token: shortened(tokens.access_token), refresh_token: shortened(tokens.refresh_token) }, null, 2));
}

async function main(): Promise<void> {
  const [command, argument] = process.argv.slice(2);
  if (command === "url") {
    const state = randomBytes(16).toString("hex");
    console.log(authorizeUrl({ clientId: need("CALMONKEY_CLIENT_ID"), redirectUri: need("CALMONKEY_REDIRECT_URI"), state, provider: argument as Provider | undefined }));
    console.log(`state: ${state}`);
  } else if (command === "exchange" && argument) {
    show(await exchangeCode(argument, need("CALMONKEY_REDIRECT_URI")));
  } else if (command === "refresh") {
    show(await refreshAccessToken(need("CALMONKEY_REFRESH_TOKEN")));
  } else {
    console.error("Usage: connect-flow.ts url [provider] | exchange <code> | refresh");
    process.exitCode = 2;
  }
}

// Only when run as a program, so the functions above can be imported as they are.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
