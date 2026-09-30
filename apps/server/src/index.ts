import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { openDb } from "@factory/db";
import { serve } from "@hono/node-server";
import pkg from "../package.json" with { type: "json" };
import { createApp } from "./app.js";
import { createDevAuthenticator, createOidcAuthenticator } from "./auth.js";
import { loadConfig } from "./config.js";
import { mirrorLatestRelease } from "./updates.js";

const config = loadConfig();

// When bundled, migrations are copied next to the bundle; in dev the db package default is used.
const bundledMigrations = fileURLToPath(new URL("./drizzle", import.meta.url));
const dbHandle = await openDb({
  url: config.DATABASE_URL,
  ...(existsSync(bundledMigrations) ? { migrationsFolder: bundledMigrations } : {}),
});
await dbHandle.migrate();

const authenticate =
  config.AUTH_MODE === "oidc"
    ? createOidcAuthenticator({
        issuer: config.OIDC_ISSUER ?? "",
        clientId: config.OIDC_CLIENT_ID ?? "",
      })
    : createDevAuthenticator(config.DEV_TOKEN ?? "");
if (config.AUTH_MODE === "dev")
  console.warn("⚠ AUTH_MODE=dev — do not use outside local development");

const app = createApp({ config, db: dbHandle.db, authenticate, serverVersion: pkg.version });

if (config.UPDATE_MIRROR_REPO) {
  const repo = config.UPDATE_MIRROR_REPO;
  const runMirror = async () => {
    for (const channel of config.UPDATE_CHANNELS) {
      try {
        const result = await mirrorLatestRelease({
          repo,
          token: config.UPDATE_MIRROR_TOKEN,
          updatesDir: config.UPDATES_DIR,
          channel,
          includePrereleases: channel !== "stable",
        });
        if (result.status === "updated") console.log(`update mirror: ${channel} → ${result.tag}`);
      } catch (err) {
        console.error(`update mirror (${channel}) failed:`, (err as Error).message);
      }
    }
  };
  void runMirror();
  setInterval(runMirror, config.UPDATE_MIRROR_INTERVAL_MINUTES * 60_000).unref();
}

const server = serve({ fetch: app.fetch, hostname: config.HOST, port: config.PORT }, (info) => {
  console.log(`factory server ${pkg.version} listening on http://${info.address}:${info.port}`);
});

const shutdown = () => {
  server.close();
  void dbHandle.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
