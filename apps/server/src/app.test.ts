import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type DbHandle, openDb } from "@factory/db";
import { ClientConfig, Me } from "@factory/protocol";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createOidcAuthenticator } from "./auth.js";
import { loadConfig } from "./config.js";

const ISSUER = "https://sso.example.com/realms/factory";
const CLIENT_ID = "factory-desktop";

describe("server app", () => {
  let handle: DbHandle;
  let app: ReturnType<typeof createApp>;
  let sign: (claims: Record<string, unknown>, opts?: { issuer?: string }) => Promise<string>;
  let updatesDir: string;

  beforeAll(async () => {
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
    sign = (claims, opts = {}) =>
      new SignJWT(claims)
        .setProtectedHeader({ alg: "RS256", kid: "k1" })
        .setIssuer(opts.issuer ?? ISSUER)
        .setIssuedAt()
        .setExpirationTime("5m")
        .sign(privateKey);

    updatesDir = await mkdtemp(path.join(tmpdir(), "factory-updates-"));
    await mkdir(path.join(updatesDir, "stable"));
    await writeFile(path.join(updatesDir, "stable", "latest.yml"), "version: 0.2.0\n");

    handle = await openDb({ url: "pglite:memory" });
    await handle.migrate();
    const config = loadConfig({
      AUTH_MODE: "oidc",
      OIDC_ISSUER: ISSUER,
      OIDC_CLIENT_ID: CLIENT_ID,
      PUBLIC_URL: "https://factory.internal",
      MIN_CLIENT_VERSION: "0.2.0",
      UPDATES_DIR: updatesDir,
    });
    app = createApp({
      config,
      db: handle.db,
      serverVersion: "0.1.0",
      authenticate: createOidcAuthenticator({
        issuer: ISSUER,
        clientId: CLIENT_ID,
        keys: createLocalJWKSet({ keys: [jwk] }),
      }),
    });
  });
  afterAll(() => handle.close());

  it("reports health", async () => {
    const res = await app.request("/health");
    expect(await res.json()).toEqual({ ok: true, version: "0.1.0" });
  });

  it("publishes client config", async () => {
    const res = await app.request("/api/client-config");
    const config = ClientConfig.parse(await res.json());
    expect(config.auth).toMatchObject({ mode: "oidc", issuer: ISSUER, clientId: CLIENT_ID });
    expect(config.updates.baseUrl).toBe("https://factory.internal/updates");
    expect(config.minClientVersion).toBe("0.2.0");
  });

  it("rejects clients below the minimum version, except for bootstrap config", async () => {
    const headers = { "x-factory-client-version": "0.1.9" };
    const res = await app.request("/api/me", { headers });
    expect(res.status).toBe(426);
    expect(await res.json()).toMatchObject({ error: "client_too_old", minClientVersion: "0.2.0" });
    expect((await app.request("/api/client-config", { headers })).status).toBe(200);
  });

  it("requires a bearer token for /api/me", async () => {
    expect((await app.request("/api/me")).status).toBe(401);
  });

  it("returns the signed-in user and upserts them", async () => {
    const token = await sign({
      sub: "kc-123",
      azp: CLIENT_ID,
      preferred_username: "ada",
      name: "Ada Lovelace",
      email: "ada@example.com",
      realm_access: { roles: ["factory-user"] },
      resource_access: { [CLIENT_ID]: { roles: ["admin"] }, other: { roles: ["ignored"] } },
    });
    const res = await app.request("/api/me", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const me = Me.parse(await res.json());
    expect(me).toMatchObject({
      username: "ada",
      name: "Ada Lovelace",
      roles: ["admin", "factory-user"],
    });

    const again = Me.parse(
      await (
        await app.request("/api/me", { headers: { authorization: `Bearer ${token}` } })
      ).json(),
    );
    expect(again.id).toBe(me.id);
  });

  it("rejects tokens for another client or issuer", async () => {
    const otherClient = await sign({ sub: "x", azp: "some-other-app", aud: "account" });
    const otherIssuer = await sign(
      { sub: "x", azp: CLIENT_ID },
      { issuer: "https://evil.example.com" },
    );
    for (const token of [otherClient, otherIssuer, "not-a-jwt"]) {
      const res = await app.request("/api/me", { headers: { authorization: `Bearer ${token}` } });
      expect(res.status).toBe(401);
    }
  });

  it("serves the update feed and nothing outside it", async () => {
    const ok = await app.request("/updates/stable/latest.yml");
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-cache");
    expect(await ok.text()).toContain("0.2.0");

    for (const url of [
      "/updates/stable/missing.exe",
      "/updates/unknown/latest.yml",
      "/updates/stable/..%2F..%2Fetc%2Fpasswd",
      "/updates/stable/notes.txt",
    ]) {
      expect((await app.request(url)).status).toBe(404);
    }
  });
});
