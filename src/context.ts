import os from "node:os";
import path from "node:path";
import { detectAgent, type AgentInfo } from "./agent.js";

// Everything the commands read from the outside world, gathered once so tests can supply
// their own: where the project is, where the home directory is, the environment, the streams.

export type Endpoints = {
  /** The dashboard and the sign-in: https://app.calmonkey.com */
  app: string;
  /** The API: https://api.calmonkey.com */
  api: string;
  /** The MCP endpoint: https://mcp.calmonkey.com/mcp */
  mcp: string;
};

export type Context = {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  endpoints: Endpoints;
  /** Where the sign-in is kept. */
  configDir: string;
  stdin: NodeJS.ReadStream;
  stdout: NodeJS.WriteStream;
  stderr: NodeJS.WriteStream;
  /** False in CI, when there is no terminal and when an AI agent runs the command: no question is ever asked, no browser opened, nothing waits for a person. */
  interactive: boolean;
  /** Whether an AI coding agent is running the command, and which (src/agent.ts). Never changes what is printed. */
  agent: AgentInfo;
  /** The public site, where the documentation is: https://calmonkey.com */
  site: string;
  version: string;
};

export const DEFAULT_ENDPOINTS: Endpoints = { app: "https://app.calmonkey.com", api: "https://api.calmonkey.com", mcp: "https://mcp.calmonkey.com/mcp" };

/** Thrown for anything the person can fix: printed as one message, exit code 1, no stack. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

function origin(value: string | undefined, fallback: string, name: string): string {
  const raw = (value ?? "").trim() || fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new CliError(`${name} is not a URL: ${raw}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new CliError(`${name} must start with https:// (or http:// for a local CalMonkey): ${raw}`);
  if (url.username || url.password) throw new CliError(`${name} must not contain a user name or password.`);
  return raw.replace(/\/+$/, "");
}

/** The three addresses, from the environment or the live service. The MCP address may be given with or without its `/mcp` path. */
export function endpointsFrom(env: NodeJS.ProcessEnv): Endpoints {
  const app = origin(env.CALMONKEY_APP_URL, DEFAULT_ENDPOINTS.app, "CALMONKEY_APP_URL");
  const api = origin(env.CALMONKEY_API_URL, DEFAULT_ENDPOINTS.api, "CALMONKEY_API_URL");
  let mcp = origin(env.CALMONKEY_MCP_URL, DEFAULT_ENDPOINTS.mcp, "CALMONKEY_MCP_URL");
  if (new URL(mcp).pathname === "/") mcp = `${mcp}/mcp`;
  return { app, api, mcp };
}

// Variables CI systems set. `CI` covers nearly all of them; the rest are the ones that do not set it.
const CI_VARIABLES = ["CI", "CONTINUOUS_INTEGRATION", "BUILD_NUMBER", "GITHUB_ACTIONS", "GITLAB_CI", "BUILDKITE", "CIRCLECI", "TF_BUILD", "TEAMCITY_VERSION", "JENKINS_URL", "CODEBUILD_BUILD_ID"];

export const isCi = (env: NodeJS.ProcessEnv): boolean => CI_VARIABLES.some((name) => env[name] !== undefined && env[name] !== "" && env[name] !== "0" && env[name] !== "false");

/** Where the sign-in is kept: CALMONKEY_CONFIG_DIR, else the platform's place for a program's settings. */
export function configDirFrom(env: NodeJS.ProcessEnv, home: string, platform: NodeJS.Platform): string {
  if (env.CALMONKEY_CONFIG_DIR?.trim()) return path.resolve(env.CALMONKEY_CONFIG_DIR.trim());
  if (platform === "win32") return path.join(env.APPDATA?.trim() || path.join(home, "AppData", "Roaming"), "calmonkey");
  const xdg = env.XDG_CONFIG_HOME?.trim();
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".config"), "calmonkey");
}

export function createContext(overrides: Partial<Context> = {}): Context {
  const env = overrides.env ?? process.env;
  const home = overrides.home ?? os.homedir();
  const platform = overrides.platform ?? process.platform;
  const stdin = overrides.stdin ?? process.stdin;
  const stdout = overrides.stdout ?? process.stdout;
  const agent = overrides.agent ?? detectAgent(env);
  const endpoints = overrides.endpoints ?? endpointsFrom(env);
  return {
    cwd: overrides.cwd ?? process.cwd(),
    home,
    env,
    platform,
    endpoints,
    agent,
    // The docs live on the site. A local CalMonkey serves everything from one origin.
    site: overrides.site ?? (env.CALMONKEY_SITE_URL?.trim() ? origin(env.CALMONKEY_SITE_URL, "https://calmonkey.com", "CALMONKEY_SITE_URL") : endpoints.app === DEFAULT_ENDPOINTS.app ? "https://calmonkey.com" : endpoints.app),
    configDir: overrides.configDir ?? configDirFrom(env, home, platform),
    stdin,
    stdout,
    stderr: overrides.stderr ?? process.stderr,
    interactive: overrides.interactive ?? (Boolean(stdin.isTTY) && Boolean(stdout.isTTY) && !isCi(env) && !agent.agent),
    version: overrides.version ?? (typeof __CLI_VERSION__ === "string" ? __CLI_VERSION__ : "0.0.0-dev"),
  };
}

declare const __CLI_VERSION__: string | undefined;
