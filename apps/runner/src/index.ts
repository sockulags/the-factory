// The Factory runner service: runs agents and owns worktrees for a Factory server that
// reaches it over the runner protocol (packages/runner/src/remote.ts).

import { createRunnerHandler, LocalRunner, loadAgents } from "@factory/runner";
import { serve } from "@hono/node-server";
import { z } from "zod";

const env = z
  .object({
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(8788),
    /** Shared secret; the server sends it as a bearer token. */
    RUNNER_TOKEN: z.string().min(16, "RUNNER_TOKEN must be at least 16 characters"),
    AGENTS_CONFIG: z.string().optional(),
  })
  .parse(process.env);

const agents = await loadAgents(env.AGENTS_CONFIG);
const runner = new LocalRunner(agents);
const handler = createRunnerHandler(runner, { token: env.RUNNER_TOKEN, agents });

const server = serve({ fetch: handler, hostname: env.HOST, port: env.PORT }, (info) => {
  console.log(
    `factory runner listening on ${info.address}:${info.port} · agents: ${agents.map((a) => a.id).join(", ")}`,
  );
});

const shutdown = () => {
  server.close();
  void runner.shutdown().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
