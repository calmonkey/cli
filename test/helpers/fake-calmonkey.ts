import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";

// A CalMonkey small enough for unit tests: the sign-in (metadata, authorize, token with PKCE,
// rotating refresh tokens, revoke), the tool's own endpoints, the MCP endpoint's refusal and
// the API's token endpoint. It keeps what it was asked so tests can look.

export type Recorded = { method: string; path: string; query: URLSearchParams; headers: http.IncomingHttpHeaders; body: string };

export type FakeNotification = { delivery_id: string; attempt: number; type: string; channel_id: string; callback_url: string; headers: Record<string, string>; body: string };

export type Fake = {
  url: string;
  requests: Recorded[];
  /** What the next rounds of /mcp/cli/listen hand over, one array per call. */
  listenQueue: FakeNotification[][];
  /** Calls of POST /mcp/cli/tools/<tool>, and what answers them (default: 404 unknown_tool). */
  toolCalls: { tool: string; args: Record<string, unknown>; userAgent: string }[];
  tool: (tool: string, args: Record<string, unknown>) => { status: number; body: unknown; headers?: Record<string, string> };
  /** Served at /llms-full.txt. */
  docs: string;
  /** Reports received by /mcp/cli/listen. */
  reports: unknown[];
  applications: { application_id: string; client_id: string; name: string; mode: "test" | "live"; connected_accounts: number; created: string; dashboard_url: string }[];
  state: {
    role: "owner" | "admin" | "member";
    secrets: boolean;
    /** Break the metadata in a named way. */
    metadata?: "wrong-issuer" | "no-s256" | "no-cimd" | "foreign-token-endpoint";
    /** Answer authorize with this error instead of a code. */
    deny?: string;
    /** Send this `iss` with the authorization response. */
    iss?: string;
    /** Send this `state` instead of the client's. */
    forgeState?: string;
    /** Valid refresh tokens. */
    refreshTokens: Set<string>;
    accessTokens: Set<string>;
    revoked: string[];
    clientSecret: string;
    listenStatus?: number;
  };
  close: () => Promise<void>;
};

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { "Content-Type": "application/json", ...headers }).end(JSON.stringify(body));

export async function startFake(): Promise<Fake> {
  const codes = new Map<string, { challenge: string; redirectUri: string; clientId: string; resource: string; scope: string }>();
  const fake = { toolCalls: [], docs: "", tool: () => ({ status: 404, body: { error: { code: "unknown_tool", message: "No such tool." } } }), requests: [] as Recorded[], listenQueue: [] as FakeNotification[][], reports: [] as unknown[], applications: [] as Fake["applications"], state: { role: "owner", secrets: true, refreshTokens: new Set<string>(), accessTokens: new Set<string>(), revoked: [] as string[], clientSecret: "cmsec_" + "s".repeat(40) } } as unknown as Fake;
  const issue = () => {
    const access = `cmmat_${randomBytes(24).toString("base64url")}`;
    const refresh = `cmmrt_${randomBytes(24).toString("base64url")}`;
    fake.state.accessTokens.add(access);
    fake.state.refreshTokens.add(refresh);
    return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh, scope: `calmonkey:test calmonkey:event_details${fake.state.secrets ? " calmonkey:secrets" : ""}` };
  };

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", fake.url);
      const body = Buffer.concat(chunks).toString("utf8");
      fake.requests.push({ method: req.method ?? "", path: url.pathname, query: url.searchParams, headers: req.headers, body });
      const form = new URLSearchParams(body);
      const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
      const authed = () => Boolean(bearer && fake.state.accessTokens.has(bearer));
      const parsed = (): Record<string, unknown> => {
        try {
          return JSON.parse(body || "{}") as Record<string, unknown>;
        } catch {
          return {};
        }
      };

      if (url.pathname === "/.well-known/oauth-authorization-server") {
        const m = fake.state.metadata;
        return json(res, 200, {
          issuer: m === "wrong-issuer" ? "https://elsewhere.example" : fake.url,
          authorization_endpoint: `${fake.url}/agent-auth/authorize`,
          token_endpoint: m === "foreign-token-endpoint" ? "https://elsewhere.example/token" : `${fake.url}/agent-auth/token`,
          revocation_endpoint: `${fake.url}/agent-auth/revoke`,
          code_challenge_methods_supported: m === "no-s256" ? ["plain"] : ["S256"],
          client_id_metadata_document_supported: m !== "no-cimd",
        });
      }
      if (url.pathname === "/agent-auth/authorize") {
        const redirect = new URL(url.searchParams.get("redirect_uri")!);
        redirect.searchParams.set("state", fake.state.forgeState ?? url.searchParams.get("state") ?? "");
        redirect.searchParams.set("iss", fake.state.iss ?? fake.url);
        if (fake.state.deny) redirect.searchParams.set("error", fake.state.deny);
        else {
          const code = `cmmac_${randomBytes(16).toString("base64url")}`;
          codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", redirectUri: url.searchParams.get("redirect_uri") ?? "", clientId: url.searchParams.get("client_id") ?? "", resource: url.searchParams.get("resource") ?? "", scope: url.searchParams.get("scope") ?? "" });
          redirect.searchParams.set("code", code);
        }
        return res.writeHead(302, { Location: redirect.toString() }).end();
      }
      if (url.pathname === "/agent-auth/token") {
        if (form.get("grant_type") === "authorization_code") {
          const known = codes.get(form.get("code") ?? "");
          codes.delete(form.get("code") ?? "");
          const challenge = createHash("sha256").update(form.get("code_verifier") ?? "", "ascii").digest("base64url");
          if (!known || known.challenge !== challenge || known.redirectUri !== form.get("redirect_uri") || known.clientId !== form.get("client_id") || known.resource !== form.get("resource")) return json(res, 400, { error: "invalid_grant" });
          return json(res, 200, issue());
        }
        if (form.get("grant_type") === "refresh_token") {
          const token = form.get("refresh_token") ?? "";
          if (!fake.state.refreshTokens.has(token)) return json(res, 400, { error: "invalid_grant" });
          // Rotating: the presented token is used up.
          fake.state.refreshTokens.delete(token);
          return json(res, 200, issue());
        }
        return json(res, 400, { error: "unsupported_grant_type" });
      }
      if (url.pathname === "/agent-auth/revoke") {
        const token = form.get("token") ?? "";
        fake.state.revoked.push(token);
        fake.state.refreshTokens.delete(token);
        fake.state.accessTokens.clear();
        return res.writeHead(200).end();
      }
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json(res, 200, { resource: `${fake.url}/mcp`, authorization_servers: [fake.url] });
      if (url.pathname === "/mcp") return authed() ? json(res, 200, { jsonrpc: "2.0", id: 1, result: {} }) : json(res, 401, { jsonrpc: "2.0", error: { code: -32001, message: "unauthorized" }, id: null }, { "WWW-Authenticate": "Bearer" });
      if (url.pathname === "/oauth/token") {
        const b = parsed();
        const good = fake.applications.some((a) => a.client_id === b.client_id) && b.client_secret === fake.state.clientSecret;
        return json(res, 400, { error: good ? "invalid_grant" : "invalid_client" });
      }
      if (url.pathname === "/llms-full.txt") return fake.docs ? res.writeHead(200, { "Content-Type": "text/plain" }).end(fake.docs) : res.writeHead(404).end();
      const toolName = /^\/mcp\/cli\/tools\/([a-z_]+)$/.exec(url.pathname)?.[1];
      if (toolName && authed()) {
        const args = parsed();
        fake.toolCalls.push({ tool: toolName, args, userAgent: String(req.headers["user-agent"] ?? "") });
        const answer = fake.tool(toolName, args);
        return json(res, answer.status, answer.body, { "Calmonkey-Request-Id": "req_test0001", ...answer.headers });
      }
      if (url.pathname.startsWith("/mcp/cli/")) {
        if (!authed()) return json(res, 401, { error: { code: "unauthorized", message: "Not signed in, or the sign-in has run out. Run: calmonkey login" } });
        if (url.pathname === "/mcp/cli/session") return json(res, 200, { organization: "Acme", role: fake.state.role, client: "CalMonkey CLI", connection_id: "mcg_1", access: { live_applications: "none", event_details: true, test_client_secrets: fake.state.secrets && fake.state.role !== "member" }, access_token_expires_at: new Date(Date.now() + 3600_000).toISOString(), dashboard_url: `${fake.url}/dashboard` });
        if (url.pathname === "/mcp/cli/applications" && req.method === "GET") return json(res, 200, { organization: "Acme", your_role: fake.state.role, applications: fake.applications.filter((a) => a.mode === "test"), live_applications_not_included: fake.applications.filter((a) => a.mode === "live").length });
        if (url.pathname === "/mcp/cli/applications" && req.method === "POST") {
          if (fake.state.role === "member") return json(res, 403, { error: { code: "forbidden", message: "Your role in this organization is read-only." } });
          const n = fake.applications.length + 1;
          const app = { application_id: `${n}`.padStart(24, "0"), client_id: `client${n}`, name: String(parsed().name), mode: "test" as const, connected_accounts: 0, created: new Date().toISOString(), dashboard_url: `${fake.url}/dashboard/apps/${n}` };
          fake.applications.push(app);
          return json(res, 201, { ...app, environment: { CALMONKEY_CLIENT_ID: app.client_id }, ...(fake.state.secrets ? { client_secret: fake.state.clientSecret } : {}) });
        }
        const rotate = /^\/mcp\/cli\/applications\/([^/]+)\/secret$/.exec(url.pathname);
        if (rotate) {
          const app = fake.applications.find((a) => a.mode === "test" && (a.client_id === decodeURIComponent(rotate[1]!) || a.application_id === rotate[1]));
          if (!app) return json(res, 404, { error: { code: "not_found", message: "No test-mode application with that id in this organization." } });
          if (!fake.state.secrets) return json(res, 403, { error: { code: "forbidden", message: "This connection was not approved for client secrets." } });
          fake.state.clientSecret = `cmsec_${randomBytes(30).toString("base64url")}`;
          return json(res, 200, { application_id: app.application_id, client_id: app.client_id, name: app.name, client_secret: fake.state.clientSecret, previous_secret_works_for_hours: 24, environment: {} });
        }
        if (url.pathname === "/mcp/cli/listen") {
          if (fake.state.listenStatus) return json(res, fake.state.listenStatus, { error: { code: "x", message: `listen answered ${fake.state.listenStatus}` } });
          const b = parsed();
          const app = fake.applications.find((a) => a.mode === "test" && (a.client_id === b.application_id || a.application_id === b.application_id));
          if (!app) return json(res, 404, { error: { code: "not_found", message: "No test-mode application with that id in this organization." } });
          const reports = Array.isArray(b.reports) ? b.reports : [];
          fake.reports.push(...reports);
          const notifications = fake.listenQueue.shift() ?? [];
          const answer = () => json(res, 200, { application: { application_id: app.application_id, client_id: app.client_id, name: app.name }, notifications, reported: reports.map((r) => ({ delivery_id: (r as { delivery_id: string }).delivery_id, result: "delivered" })), local_channels: 1 });
          // An empty round is a long poll on the real server; here a short pause keeps the loop from spinning.
          if (!notifications.length && !reports.length) return void setTimeout(answer, 150);
          return answer();
        }
      }
      return res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  fake.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  fake.close = () => new Promise((resolve) => (server.closeAllConnections(), server.close(() => resolve())));
  return fake;
}
