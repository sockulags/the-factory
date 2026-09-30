import { type Db, upsertUserFromIdentity } from "@factory/db";
import {
  CLIENT_TOO_OLD_STATUS,
  CLIENT_VERSION_HEADER,
  type ClientConfig,
  isVersionSupported,
  type Me,
} from "@factory/protocol";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { AuthError, type Authenticator, type Identity } from "./auth.js";
import type { ServerConfig } from "./config.js";
import { serveUpdateFile } from "./updates.js";

export interface AppDeps {
  config: ServerConfig;
  db: Db;
  authenticate: Authenticator;
  serverVersion: string;
}

type Env = { Variables: { identity: Identity } };

export function createApp({ config, db, authenticate, serverVersion }: AppDeps) {
  const app = new Hono<Env>();

  const clientConfig: ClientConfig = {
    serverVersion,
    minClientVersion: config.MIN_CLIENT_VERSION,
    auth:
      config.AUTH_MODE === "oidc"
        ? {
            mode: "oidc",
            issuer: config.OIDC_ISSUER ?? "",
            clientId: config.OIDC_CLIENT_ID ?? "",
            scopes: ["openid", "profile", "email", "offline_access"],
          }
        : { mode: "dev" },
    updates: {
      baseUrl: `${config.PUBLIC_URL.replace(/\/$/, "")}/updates`,
      channels: config.UPDATE_CHANNELS,
    },
  };

  app.get("/health", (c) => c.json({ ok: true, version: serverVersion }));

  // Public bootstrap config. Exempt from the version check below: an outdated client
  // still needs it to find the update feed.
  app.get("/api/client-config", (c) => c.json(clientConfig));

  // Clients that announce their version must be at least MIN_CLIENT_VERSION.
  app.use("/api/*", async (c, next) => {
    const clientVersion = c.req.header(CLIENT_VERSION_HEADER);
    if (clientVersion && !isVersionSupported(clientVersion, config.MIN_CLIENT_VERSION)) {
      return c.json(
        { error: "client_too_old", minClientVersion: config.MIN_CLIENT_VERSION },
        CLIENT_TOO_OLD_STATUS,
      );
    }
    await next();
  });

  const requireAuth = createMiddleware<Env>(async (c, next) => {
    const header = c.req.header("authorization") ?? "";
    const [scheme, token] = header.split(" ");
    if (scheme?.toLowerCase() !== "bearer" || !token) {
      return c.json({ error: "unauthorized" }, 401);
    }
    try {
      c.set("identity", await authenticate(token));
    } catch (err) {
      if (err instanceof AuthError)
        return c.json({ error: "unauthorized", detail: err.message }, 401);
      throw err;
    }
    await next();
  });

  app.get("/api/me", requireAuth, async (c) => {
    const identity = c.get("identity");
    const user = await upsertUserFromIdentity(db, identity);
    const me: Me = {
      id: user.id,
      username: user.username,
      name: user.name,
      email: user.email,
      roles: identity.roles,
    };
    return c.json(me);
  });

  // Update feed for electron-updater's generic provider: /updates/<channel>/<file>
  app.get("/updates/:channel/:file", (c) =>
    serveUpdateFile(
      config.UPDATES_DIR,
      config.UPDATE_CHANNELS,
      c.req.param("channel"),
      c.req.param("file"),
    ),
  );

  return app;
}
