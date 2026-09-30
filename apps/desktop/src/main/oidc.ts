// OIDC Authorization Code + PKCE for a native app (RFC 8252): the system browser
// signs the user in and redirects to a one-shot loopback server on 127.0.0.1.
// No Electron imports so it can be tested against a mock provider.
import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

export interface OidcTokens {
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  /** Epoch ms when the access token expires. */
  expiresAt: number;
}

export interface OidcClientOptions {
  issuer: string;
  clientId: string;
  scopes: string[];
  fetch?: typeof fetch;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

export class OidcError extends Error {}

const SIGN_IN_TIMEOUT_MS = 5 * 60_000;

export class OidcClient {
  private discovery: Promise<Discovery> | undefined;
  private readonly fetch: typeof fetch;

  constructor(private readonly options: OidcClientOptions) {
    this.fetch = options.fetch ?? fetch;
  }

  /** Runs the interactive sign-in. `openBrowser` should open the URL in the system browser. */
  async signIn(
    openBrowser: (url: string) => Promise<void>,
    timeoutMs = SIGN_IN_TIMEOUT_MS,
  ): Promise<OidcTokens> {
    const { authorization_endpoint, token_endpoint } = await this.discover();
    const verifier = base64url(randomBytes(32));
    const challenge = base64url(createHash("sha256").update(verifier).digest());
    const state = base64url(randomBytes(16));

    const loopback = await startLoopback(state, timeoutMs);
    try {
      const url = new URL(authorization_endpoint);
      url.search = new URLSearchParams({
        response_type: "code",
        client_id: this.options.clientId,
        redirect_uri: loopback.redirectUri,
        scope: this.options.scopes.join(" "),
        state,
        code_challenge: challenge,
        code_challenge_method: "S256",
      }).toString();
      await openBrowser(url.toString());
      const code = await loopback.code;
      return await this.tokenRequest(token_endpoint, {
        grant_type: "authorization_code",
        code,
        redirect_uri: loopback.redirectUri,
        client_id: this.options.clientId,
        code_verifier: verifier,
      });
    } finally {
      loopback.close();
    }
  }

  async refresh(refreshToken: string): Promise<OidcTokens> {
    const { token_endpoint } = await this.discover();
    const tokens = await this.tokenRequest(token_endpoint, {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.options.clientId,
    });
    // Some providers don't rotate refresh tokens; keep the old one then.
    return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
  }

  /** Ends the IdP session (Keycloak accepts a refresh token from public clients). Best effort. */
  async signOut(refreshToken: string | null): Promise<void> {
    if (!refreshToken) return;
    const { end_session_endpoint } = await this.discover();
    if (!end_session_endpoint) return;
    await this.fetch(end_session_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: this.options.clientId, refresh_token: refreshToken }),
    }).catch(() => undefined);
  }

  private discover(): Promise<Discovery> {
    this.discovery ??= (async () => {
      const res = await this.fetch(
        `${this.options.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`,
      );
      if (!res.ok) throw new OidcError(`Could not reach the sign-in provider (HTTP ${res.status})`);
      return (await res.json()) as Discovery;
    })().catch((err) => {
      this.discovery = undefined;
      throw err;
    });
    return this.discovery;
  }

  private async tokenRequest(
    endpoint: string,
    params: Record<string, string>,
  ): Promise<OidcTokens> {
    const res = await this.fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || typeof body.access_token !== "string") {
      throw new OidcError(
        `Token request failed: ${body.error_description ?? body.error ?? `HTTP ${res.status}`}`,
      );
    }
    const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 300;
    return {
      accessToken: body.access_token,
      refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
      idToken: typeof body.id_token === "string" ? body.id_token : null,
      expiresAt: Date.now() + expiresIn * 1000,
    };
  }
}

interface Loopback {
  redirectUri: string;
  code: Promise<string>;
  close(): void;
}

const DONE_PAGE = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>The Factory</title>` +
  `<body style="font-family:system-ui;display:grid;place-items:center;height:90vh">` +
  `<p>${message}</p></body>`;

async function startLoopback(expectedState: string, timeoutMs: number): Promise<Loopback> {
  let resolve!: (code: string) => void;
  let reject!: (err: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  code.catch(() => undefined); // surfaced via the awaited promise, avoid unhandled rejection noise

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const error = url.searchParams.get("error");
    const returnedCode = url.searchParams.get("code");
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    if (url.searchParams.get("state") !== expectedState) {
      res.end(DONE_PAGE("Sign-in failed. Please try again from The Factory."));
      reject(new OidcError("Sign-in response did not match the request (state mismatch)"));
    } else if (error || !returnedCode) {
      res.end(DONE_PAGE("Sign-in was cancelled or failed. You can close this window."));
      reject(
        new OidcError(
          `Sign-in failed: ${url.searchParams.get("error_description") ?? error ?? "no code"}`,
        ),
      );
    } else {
      res.end(DONE_PAGE("Signed in. You can close this window and return to The Factory."));
      resolve(returnedCode);
    }
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
  const { port } = server.address() as AddressInfo;
  const timer = setTimeout(() => reject(new OidcError("Sign-in timed out")), timeoutMs);

  return {
    redirectUri: `http://127.0.0.1:${port}/callback`,
    code,
    close() {
      clearTimeout(timer);
      server.close();
    },
  };
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}
