import type { McpServer } from "@agentclientprotocol/sdk";
import type { Runner } from "@factory/runner";
import type { z } from "zod";
import type { Board, Card, Repo } from "../board.js";
import type { StepDefinition } from "../workflow/definition.js";

export interface HookContext {
  card: Card;
  step: StepDefinition;
  repo: Repo | null;
  board: Board;
  runner: Runner;
}

/** What a hook reports back; recorded in the card's history. */
export type HookResult = Record<string, unknown> | undefined;

export type PluginHook<C> = (
  ctx: HookContext & { config: C; env: NodeJS.ProcessEnv },
) => Promise<HookResult>;

/**
 * An integration. It can contribute workflow hooks (named actions like `vcs.open_pr`),
 * agent tools (MCP servers passed to agents), and prompt instructions. It's enabled and
 * configured per product; secrets are referenced by env var name, never stored.
 */
export interface FactoryPlugin<C = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  /** Validates the per-product config. */
  config: z.ZodType<C>;
  /** Shown in the UI as a starting point. */
  exampleConfig: Record<string, unknown>;
  hooks?: Record<string, PluginHook<C>>;
  mcpServers?(config: C, env: NodeJS.ProcessEnv): McpServer[];
  instructions?(config: C): string | null;
}

/** Reads a secret from the server environment by the name given in config. */
export function secret(env: NodeJS.ProcessEnv, name: string | undefined, what: string): string {
  const value = name ? env[name] : undefined;
  if (!value)
    throw new Error(
      `${what}: environment variable ${name ?? "(not configured)"} is not set on the server`,
    );
  return value;
}
