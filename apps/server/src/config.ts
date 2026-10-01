import { z } from "zod";

const csv = z.string().transform((s) =>
  s
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean),
);

const Env = z
  .object({
    HOST: z.string().default("0.0.0.0"),
    PORT: z.coerce.number().int().positive().default(8787),
    /** URL clients use to reach this server (used to build the update feed URL). */
    PUBLIC_URL: z.url().default("http://localhost:8787"),
    DATABASE_URL: z.string().default("pglite:./data/db"),

    AUTH_MODE: z.enum(["oidc", "dev"]).default("oidc"),
    /** Keycloak realm URL, e.g. https://sso.example.com/realms/factory */
    OIDC_ISSUER: z.url().optional(),
    /** Public client used by the desktop app. Tokens must be issued to it (azp) or list it in aud. */
    OIDC_CLIENT_ID: z.string().optional(),
    DEV_TOKEN: z.string().optional(),

    /** Workflow definitions (workflows/<type>/workflow.yaml). */
    WORKFLOWS_DIR: z.string().default("./workflows"),
    /** Where card worktrees are created on this machine. */
    WORKTREES_DIR: z.string().default("./data/worktrees"),
    /** Optional JSON file overriding/adding ACP agents (see packages/runner agents.ts). */
    AGENTS_CONFIG: z.string().optional(),
    TURN_TIMEOUT_MINUTES: z.coerce.number().positive().default(30),
    /** A separate runner service (e.g. a pod). Unset: agents run inside this server. */
    RUNNER_URL: z.url().optional(),
    RUNNER_TOKEN: z.string().optional(),

    /** Keycloak realm or client role that may manage products, repos and integrations. */
    ADMIN_ROLE: z.string().default("factory-admin"),

    MIN_CLIENT_VERSION: z.string().default("0.0.0"),
    UPDATES_DIR: z.string().default("./updates"),
    UPDATE_CHANNELS: csv.default(["stable", "beta"]),
    /** owner/repo whose GitHub Releases are mirrored into UPDATES_DIR. Optional. */
    UPDATE_MIRROR_REPO: z.string().optional(),
    UPDATE_MIRROR_TOKEN: z.string().optional(),
    UPDATE_MIRROR_INTERVAL_MINUTES: z.coerce.number().positive().default(10),
  })
  .superRefine((env, ctx) => {
    if (env.AUTH_MODE === "oidc" && (!env.OIDC_ISSUER || !env.OIDC_CLIENT_ID)) {
      ctx.addIssue({
        code: "custom",
        message: "AUTH_MODE=oidc requires OIDC_ISSUER and OIDC_CLIENT_ID",
      });
    }
    if (env.RUNNER_URL && !env.RUNNER_TOKEN) {
      ctx.addIssue({ code: "custom", message: "RUNNER_URL requires RUNNER_TOKEN" });
    }
    if (env.AUTH_MODE === "dev" && !env.DEV_TOKEN) {
      ctx.addIssue({ code: "custom", message: "AUTH_MODE=dev requires DEV_TOKEN" });
    }
  });

export type ServerConfig = z.infer<typeof Env>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "env"}: ${i.message}`);
    throw new Error(`Invalid server configuration:\n${issues.join("\n")}`);
  }
  return parsed.data;
}
