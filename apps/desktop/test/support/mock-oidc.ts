// A tiny OIDC provider that behaves like Keycloak for the parts we use:
// discovery, authorization code + PKCE (S256), refresh tokens, JWKS, logout.
import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { exportJWK, generateKeyPair, type JWK, SignJWT } from "jose";

export interface MockUser {
  sub: string;
  preferred_username: string;
  name: string;
  email: string;
}

export interface MockOidc {
  issuer: string;
  clientId: string;
  /** Tokens issued so far, for assertions. */
  issued: { grant: string }[];
  loggedOut: string[];
  /** Makes the next token response expire immediately (forces a refresh). */
  expireNextTokens(): void;
  close(): Promise<void>;
}

export async function startMockOidc(opts: { clientId: string; user: MockUser }): Promise<MockOidc> {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: "mock-1", alg: "RS256", use: "sig" };
  const codes = new Map<string, { challenge: string; redirectUri: string }>();
  const refreshTokens = new Set<string>();
  const issued: { grant: string }[] = [];
  const loggedOut: string[] = [];
  let expireNext = false;
  let issuer = "";

  const signAccessToken = () =>
    new SignJWT({
      ...opts.user,
      azp: opts.clientId,
      aud: "account",
      realm_access: { roles: ["factory-user", "factory-admin"] },
    })
      .setProtectedHeader({ alg: "RS256", kid: "mock-1" })
      .setIssuer(issuer)
      .setJti(randomBytes(8).toString("hex"))
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  const tokenResponse = async () => {
    const refresh = randomBytes(16).toString("hex");
    refreshTokens.add(refresh);
    const expiresIn = expireNext ? 0 : 300;
    expireNext = false;
    return {
      access_token: await signAccessToken(),
      refresh_token: refresh,
      token_type: "Bearer",
      expires_in: expiresIn,
    };
  };

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", issuer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
    };
    const readForm = async () => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      return new URLSearchParams(raw);
    };

    if (url.pathname.endsWith("/.well-known/openid-configuration")) {
      return json(200, {
        issuer,
        authorization_endpoint: `${issuer}/protocol/openid-connect/auth`,
        token_endpoint: `${issuer}/protocol/openid-connect/token`,
        end_session_endpoint: `${issuer}/protocol/openid-connect/logout`,
        jwks_uri: `${issuer}/protocol/openid-connect/certs`,
      });
    }
    if (url.pathname.endsWith("/protocol/openid-connect/certs")) return json(200, { keys: [jwk] });

    if (url.pathname.endsWith("/protocol/openid-connect/auth")) {
      // Simulates the user signing in successfully in the browser.
      const p = url.searchParams;
      const redirectUri = p.get("redirect_uri") ?? "";
      if (p.get("client_id") !== opts.clientId || p.get("code_challenge_method") !== "S256") {
        return json(400, { error: "invalid_request" });
      }
      if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(redirectUri))
        return json(400, { error: "invalid_redirect_uri" });
      const code = randomBytes(8).toString("hex");
      codes.set(code, { challenge: p.get("code_challenge") ?? "", redirectUri });
      const target = new URL(redirectUri);
      target.searchParams.set("code", code);
      target.searchParams.set("state", p.get("state") ?? "");
      res.writeHead(302, { location: target.toString() }).end();
      return;
    }

    if (url.pathname.endsWith("/protocol/openid-connect/token") && req.method === "POST") {
      const form = await readForm();
      if (form.get("client_id") !== opts.clientId) return json(401, { error: "invalid_client" });
      const grant = form.get("grant_type") ?? "";
      if (grant === "authorization_code") {
        const entry = codes.get(form.get("code") ?? "");
        codes.delete(form.get("code") ?? "");
        const verifier = form.get("code_verifier") ?? "";
        const expected = createHash("sha256").update(verifier).digest("base64url");
        if (
          !entry ||
          entry.challenge !== expected ||
          entry.redirectUri !== form.get("redirect_uri")
        ) {
          return json(400, {
            error: "invalid_grant",
            error_description: "PKCE or code check failed",
          });
        }
      } else if (grant === "refresh_token") {
        const token = form.get("refresh_token") ?? "";
        if (!refreshTokens.delete(token)) return json(400, { error: "invalid_grant" });
      } else {
        return json(400, { error: "unsupported_grant_type" });
      }
      issued.push({ grant });
      return json(200, await tokenResponse());
    }

    if (url.pathname.endsWith("/protocol/openid-connect/logout") && req.method === "POST") {
      const form = await readForm();
      const token = form.get("refresh_token") ?? "";
      refreshTokens.delete(token);
      loggedOut.push(token);
      res.writeHead(204).end();
      return;
    }
    json(404, { error: "not_found" });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${(server.address() as AddressInfo).port}/realms/factory`;

  return {
    issuer,
    clientId: opts.clientId,
    issued,
    loggedOut,
    expireNextTokens: () => {
      expireNext = true;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/** Acts as the system browser: follows the IdP redirect back to the app's loopback server. */
export async function headlessBrowser(url: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`browser got HTTP ${res.status}`);
}
