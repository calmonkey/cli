import { CliError, type Context } from "./context.js";
import { request, type HttpOptions } from "./http.js";
import { NotSignedInError, accessToken } from "./oauth.js";

// The calls this tool makes to CalMonkey once signed in: its own endpoints beside the MCP
// endpoint (`<mcp>/cli/…`), with the sign-in's access token.

export type Session = {
  organization: string;
  role: "owner" | "admin" | "member";
  client: string;
  connection_id: string;
  access: { live_applications: "none" | "read" | "write"; event_details: boolean; test_client_secrets: boolean };
  access_token_expires_at: string;
  dashboard_url: string;
};

export type Application = { application_id: string; client_id: string; name: string; mode: "test" | "live"; connected_accounts: number; created: string; dashboard_url: string };

export type Created = { application_id: string; client_id: string; name: string; mode: "test"; dashboard_url: string; environment: Record<string, string>; client_secret?: string };
export type Rotated = { application_id: string; client_id: string; name: string; client_secret: string; previous_secret_works_for_hours: number; environment: Record<string, string> };

export type Notification = { delivery_id: string; attempt: number; type: string; channel_id: string; callback_url: string; headers: Record<string, string>; body: string };
export type Report = { delivery_id: string; attempt: number; status: number; error?: string };
export type ListenRound = { application: { application_id: string; client_id: string; name: string }; notifications: Notification[]; reported: { delivery_id: string; result: string }[]; local_channels: number };

/** A refusal from CalMonkey, with its own words. */
export class ApiError extends CliError {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(ctx: Context, path: string, opts: HttpOptions = {}): Promise<T> {
  const url = `${ctx.endpoints.mcp}/cli${path}`;
  const send = async (token: string) => request(ctx, url, { ...opts, headers: { ...opts.headers, Authorization: `Bearer ${token}` } });
  let res = await send(await accessToken(ctx));
  // The token may have been ended a moment ago by another sign-in: one fresh token, one more try.
  if (res.status === 401) res = await send(await accessToken(ctx, { forceRefresh: true }));
  if (res.status === 401) throw new NotSignedInError("The sign-in has run out or was disconnected. Run: calmonkey login");
  if (res.status === 404 && !res.json) throw new CliError(`${new URL(ctx.endpoints.mcp).host} does not know this tool's addresses (${path} answered 404). Check CALMONKEY_MCP_URL.`);
  if (res.status >= 400) {
    const error = (res.json as { error?: { code?: string; message?: string } } | undefined)?.error;
    throw new ApiError(res.status, error?.code ?? `http_${res.status}`, error?.message ?? `CalMonkey answered ${res.status}.`);
  }
  return res.json as T;
}

export const getSession = (ctx: Context) => call<Session>(ctx, "/session");
export const listApplications = (ctx: Context) => call<{ organization: string; your_role: string; applications: Application[]; live_applications_not_included: number }>(ctx, "/applications");
export const createApplication = (ctx: Context, name: string) => call<Created>(ctx, "/applications", { json: { name } });
export const rotateSecret = (ctx: Context, applicationId: string) => call<Rotated>(ctx, `/applications/${encodeURIComponent(applicationId)}/secret`, { json: {} });
export const listenRound = (ctx: Context, body: { application_id: string; reports?: Report[]; wait_seconds?: number; limit?: number }, signal?: AbortSignal) =>
  call<ListenRound>(ctx, "/listen", { json: body, timeoutMs: ((body.wait_seconds ?? 0) + 20) * 1000, signal });
