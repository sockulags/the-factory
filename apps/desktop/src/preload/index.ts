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
  request: (method, apiPath, body) =>
    ipcRenderer.invoke(BRIDGE_CHANNELS.request, method, apiPath, body),
  openStream: (apiPath) => ipcRenderer.invoke(BRIDGE_CHANNELS.openStream, apiPath),
  closeStream: (id) => ipcRenderer.invoke(BRIDGE_CHANNELS.closeStream, id),
  onStreamEvent(listener) {
    const handler = (_e: unknown, id: string, data: unknown) => listener(id, data);
    ipcRenderer.on(BRIDGE_CHANNELS.streamEvent, handler);
    return () => ipcRenderer.off(BRIDGE_CHANNELS.streamEvent, handler);
  },
};

contextBridge.exposeInMainWorld("factory", bridge);
