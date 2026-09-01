import { safeStorage } from "electron";
import Store from "electron-store";

interface SettingsSchema {
  encryptedApiKey?: string;
}

let store: Store<SettingsSchema> | undefined;

function settingsStore(): Store<SettingsSchema> {
  return store ??= new Store<SettingsSchema>({ name: "secure-settings" });
}

/** 旧版单 API Key 存储：仅供启动迁移读取一次（新写入已统一走 pi-credential-store）。 */
export function readLegacyApiKey(): string | null {
  const encrypted = settingsStore().get("encryptedApiKey");
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return null;
  }
}

/** 迁移完成后清除旧版密钥（避免每次启动重复迁移）。 */
export function clearLegacyApiKey(): void {
  settingsStore().delete("encryptedApiKey");
}