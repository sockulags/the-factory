import { readFile } from "node:fs/promises";

/** How to launch an ACP agent as a subprocess speaking JSON-RPC over stdio. */
export interface AgentSpec {
  id: string;
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  /** Shown when the agent reports it isn't signed in. */
  loginHint?: string;
}

/**
 * Built-in agents. Each uses the CLI login already on the machine, so the team's
 * existing subscriptions are used rather than API keys.
 */
export const BUILTIN_AGENTS: AgentSpec[] = [
  {
    id: "claude",
    name: "Claude (claude-agent-acp)",
    command: "npx",
    args: ["-y", "@agentclientprotocol/claude-agent-acp@latest"],
    loginHint:
      "Sign in once with the Claude Code CLI: `npx @anthropic-ai/claude-code` then `/login`.",
  },
  {
    id: "codex",
    name: "Codex (codex-acp)",
    command: "npx",
    args: ["-y", "@agentclientprotocol/codex-acp@latest"],
    loginHint: "Sign in once with the Codex CLI: `npx @openai/codex login`.",
  },
  {
    id: "gemini",
    name: "Gemini CLI",
    command: "npx",
    args: ["-y", "@google/gemini-cli@latest", "--acp"],
    loginHint: "Sign in once by running `npx @google/gemini-cli` interactively.",
  },
];

/**
 * Loads agents: built-ins, overridden/extended by an optional JSON file
 * (`[{ id, name, command, args, env }]`), e.g. to pin versions or use local installs.
 */
export async function loadAgents(configFile?: string): Promise<AgentSpec[]> {
  const byId = new Map(BUILTIN_AGENTS.map((a) => [a.id, a]));
  if (configFile) {
    const extra = JSON.parse(await readFile(configFile, "utf8")) as AgentSpec[];
    for (const spec of extra) byId.set(spec.id, { ...byId.get(spec.id), ...spec });
  }
  return [...byId.values()];
}
