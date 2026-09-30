import path from "node:path";
import { BRIDGE_CHANNELS, type DesktopState } from "@factory/protocol";
import { app, BrowserWindow, ipcMain, shell } from "electron";
import { DesktopController } from "./controller.js";
import { fileConfigStore, safeSecretStore } from "./stores.js";
import { disabledUpdater, electronUpdater } from "./updater.js";

// Tests and parallel dev instances can isolate their profile.
if (process.env.FACTORY_USER_DATA_DIR) app.setPath("userData", process.env.FACTORY_USER_DATA_DIR);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void main();
}

async function main() {
  await app.whenReady();
  const userData = app.getPath("userData");
  let window: BrowserWindow | null = null;

  const controller = new DesktopController({
    appVersion: app.getVersion(),
    config: fileConfigStore(userData, { serverUrl: process.env.FACTORY_SERVER_URL ?? null }),
    secrets: safeSecretStore(userData),
    updater: app.isPackaged ? electronUpdater() : disabledUpdater("development build"),
    openExternal: (url) => shell.openExternal(url),
    onState: (state: DesktopState) => window?.webContents.send(BRIDGE_CHANNELS.stateChanged, state),
  });

  ipcMain.handle(BRIDGE_CHANNELS.getState, () => controller.getState());
  ipcMain.handle(BRIDGE_CHANNELS.connect, (_e, url: string) => controller.connect(String(url)));
  ipcMain.handle(BRIDGE_CHANNELS.disconnect, () => controller.disconnect());
  ipcMain.handle(BRIDGE_CHANNELS.signIn, (_e, devToken?: string) =>
    controller.signIn(typeof devToken === "string" ? devToken : undefined),
  );
  ipcMain.handle(BRIDGE_CHANNELS.signOut, () => controller.signOut());
  ipcMain.handle(BRIDGE_CHANNELS.setChannel, (_e, channel: string) =>
    controller.setChannel(String(channel)),
  );
  ipcMain.handle(BRIDGE_CHANNELS.checkForUpdates, () => controller.checkForUpdates());
  ipcMain.handle(BRIDGE_CHANNELS.installUpdate, () => controller.installUpdate());
  ipcMain.handle(BRIDGE_CHANNELS.api, (_e, apiPath: string) => controller.api(String(apiPath)));
  ipcMain.handle(BRIDGE_CHANNELS.request, (_e, method: string, apiPath: string, body?: unknown) => {
    if (!["GET", "POST", "PATCH", "DELETE"].includes(method)) throw new Error("bad method");
    return controller.request(method, String(apiPath), body);
  });
  const streams = new Map<string, () => void>();
  const closeAllStreams = () => {
    for (const close of streams.values()) close();
    streams.clear();
  };
  let nextStream = 0;
  ipcMain.handle(BRIDGE_CHANNELS.openStream, (_e, apiPath: string) => {
    const id = String(++nextStream);
    streams.set(
      id,
      controller.openStream(String(apiPath), (data) =>
        window?.webContents.send(BRIDGE_CHANNELS.streamEvent, id, data),
      ),
    );
    return id;
  });
  ipcMain.handle(BRIDGE_CHANNELS.closeStream, (_e, id: string) => {
    streams.get(String(id))?.();
    streams.delete(String(id));
  });

  const createWindow = () => {
    window = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 720,
      minHeight: 480,
      title: "The Factory",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(__dirname, "preload.cjs"),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    // Links open in the system browser, never inside the app.
    window.webContents.setWindowOpenHandler(({ url }) => {
      if (url.startsWith("https://") || url.startsWith("http://")) void shell.openExternal(url);
      return { action: "deny" };
    });
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.on("closed", () => {
      window = null;
      closeAllStreams();
    });
    // A reload drops the renderer's subscriptions, so close their streams too.
    window.webContents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) closeAllStreams();
    });

    const devUrl = process.env.FACTORY_UI_DEV_URL;
    if (devUrl && !app.isPackaged) void window.loadURL(devUrl);
    else void window.loadFile(path.join(__dirname, "renderer", "index.html"));
  };

  app.on("second-instance", () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });
  app.on("window-all-closed", () => app.quit());

  createWindow();
  await controller.init();
}
