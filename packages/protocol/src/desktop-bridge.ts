import type { ClientConfig } from "./client-config.js";
import type { Me } from "./me.js";

export type UpdateStatus =
  | { state: "disabled"; reason: string }
  | { state: "idle" }
  | { state: "checking" }
  | { state: "downloading"; version: string; percent: number }
  | { state: "ready"; version: string }
  | { state: "error"; message: string };

/** Everything the UI needs to render the shell. Owned by the Electron main process. */
export interface DesktopState {
  appVersion: string;
  serverUrl: string | null;
  channel: string;
  clientConfig: ClientConfig | null;
  me: Me | null;
  /** The server rejected this app version; only updating helps. */
  updateRequired: { minClientVersion: string } | null;
  update: UpdateStatus;
  busy: boolean;
  error: string | null;
}

/**
 * API exposed to the renderer as `window.factory` by the preload script.
 * Tokens never reach the renderer: authenticated calls go through `api()`.
 */
export interface DesktopBridge {
  getState(): Promise<DesktopState>;
  onStateChange(listener: (state: DesktopState) => void): () => void;
  connect(serverUrl: string): Promise<void>;
  disconnect(): Promise<void>;
  /** OIDC: opens the system browser. Dev auth mode: uses the given token. */
  signIn(devToken?: string): Promise<void>;
  signOut(): Promise<void>;
  setChannel(channel: string): Promise<void>;
  checkForUpdates(): Promise<void>;
  installUpdate(): Promise<void>;
  /** Authenticated GET against the server's /api. */
  api<T = unknown>(path: string): Promise<T>;
}

export const BRIDGE_CHANNELS = {
  getState: "factory:get-state",
  stateChanged: "factory:state-changed",
  connect: "factory:connect",
  disconnect: "factory:disconnect",
  signIn: "factory:sign-in",
  signOut: "factory:sign-out",
  setChannel: "factory:set-channel",
  checkForUpdates: "factory:check-for-updates",
  installUpdate: "factory:install-update",
  api: "factory:api",
} as const;
