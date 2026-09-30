import { BRIDGE_CHANNELS, type DesktopBridge, type DesktopState } from "@factory/protocol";
import { contextBridge, ipcRenderer } from "electron";

const bridge: DesktopBridge = {
  getState: () => ipcRenderer.invoke(BRIDGE_CHANNELS.getState),
  onStateChange(listener) {
    const handler = (_e: unknown, state: DesktopState) => listener(state);
    ipcRenderer.on(BRIDGE_CHANNELS.stateChanged, handler);
    return () => ipcRenderer.off(BRIDGE_CHANNELS.stateChanged, handler);
  },
  connect: (url) => ipcRenderer.invoke(BRIDGE_CHANNELS.connect, url),
  disconnect: () => ipcRenderer.invoke(BRIDGE_CHANNELS.disconnect),
  signIn: (devToken) => ipcRenderer.invoke(BRIDGE_CHANNELS.signIn, devToken),
  signOut: () => ipcRenderer.invoke(BRIDGE_CHANNELS.signOut),
  setChannel: (channel) => ipcRenderer.invoke(BRIDGE_CHANNELS.setChannel, channel),
  checkForUpdates: () => ipcRenderer.invoke(BRIDGE_CHANNELS.checkForUpdates),
  installUpdate: () => ipcRenderer.invoke(BRIDGE_CHANNELS.installUpdate),
  api: (apiPath) => ipcRenderer.invoke(BRIDGE_CHANNELS.api, apiPath),
};

contextBridge.exposeInMainWorld("factory", bridge);
