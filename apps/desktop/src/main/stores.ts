import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { safeStorage } from "electron";
import type { ConfigStore, SecretStore, StoredConfig } from "./controller.js";

const DEFAULT_CONFIG: StoredConfig = { serverUrl: null, channel: "stable" };

export function fileConfigStore(dir: string, defaults: Partial<StoredConfig> = {}): ConfigStore {
  const file = path.join(dir, "config.json");
  return {
    async load() {
      try {
        return { ...DEFAULT_CONFIG, ...defaults, ...JSON.parse(await readFile(file, "utf8")) };
      } catch {
        return { ...DEFAULT_CONFIG, ...defaults };
      }
    },
    async save(config) {
      await mkdir(dir, { recursive: true });
      await writeFile(file, JSON.stringify(config, null, 2));
    },
  };
}

/**
 * Stores the session encrypted with the OS keystore (DPAPI on Windows). If encryption
 * is unavailable (e.g. Linux without a keyring) the session is kept in memory only.
 */
export function safeSecretStore(dir: string): SecretStore {
  const file = path.join(dir, "session.bin");
  let memory: string | null = null;
  const encrypted = () => safeStorage.isEncryptionAvailable();
  return {
    async load() {
      if (!encrypted()) return memory;
      try {
        return safeStorage.decryptString(await readFile(file));
      } catch {
        return null;
      }
    },
    async save(value) {
      if (!encrypted()) {
        memory = value;
        return;
      }
      await mkdir(dir, { recursive: true });
      await writeFile(file, safeStorage.encryptString(value));
    },
    async clear() {
      memory = null;
      await rm(file, { force: true });
    },
  };
}
