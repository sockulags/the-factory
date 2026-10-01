import {
  CLIENT_TOO_OLD_STATUS,
  CLIENT_VERSION_HEADER,
  ClientConfig,
  type DesktopState,
  Me,
  type UpdateStatus,
} from "@factory/protocol";
import { OidcClient, type OidcTokens } from "./oidc.js";

export interface StoredConfig {
  serverUrl: string | null;
  channel: string;
}

export interface ConfigStore {
  load(): Promise<StoredConfig>;
  save(config: StoredConfig): Promise<void>;
}

/** Encrypted at rest by the caller (Electron safeStorage → Windows DPAPI). */
export interface SecretStore {
  load(): Promise<string | null>;
  save(value: string): Promise<void>;
  clear(): Promise<void>;
}

export interface UpdaterPort {
  setFeed(url: string): void;
  check(): Promise<void>;
  install(): void;
  onStatus(listener: (status: UpdateStatus) => void): void;
  readonly initialStatus: UpdateStatus;
}

export interface ControllerDeps {
  appVersion: string;
  config: ConfigStore;
  secrets: SecretStore;
  updater: UpdaterPort;
  openExternal(url: string): Promise<void>;
  fetch?: typeof fetch;
  onState(state: DesktopState): void;
}

interface StoredSession {
  serverUrl: string;
  mode: "oidc" | "dev";
  tokens: OidcTokens;
}

/** Refresh the access token when it has less than this left. */
const REFRESH_MARGIN_MS = 60_000;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Owns connection, sign-in and update state for the desktop app. Electron-free: the
 * main process wires it to IPC, safeStorage, shell and electron-updater.
 */
export class DesktopController {
  private state: DesktopState;
  private session: StoredSession | null = null;
  private oidc: OidcClient | null = null;
  private readonly fetch: typeof fetch;

  constructor(private readonly deps: ControllerDeps) {
    this.fetch = deps.fetch ?? fetch;
    this.state = {
      appVersion: deps.appVersion,
      serverUrl: null,
      channel: "stable",
      clientConfig: null,
      me: null,
      updateRequired: null,
      update: deps.updater.initialStatus,
      busy: false,
      error: null,
    };
    deps.updater.onStatus((update) => this.patch({ update }));
  }

  getState(): DesktopState {
    return this.state;
  }

  async init(): Promise<void> {
    const stored = await this.deps.config.load();
    this.patch({ serverUrl: stored.serverUrl, channel: stored.channel });
    const rawSession = await this.deps.secrets.load().catch(() => null);
    if (rawSession) {
      try {
        this.session = JSON.parse(rawSession) as StoredSession;
      } catch {
        await this.deps.secrets.clear();
      }
    }
    if (stored.serverUrl) {
      await this.run(async () => {
        await this.loadClientConfig(stored.serverUrl as string);
        if (this.session?.serverUrl === stored.serverUrl) await this.refreshMe();
      });
    }
  }

  async connect(rawUrl: string): Promise<void> {
    await this.run(async () => {
      const serverUrl = normalizeServerUrl(rawUrl);
      await this.loadClientConfig(serverUrl);
      if (this.session && this.session.serverUrl !== serverUrl) await this.clearSession();
      await this.deps.config.save({ serverUrl, channel: this.state.channel });
      this.patch({ serverUrl });
    });
  }

  async disconnect(): Promise<void> {
    await this.clearSession();
    await this.deps.config.save({ serverUrl: null, channel: this.state.channel });
    this.oidc = null;
    this.patch({
      serverUrl: null,
      clientConfig: null,
      me: null,
      error: null,
      updateRequired: null,
    });
  }

  async signIn(devToken?: string): Promise<void> {
    await this.run(async () => {
      const { serverUrl, clientConfig } = this.requireConnection();
      let tokens: OidcTokens;
      if (clientConfig.auth.mode === "dev") {
        if (!devToken) throw new Error("Enter the dev token");
        tokens = {
          accessToken: devToken,
          refreshToken: null,
          idToken: null,
          expiresAt: Number.MAX_SAFE_INTEGER,
        };
      } else {
        tokens = await this.requireOidc().signIn(this.deps.openExternal);
      }
      await this.saveSession({ serverUrl, mode: clientConfig.auth.mode, tokens });
      await this.refreshMe();
    });
  }

  async signOut(): Promise<void> {
    const refreshToken = this.session?.tokens.refreshToken ?? null;
    await this.clearSession();
    this.patch({ me: null, error: null });
    if (this.oidc) await this.oidc.signOut(refreshToken);
  }

  async setChannel(channel: string): Promise<void> {
    const channels = this.state.clientConfig?.updates.channels ?? [];
    if (!channels.includes(channel)) throw new Error(`Unknown update channel: ${channel}`);
    await this.deps.config.save({ serverUrl: this.state.serverUrl, channel });
    this.patch({ channel });
    this.configureUpdates();
  }

  async checkForUpdates(): Promise<void> {
    await this.deps.updater.check();
  }

  installUpdate(): void {
    this.deps.updater.install();
  }

  /** Authenticated GET against the server's /api. Refreshes the token once on 401. */
  api<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  /** Authenticated request against the server's /api. Refreshes the token once on 401. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    if (!path.startsWith("/")) throw new Error("api path must start with /");
    const { serverUrl } = this.requireConnection();
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.validAccessToken(attempt > 0);
      const res = await this.fetch(`${serverUrl}/api${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          [CLIENT_VERSION_HEADER]: this.deps.appVersion,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0 && this.session?.tokens.refreshToken) continue;
      if (res.status === 401) {
        await this.clearSession();
        this.patch({ me: null });
        throw new ApiError(401, "Your session has expired. Please sign in again.");
      }
      if (res.status === CLIENT_TOO_OLD_STATUS) {
        const body = (await res.json().catch(() => ({}))) as { minClientVersion?: string };
        this.patch({ updateRequired: { minClientVersion: body.minClientVersion ?? "?" } });
        void this.deps.updater.check();
        throw new ApiError(res.status, "This version of The Factory is too old. Updating…");
      }
      if (!res.ok) {
        const detail = (await res.json().catch(() => ({}))) as { detail?: string };
        throw new ApiError(res.status, detail.detail ?? `Server error (HTTP ${res.status})`);
      }
      return (await res.json()) as T;
    }
    throw new ApiError(401, "unreachable");
  }

  /**
   * Opens a server-sent-event stream and calls `onData` with each JSON payload.
   * Reconnects with backoff until the returned function is called.
   */
  openStream(path: string, onData: (data: unknown) => void): () => void {
    const controller = new AbortController();
    let stopped = false;
    const run = async () => {
      let delay = 1000;
      while (!stopped) {
        try {
          const { serverUrl } = this.requireConnection();
          const token = await this.validAccessToken(false);
          const res = await this.fetch(`${serverUrl}/api${path}`, {
            headers: {
              authorization: `Bearer ${token}`,
              accept: "text/event-stream",
              [CLIENT_VERSION_HEADER]: this.deps.appVersion,
            },
            signal: controller.signal,
          });
          if (res.status === 401) await this.validAccessToken(true);
          else if (res.ok && res.body) {
            delay = 1000;
            await readSse(res.body, onData);
          }
        } catch {
          // network drop, abort, or signed out: retry below unless stopped
        }
        if (stopped) break;
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 2, 30_000);
      }
    };
    void run();
    return () => {
      stopped = true;
      controller.abort();
    };
  }

  private async refreshMe(): Promise<void> {
    try {
      const me = Me.parse(await this.api("/me"));
      this.patch({ me });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) return; // shows the sign-in screen
      throw err;
    }
  }

  private async validAccessToken(forceRefresh: boolean): Promise<string> {
    const session = this.session;
    if (!session) throw new ApiError(401, "Not signed in");
    const expiring = session.tokens.expiresAt - Date.now() < REFRESH_MARGIN_MS;
    if ((forceRefresh || expiring) && session.mode === "oidc" && session.tokens.refreshToken) {
      try {
        const tokens = await this.requireOidc().refresh(session.tokens.refreshToken);
        await this.saveSession({ ...session, tokens });
      } catch {
        await this.clearSession();
        this.patch({ me: null });
        throw new ApiError(401, "Your session has expired. Please sign in again.");
      }
    }
    return (this.session as StoredSession).tokens.accessToken;
  }

  private async loadClientConfig(serverUrl: string): Promise<void> {
    let res: Response;
    try {
      res = await this.fetch(`${serverUrl}/api/client-config`, {
        headers: { [CLIENT_VERSION_HEADER]: this.deps.appVersion },
      });
    } catch {
      throw new Error(`Could not reach ${serverUrl}. Are you on the VPN?`);
    }
    if (!res.ok)
      throw new Error(`${serverUrl} did not answer like a Factory server (HTTP ${res.status})`);
    const parsed = ClientConfig.safeParse(await res.json().catch(() => null));
    if (!parsed.success) throw new Error(`${serverUrl} did not answer like a Factory server`);
    const clientConfig = parsed.data;
    this.oidc =
      clientConfig.auth.mode === "oidc"
        ? new OidcClient({
            issuer: clientConfig.auth.issuer,
            clientId: clientConfig.auth.clientId,
            scopes: clientConfig.auth.scopes,
            fetch: this.fetch,
          })
        : null;
    const channel = clientConfig.updates.channels.includes(this.state.channel)
      ? this.state.channel
      : (clientConfig.updates.channels[0] ?? "stable");
    this.patch({ clientConfig, channel, updateRequired: null });
    this.configureUpdates();
    void this.deps.updater.check();
  }

  private configureUpdates(): void {
    const base = this.state.clientConfig?.updates.baseUrl;
    if (base) this.deps.updater.setFeed(`${base.replace(/\/$/, "")}/${this.state.channel}`);
  }

  private requireConnection() {
    const { serverUrl, clientConfig } = this.state;
    if (!serverUrl || !clientConfig) throw new Error("Not connected to a server");
    return { serverUrl, clientConfig };
  }

  private requireOidc(): OidcClient {
    if (!this.oidc) throw new Error("Server does not use OIDC sign-in");
    return this.oidc;
  }

  private async saveSession(session: StoredSession): Promise<void> {
    this.session = session;
    await this.deps.secrets.save(JSON.stringify(session));
  }

  private async clearSession(): Promise<void> {
    this.session = null;
    await this.deps.secrets.clear();
  }

  private async run(task: () => Promise<void>): Promise<void> {
    this.patch({ busy: true, error: null });
    try {
      await task();
    } catch (err) {
      this.patch({ error: (err as Error).message });
    } finally {
      this.patch({ busy: false });
    }
  }

  private patch(changes: Partial<DesktopState>): void {
    this.state = { ...this.state, ...changes };
    this.deps.onState(this.state);
  }
}

export function normalizeServerUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new Error("That doesn't look like a server address");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:")
    throw new Error("Use an http(s) address");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** Parses a text/event-stream body; ignores comments, pings and non-JSON data. */
export async function readSse(
  body: ReadableStream<Uint8Array>,
  onData: (data: unknown) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");
      const lines = block.split("\n");
      if (lines.includes("event: ping")) continue;
      const data = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).replace(/^ /, ""))
        .join("\n");
      if (!data) continue;
      try {
        onData(JSON.parse(data));
      } catch {
        // not JSON: ignore
      }
    }
  }
}
