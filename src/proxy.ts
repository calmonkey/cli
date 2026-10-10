import { spawnSync } from "node:child_process";

// Proxies. Node's own fetch honours HTTPS_PROXY / HTTP_PROXY / NO_PROXY once it is started with
// NODE_USE_ENV_PROXY=1 (Node 22.21 and 24.5 onwards; it reaches every host through a CONNECT
// tunnel, plain http ones too). The setting is read when Node starts, so
// when a proxy is configured and the setting is not, the tool starts itself once more with it.
// Nothing is bundled for this, and without a proxy nothing happens at all.

const PROXY_VARIABLES = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy"];

export const proxyConfigured = (env: NodeJS.ProcessEnv): boolean => PROXY_VARIABLES.some((name) => Boolean(env[name]?.trim()));

/** Does this Node read proxy settings from the environment when asked to? */
export function supportsEnvProxy(version: string): boolean {
  const [major = 0, minor = 0] = version.split(".").map(Number);
  return major >= 25 || (major === 24 && minor >= 5) || (major === 22 && minor >= 21);
}

export type ProxyDecision = "none" | "active" | "restart" | "unsupported";

export function proxyDecision(env: NodeJS.ProcessEnv, nodeVersion: string): ProxyDecision {
  if (!proxyConfigured(env)) return "none";
  if (env.NODE_USE_ENV_PROXY === "1") return "active";
  return supportsEnvProxy(nodeVersion) ? "restart" : "unsupported";
}

/** Runs this same command again (`scriptAndArgs` = the script's path and its arguments) with the proxy setting on, and returns its exit code. */
export function restartWithProxy(scriptAndArgs: string[], env: NodeJS.ProcessEnv): number {
  const child = spawnSync(process.execPath, [...process.execArgv, ...scriptAndArgs], { stdio: "inherit", env: { ...env, NODE_USE_ENV_PROXY: "1" } });
  if (child.signal) return 130;
  return child.status ?? 1;
}
