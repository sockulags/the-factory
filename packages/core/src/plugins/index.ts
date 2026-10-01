import { githubPlugin } from "./github.js";
import { gitlabPlugin } from "./gitlab.js";
import { instructionsPlugin } from "./instructions.js";
import { mcpPlugin } from "./mcp.js";
import type { FactoryPlugin } from "./types.js";
import { webhookPlugin } from "./webhook.js";

export * from "./github.js";
export * from "./gitlab.js";
export * from "./host.js";
export * from "./instructions.js";
export * from "./mcp.js";
export * from "./pr-body.js";
export * from "./types.js";
export * from "./webhook.js";

export function builtinPlugins(deps: { fetch?: typeof fetch } = {}): FactoryPlugin[] {
  return [
    githubPlugin(deps),
    gitlabPlugin(deps),
    mcpPlugin(),
    instructionsPlugin(),
    webhookPlugin(deps),
  ] as unknown as FactoryPlugin[];
}
