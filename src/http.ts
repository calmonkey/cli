import { CliError, type Context } from "./context.js";

// One way out to the network: a user agent that says who is calling, a time limit, and errors
// a person can read. No request ever carries a secret in its address.

export type HttpResult = { status: number; headers: Headers; text: string; json: unknown };

export type HttpOptions = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  /** Sent as JSON. */
  json?: unknown;
  /** Sent as a form (the OAuth token endpoint). */
  form?: Record<string, string>;
  /** Sent as it is (a notification's raw body). */
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  redirect?: "manual" | "error";
};

/** Who is calling: the tool and its version, and the AI agent running it when there is one (the request log shows it). */
export const userAgent = (ctx: Pick<Context, "version" | "platform"> & { agent?: Context["agent"] }) => `calmonkey-cli/${ctx.version} (${ctx.agent?.name ? `agent=${ctx.agent.name}; ` : ""}node ${process.versions.node}; ${ctx.platform})`;

/** A network failure in words: which host, and what kind of failure. */
export function describeNetworkError(error: unknown, url: string): string {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  const cause = (error as { cause?: { code?: string; message?: string } })?.cause;
  const code = cause?.code ?? (error as { code?: string })?.code ?? "";
  if ((error as Error)?.name === "TimeoutError") return `No answer from ${host} in time.`;
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return `Could not find ${host}. Check the network connection (and HTTPS_PROXY if you are behind a proxy).`;
  if (code === "ECONNREFUSED") return `Nothing is answering at ${host} (connection refused).`;
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") return `The connection to ${host} was dropped.`;
  if (/^(CERT_|UNABLE_TO_|SELF_SIGNED|DEPTH_ZERO)/.test(code)) return `The certificate of ${host} was not accepted (${code}). Behind a company proxy, set NODE_EXTRA_CA_CERTS to its certificate.`;
  return `Could not reach ${host}${code ? ` (${code})` : ""}.`;
}

export async function request(ctx: Pick<Context, "version" | "platform"> & { agent?: Context["agent"] }, url: string, opts: HttpOptions = {}): Promise<HttpResult> {
  const headers: Record<string, string> = { "User-Agent": userAgent(ctx), Accept: "application/json", ...opts.headers };
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  } else if (opts.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(opts.form).toString();
  } else if (opts.body !== undefined) {
    body = opts.body;
  }
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? 20_000);
  const signal = opts.signal ? AbortSignal.any([timeout, opts.signal]) : timeout;
  let res: Response;
  try {
    res = await fetch(url, { method: opts.method ?? (body === undefined ? "GET" : "POST"), headers, body, signal, redirect: opts.redirect ?? "error" });
  } catch (error) {
    if (opts.signal?.aborted) throw error;
    throw new NetworkError(describeNetworkError(error, url), error, (error as Error)?.name === "TimeoutError");
  }
  const text = await res.text().catch(() => "");
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  return { status: res.status, headers: res.headers, text, json };
}

export class NetworkError extends CliError {
  constructor(
    message: string,
    readonly original: unknown,
    /** The request was sent and no answer came in time: a write may have gone through. */
    readonly timedOut = false,
  ) {
    super(message);
    this.name = "NetworkError";
  }
}
