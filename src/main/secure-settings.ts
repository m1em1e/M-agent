import { safeStorage } from "electron";
import Store from "electron-store";

interface SettingsSchema {
  encryptedApiKey?: string;
}

let store: Store<SettingsSchema> | undefined;

function settingsStore(): Store<SettingsSchema> {
  return store ??= new Store<SettingsSchema>({ name: "secure-settings" });
}

export function saveApiKey(apiKey: unknown): void {
  if (typeof apiKey !== "string") throw new Error("API Key 必须是字符串。");
  const clean = apiKey.trim();
  if (!clean) throw new Error("API Key 不能为空。");
  if (clean.length > 1_024) throw new Error("API Key 长度超过上限。");
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("当前系统无法提供安全凭据加密，未保存 API Key。");
  }
  settingsStore().set("encryptedApiKey", safeStorage.encryptString(clean).toString("base64"));
}

export function getApiKey(): string | null {
  const encrypted = settingsStore().get("encryptedApiKey");
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return null;
  }
}

export function clearApiKey(): void {
  settingsStore().delete("encryptedApiKey");
}

export function hasApiKey(): boolean {
  return getApiKey() !== null;
}
