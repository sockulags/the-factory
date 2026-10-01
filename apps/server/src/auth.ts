import { timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from "jose";

export interface Identity {
  subject: string;
  username: string;
  name: string | null;
  email: string | null;
  roles: string[];
}

export type Authenticator = (token: string) => Promise<Identity>;

export class AuthError extends Error {}

export interface OidcAuthOptions {
  issuer: string;
  clientId: string;
  /** Override key lookup (tests). Defaults to the issuer's JWKS from discovery. */
  keys?: JWTVerifyGetKey;
  fetch?: typeof fetch;
}

/**
 * Validates access tokens issued by an OIDC provider (Keycloak).
 * Accepts tokens issued to the desktop client (`azp`) or naming it in `aud`.
 */
export function createOidcAuthenticator(options: OidcAuthOptions): Authenticator {
  const doFetch = options.fetch ?? fetch;
  let keys: Promise<JWTVerifyGetKey> | undefined = options.keys
    ? Promise.resolve(options.keys)
    : undefined;

  const getKeys = () => {
    keys ??= discoverJwks(options.issuer, doFetch).catch((err) => {
      keys = undefined; // retry discovery on the next request
      throw err;
    });
    return keys;
  };

  return async (token) => {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, await getKeys(), { issuer: options.issuer }));
    } catch (err) {
      throw new AuthError(`invalid token: ${(err as Error).message}`);
    }
    const aud = Array.isArray(payload.aud) ? payload.aud : payload.aud ? [payload.aud] : [];
    if (payload.azp !== options.clientId && !aud.includes(options.clientId)) {
      throw new AuthError("token was not issued for this application");
    }
    if (!payload.sub) throw new AuthError("token has no subject");
    return identityFromClaims(payload, options.clientId);
  };
}

async function discoverJwks(issuer: string, doFetch: typeof fetch): Promise<JWTVerifyGetKey> {
  const res = await doFetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  if (!res.ok) throw new AuthError(`OIDC discovery failed: HTTP ${res.status}`);
  const { jwks_uri } = (await res.json()) as { jwks_uri?: string };
  if (!jwks_uri) throw new AuthError("OIDC discovery document has no jwks_uri");
  return createRemoteJWKSet(new URL(jwks_uri));
}

interface KeycloakClaims extends JWTPayload {
  preferred_username?: string;
  name?: string;
  email?: string;
  realm_access?: { roles?: string[] };
  resource_access?: Record<string, { roles?: string[] }>;
}

export function identityFromClaims(payload: KeycloakClaims, clientId: string): Identity {
  const roles = new Set([
    ...(payload.realm_access?.roles ?? []),
    ...(payload.resource_access?.[clientId]?.roles ?? []),
  ]);
  return {
    subject: payload.sub ?? "",
    username: payload.preferred_username ?? payload.sub ?? "",
    name: payload.name ?? null,
    email: payload.email ?? null,
    roles: [...roles].sort(),
  };
}

/** Local development only: a single static token maps to a fixed user. */
export function createDevAuthenticator(devToken: string): Authenticator {
  const expected = Buffer.from(devToken);
  return async (token) => {
    const given = Buffer.from(token);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new AuthError("invalid dev token");
    }
    return {
      subject: "dev-user",
      username: "dev",
      name: "Developer",
      email: null,
      roles: ["factory-admin"],
    };
  };
}
