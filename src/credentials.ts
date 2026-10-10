import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Context } from "./context.js";

// Where the sign-in is kept between runs: one JSON file, readable by its owner only, in the
// tool's own folder (CALMONKEY_CONFIG_DIR, else ~/.config/calmonkey). It holds an access token
// (one hour) and a refresh token (30 days, replaced every time it is used). Nothing else is
// ever written to that folder, and the file is never printed.
//
// One entry per CalMonkey address, so a sign-in to a local CalMonkey and one to the live
// service do not replace each other.

export type StoredSession = {
  client_id: string;
  access_token: string;
  refresh_token: string;
  /** When the access token stops working (ms since the epoch). */
  expires_at: number;
  scope: string;
  /** The MCP endpoint the tokens were issued for. */
  resource: string;
  signed_in_at: string;
};

type CredentialsFile = { version: 1; sessions: Record<string, StoredSession> };

export const credentialsPath = (ctx: Pick<Context, "configDir">) => path.join(ctx.configDir, "credentials.json");

const keyOf = (ctx: Pick<Context, "endpoints">) => ctx.endpoints.app;

function read(ctx: Pick<Context, "configDir">): CredentialsFile {
  const file = credentialsPath(ctx);
  if (!existsSync(file)) return { version: 1, sessions: {} };
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<CredentialsFile>;
    if (parsed && parsed.version === 1 && parsed.sessions && typeof parsed.sessions === "object") return { version: 1, sessions: parsed.sessions };
  } catch {
    // A file that cannot be read is the same as no sign-in: the person signs in again.
  }
  return { version: 1, sessions: {} };
}

function write(ctx: Pick<Context, "configDir" | "platform">, data: CredentialsFile): void {
  mkdirSync(ctx.configDir, { recursive: true, mode: 0o700 });
  const file = credentialsPath(ctx);
  // Written beside the file and moved into place: another run never reads half a file.
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  if (ctx.platform !== "win32") chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** The stored sign-in for this CalMonkey address, read fresh from the file every time (another run may have refreshed it). */
export function loadSession(ctx: Pick<Context, "configDir" | "endpoints">): StoredSession | null {
  const session = read(ctx).sessions[keyOf(ctx)];
  if (!session || typeof session.access_token !== "string" || typeof session.refresh_token !== "string") return null;
  // A sign-in made for another MCP address is of no use here.
  return session.resource === ctx.endpoints.mcp ? session : null;
}

export function saveSession(ctx: Pick<Context, "configDir" | "endpoints" | "platform">, session: StoredSession): void {
  const data = read(ctx);
  data.sessions[keyOf(ctx)] = session;
  write(ctx, data);
}

/** Removes the stored sign-in for this address. The file goes when nothing is left in it. */
export function clearSession(ctx: Pick<Context, "configDir" | "endpoints" | "platform">): boolean {
  const data = read(ctx);
  if (!data.sessions[keyOf(ctx)]) return false;
  delete data.sessions[keyOf(ctx)];
  if (Object.keys(data.sessions).length) write(ctx, data);
  else rmSync(credentialsPath(ctx), { force: true });
  return true;
}
