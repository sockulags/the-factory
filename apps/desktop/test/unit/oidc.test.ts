import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OidcClient } from "../../src/main/oidc.js";
import { headlessBrowser, type MockOidc, startMockOidc } from "../support/mock-oidc.js";

describe("OidcClient", () => {
  let idp: MockOidc;
  beforeAll(async () => {
    idp = await startMockOidc({
      clientId: "factory-desktop",
      user: { sub: "u1", preferred_username: "ada", name: "Ada", email: "ada@example.com" },
    });
  });
  afterAll(() => idp.close());

  const client = () =>
    new OidcClient({ issuer: idp.issuer, clientId: idp.clientId, scopes: ["openid"] });

  it("signs in with authorization code + PKCE via a loopback redirect", async () => {
    let opened = "";
    const tokens = await client().signIn(async (url) => {
      opened = url;
      await headlessBrowser(url);
    });
    const params = new URL(opened).searchParams;
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(tokens.accessToken.split(".")).toHaveLength(3);
    expect(tokens.refreshToken).toBeTruthy();
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
  });

  it("refreshes tokens", async () => {
    const c = client();
    const tokens = await c.signIn(headlessBrowser);
    const refreshed = await c.refresh(tokens.refreshToken as string);
    expect(refreshed.accessToken).not.toBe(tokens.accessToken);
    await expect(c.refresh(tokens.refreshToken as string)).rejects.toThrow(/invalid_grant/);
  });

  it("rejects a callback with the wrong state", async () => {
    const attempt = client().signIn(async (url) => {
      const redirect = new URL(new URL(url).searchParams.get("redirect_uri") as string);
      redirect.searchParams.set("code", "x");
      redirect.searchParams.set("state", "forged");
      await fetch(redirect);
    });
    await expect(attempt).rejects.toThrow(/state mismatch/);
  });

  it("times out when the user never finishes", async () => {
    await expect(client().signIn(async () => {}, 50)).rejects.toThrow(/timed out/);
  });
});
