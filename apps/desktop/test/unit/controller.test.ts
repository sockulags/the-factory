import type { ClientConfig, DesktopState, UpdateStatus } from "@factory/protocol";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  type ConfigStore,
  DesktopController,
  normalizeServerUrl,
  type SecretStore,
  type StoredConfig,
  type UpdaterPort,
} from "../../src/main/controller.js";
import { headlessBrowser, type MockOidc, startMockOidc } from "../support/mock-oidc.js";

const SERVER = "https://factory.internal";

function memoryStores() {
  let config: StoredConfig = { serverUrl: null, channel: "stable" };
  let secret: string | null = null;
  const configStore: ConfigStore = {
    load: async () => config,
    save: async (c) => {
      config = c;
    },
  };
  const secrets: SecretStore = {
    load: async () => secret,
    save: async (v) => {
      secret = v;
    },
    clear: async () => {
      secret = null;
    },
  };
  return { configStore, secrets, peekSecret: () => secret };
}

function fakeUpdater() {
  const feeds: string[] = [];
  let listener: (s: UpdateStatus) => void = () => {};
  const updater: UpdaterPort = {
    initialStatus: { state: "idle" },
    setFeed: (url) => feeds.push(url),
    check: async () => {},
    install: () => {},
    onStatus: (l) => {
      listener = l;
    },
  };
  return { updater, feeds, emit: (s: UpdateStatus) => listener(s) };
}

describe("DesktopController", () => {
  let idp: MockOidc;
  let minClientVersion: string;
  let meRequests: string[];

  beforeAll(async () => {
    idp = await startMockOidc({
      clientId: "factory-desktop",
      user: {
        sub: "u1",
        preferred_username: "ada",
        name: "Ada Lovelace",
        email: "ada@example.com",
      },
    });
  });
  afterAll(() => idp.close());
  beforeEach(() => {
    minClientVersion = "0.0.0";
    meRequests = [];
  });

  /** Fake Factory server in front of the mock IdP; other URLs pass through to real fetch. */
  const serverFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    if (!url.startsWith(SERVER)) return fetch(input, init);
    const headers = new Headers(init?.headers);
    if (url === `${SERVER}/api/client-config`) {
      const config: ClientConfig = {
        serverVersion: "0.1.0",
        minClientVersion,
        auth: { mode: "oidc", issuer: idp.issuer, clientId: idp.clientId, scopes: ["openid"] },
        updates: { baseUrl: `${SERVER}/updates`, channels: ["stable", "beta"] },
      };
      return Response.json(config);
    }
    if (url === `${SERVER}/api/me`) {
      const version = headers.get("x-factory-client-version") ?? "";
      if (version < minClientVersion) return Response.json({ minClientVersion }, { status: 426 });
      const token = headers.get("authorization")?.replace("Bearer ", "") ?? "";
      meRequests.push(token);
      if (!token) return new Response(null, { status: 401 });
      return Response.json({
        id: "1",
        username: "ada",
        name: "Ada Lovelace",
        email: null,
        roles: [],
      });
    }
    return new Response(null, { status: 404 });
  };

  function makeController(stores = memoryStores(), upd = fakeUpdater()) {
    const states: DesktopState[] = [];
    const controller = new DesktopController({
      appVersion: "0.1.0",
      config: stores.configStore,
      secrets: stores.secrets,
      updater: upd.updater,
      openExternal: headlessBrowser,
      fetch: serverFetch,
      onState: (s) => states.push(s),
    });
    return { controller, states, stores, upd };
  }

  it("connects, signs in via OIDC, and restores the session on restart", async () => {
    const { controller, stores, upd } = makeController();
    await controller.init();
    await controller.connect("factory.internal/");
    expect(controller.getState()).toMatchObject({ serverUrl: SERVER, error: null });
    expect(upd.feeds.at(-1)).toBe(`${SERVER}/updates/stable`);

    await controller.signIn();
    expect(controller.getState().me?.name).toBe("Ada Lovelace");
    expect(stores.peekSecret()).toContain("accessToken");

    // "Restart": same stores, new controller.
    const restarted = makeController(stores);
    await restarted.controller.init();
    expect(restarted.controller.getState().me?.username).toBe("ada");
  });

  it("refreshes an expiring access token before calling the API", async () => {
    const { controller } = makeController();
    await controller.init();
    await controller.connect(SERVER);
    const refreshes = () => idp.issued.filter((i) => i.grant === "refresh_token").length;
    const before = refreshes();
    idp.expireNextTokens();
    await controller.signIn(); // loads /me with an already-expired token → refresh
    expect(refreshes()).toBe(before + 1);
    expect(controller.getState().me?.username).toBe("ada");
    await controller.api("/me"); // fresh token now → no further refresh
    expect(refreshes()).toBe(before + 1);
  });

  it("signs out locally and at the IdP", async () => {
    const { controller, stores } = makeController();
    await controller.init();
    await controller.connect(SERVER);
    await controller.signIn();
    const loggedOutBefore = idp.loggedOut.length;
    await controller.signOut();
    expect(controller.getState().me).toBeNull();
    expect(stores.peekSecret()).toBeNull();
    expect(idp.loggedOut.length).toBe(loggedOutBefore + 1);
  });

  it("flags an outdated client and switches update channels", async () => {
    const { controller, upd } = makeController();
    await controller.init();
    await controller.connect(SERVER);
    await controller.signIn();
    minClientVersion = "0.2.0";
    await expect(controller.api("/me")).rejects.toThrow(/too old/);
    expect(controller.getState().updateRequired).toEqual({ minClientVersion: "0.2.0" });

    await controller.setChannel("beta");
    expect(upd.feeds.at(-1)).toBe(`${SERVER}/updates/beta`);
    await expect(controller.setChannel("nightly")).rejects.toThrow(/Unknown update channel/);
  });

  it("reports unreachable servers in plain language", async () => {
    const { controller } = makeController();
    await controller.init();
    await controller.connect("https://nowhere.invalid");
    expect(controller.getState().error).toMatch(/Could not reach|did not answer/);
    expect(controller.getState().serverUrl).toBeNull();
  });
});

describe("normalizeServerUrl", () => {
  it.each([
    ["factory.internal", "https://factory.internal"],
    ["https://factory.internal/", "https://factory.internal"],
    ["http://10.0.0.5:8787", "http://10.0.0.5:8787"],
    ["https://host/sub/path//", "https://host/sub/path"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeServerUrl(input)).toBe(expected);
  });
  it("rejects nonsense", () => {
    expect(() => normalizeServerUrl("ftp://x")).toThrow();
  });
});
