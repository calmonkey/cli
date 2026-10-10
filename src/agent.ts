// Is an AI coding agent running this command?
//
// What the answer changes: no question is asked, no browser is opened, nothing waits for a
// person, and requests say which agent made them (the request log shows it). What it never
// changes: the output's format, its fields, its limits, or any safety rule. Detection is a
// guess (not every agent sets a variable), so nothing that matters may depend on it.

const VARIABLES: [name: string, agent: string][] = [
  ["CLAUDECODE", "claude-code"],
  ["CLAUDE_CODE_ENTRYPOINT", "claude-code"],
  ["CODEX_THREAD_ID", "codex"],
  ["CODEX_SANDBOX", "codex"],
  ["CODEX_CI", "codex"],
  ["CURSOR_AGENT", "cursor"],
  ["GEMINI_CLI", "gemini-cli"],
  ["COPILOT_CLI", "copilot"],
  ["COPILOT_AGENT", "copilot"],
  ["OPENCODE", "opencode"],
  ["AMP_CURRENT_THREAD_ID", "amp"],
  ["AUGMENT_AGENT", "augment"],
  ["AI_AGENT", ""],
  ["AGENT", ""],
];

export type AgentInfo = { agent: boolean; name: string | null };

const set = (value: string | undefined): value is string => value !== undefined && value !== "";

/** A name safe to send in a header and show in a log: lower-case letters, digits, dot, dash, underscore. */
const tidy = (value: string): string => value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "agent";

export function detectAgent(env: NodeJS.ProcessEnv): AgentInfo {
  const mode = env.CALMONKEY_MODE?.trim().toLowerCase();
  if (mode === "agent") return { agent: true, name: tidy(set(env.AI_AGENT) ? env.AI_AGENT : "agent") };
  // Any other value of CALMONKEY_MODE (e.g. "human") switches detection off.
  if (set(mode)) return { agent: false, name: null };
  for (const [variable, name] of VARIABLES) if (set(env[variable])) return { agent: true, name: name || tidy(env[variable]!) };
  return { agent: false, name: null };
}

/** True when Codex's sandbox has the network switched off for this process (its default). */
export const codexNetworkOff = (env: NodeJS.ProcessEnv): boolean => env.CODEX_SANDBOX_NETWORK_DISABLED === "1";
