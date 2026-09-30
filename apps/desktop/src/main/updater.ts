import type { UpdateStatus } from "@factory/protocol";
import { autoUpdater } from "electron-updater";
import type { UpdaterPort } from "./controller.js";

const CHECK_INTERVAL_MS = 60 * 60_000;

/** electron-updater against the server's generic feed (<server>/updates/<channel>). */
export function electronUpdater(): UpdaterPort {
  const listeners: Array<(s: UpdateStatus) => void> = [];
  const emit = (s: UpdateStatus) => {
    for (const l of listeners) l(s);
  };
  let feedSet = false;
  let pendingVersion = "";

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  // Each channel is its own feed directory, so no electron-updater channel logic needed.
  autoUpdater.allowPrerelease = true;
  autoUpdater.allowDowngrade = true; // switching beta → stable must be able to go back
  autoUpdater.on("checking-for-update", () => emit({ state: "checking" }));
  autoUpdater.on("update-not-available", () => emit({ state: "idle" }));
  autoUpdater.on("update-available", (info) => {
    pendingVersion = info.version;
    emit({ state: "downloading", version: info.version, percent: 0 });
  });
  autoUpdater.on("download-progress", (p) =>
    emit({ state: "downloading", version: pendingVersion, percent: p.percent }),
  );
  autoUpdater.on("update-downloaded", (info) => emit({ state: "ready", version: info.version }));
  autoUpdater.on("error", (err) => emit({ state: "error", message: err.message }));

  setInterval(() => {
    if (feedSet) void autoUpdater.checkForUpdates().catch(() => undefined);
  }, CHECK_INTERVAL_MS).unref();

  return {
    initialStatus: { state: "idle" },
    setFeed(url) {
      autoUpdater.setFeedURL({ provider: "generic", url });
      feedSet = true;
    },
    async check() {
      if (!feedSet) return;
      await autoUpdater.checkForUpdates().catch(() => undefined); // surfaced via "error" event
    },
    install() {
      autoUpdater.quitAndInstall(true, true);
    },
    onStatus(listener) {
      listeners.push(listener);
    },
  };
}

/** Used when running unpackaged (dev, tests): updates only make sense for installed builds. */
export function disabledUpdater(reason: string): UpdaterPort {
  return {
    initialStatus: { state: "disabled", reason },
    setFeed() {},
    async check() {},
    install() {},
    onStatus() {},
  };
}
