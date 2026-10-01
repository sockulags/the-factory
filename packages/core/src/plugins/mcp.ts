import type { McpServer } from "@agentclientprotocol/sdk";
import { z } from "zod";
import type { FactoryPlugin } from "./types.js";

/** Values are env var *names* on the server; they're resolved when the agent starts. */
const EnvRefs = z.record(z.string(), z.string()).default({});

const Server = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("stdio"),
    name: z.string().min(1),
    command: z.string().min(1),
    args: z.array(z.string()).default([]),
    env: EnvRefs,
  }),
  z.object({ type: z.literal("http"), name: z.string().min(1), url: z.url(), headers: EnvRefs }),
]);

const Config = z.object({ servers: z.array(Server).default([]) });
type Config = z.infer<typeof Config>;

/**
 * Gives the product's agents extra tools through MCP servers — e.g. an issue tracker or
 * wiki (Jira/Confluence via Atlassian's MCP server), internal APIs, databases.
 */
export function mcpPlugin(): FactoryPlugin<Config> {
  return {
    id: "mcp",
    name: "Agent tools (MCP)",
    description:
      "MCP servers every agent on this product gets, e.g. Jira/Confluence, internal APIs.",
    config: Config,
    exampleConfig: {
      servers: [
        {
          type: "http",
          name: "atlassian",
          url: "https://mcp.atlassian.com/v1/mcp",
          headers: { Authorization: "ATLASSIAN_MCP_AUTH" },
        },
      ],
    },
    mcpServers(config, env): McpServer[] {
      const resolve = (refs: Record<string, string>) =>
        Object.entries(refs).map(([name, envName]) => ({ name, value: env[envName] ?? "" }));
      return config.servers.map((s) =>
        s.type === "stdio"
          ? { name: s.name, command: s.command, args: s.args, env: resolve(s.env) }
          : { type: "http" as const, name: s.name, url: s.url, headers: resolve(s.headers) },
      );
    },
  };
}
