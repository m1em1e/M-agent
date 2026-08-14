import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { app, safeStorage } from "electron";
import Store from "electron-store";

interface PiCredentialSettings {
  encryptedCredentials?: Record<string, string>;
}

/**
 * App-owned Pi credential storage. OAuth access and refresh tokens never cross
 * the main-process boundary and are encrypted with Electron safeStorage.
 */
export class SecurePiCredentialStore implements CredentialStore {
  private readonly store = new Store<PiCredentialSettings>({ name: "pi-credentials" });
  private readonly chains = new Map<string, Promise<unknown>>();

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const encrypted = this.store.get("encryptedCredentials")?.[providerId];
    if (!encrypted) return undefined;
    if (!safeStorage.isEncryptionAvailable()) {
      throw new Error("当前系统无法解密 Pi 认证凭据。");
    }
    try {
      const json = safeStorage.decryptString(Buffer.from(encrypted, "base64"));
      const credential: unknown = JSON.parse(json);
      if (!isCredential(credential)) throw new Error("凭据格式无效。");
      return credential;
    } catch (error) {
      throw new Error("Pi 认证凭据无法读取，请重新登录。", { cause: error });
    }
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const entries = this.store.get("encryptedCredentials") ?? {};
    const results: CredentialInfo[] = [];
    for (const providerId of Object.keys(entries)) {
      const credential = await this.read(providerId, options);
      if (credential) results.push({ providerId, type: credential.type });
    }
    return results;
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    return this.enqueue(providerId, async () => {
      options?.signal?.throwIfAborted();
      const current = await this.read(providerId, options);
      const next = await fn(current);
      options?.signal?.throwIfAborted();
      if (next === undefined) return current;
      if (!isCredential(next)) throw new Error("Pi 认证凭据格式无效。");
      if (!safeStorage.isEncryptionAvailable()) {
        throw new Error("当前系统无法安全加密 Pi 认证凭据，登录结果未保存。");
      }
      const credentials = { ...(this.store.get("encryptedCredentials") ?? {}) };
      credentials[providerId] = safeStorage.encryptString(JSON.stringify(next)).toString("base64");
      this.store.set("encryptedCredentials", credentials);
      return next;
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(providerId, async () => {
      options?.signal?.throwIfAborted();
      const credentials = { ...(this.store.get("encryptedCredentials") ?? {}) };
      delete credentials[providerId];
      this.store.set("encryptedCredentials", credentials);
    });
  }

  private enqueue<T>(providerId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(providerId) ?? Promise.resolve();
    const queued = previous.catch(() => undefined).then(task);
    const tail = queued.finally(() => {
      if (this.chains.get(providerId) === tail) this.chains.delete(providerId);
    });
    this.chains.set(providerId, tail);
    return queued;
  }
}

let credentialStore: SecurePiCredentialStore | undefined;

export function getPiCredentialStore(): SecurePiCredentialStore {
  if (!app.isReady()) throw new Error("Pi 凭据存储只能在应用就绪后访问。");
  return credentialStore ??= new SecurePiCredentialStore();
}

function isCredential(value: unknown): value is Credential {
  if (!value || typeof value !== "object") return false;
  const credential = value as Record<string, unknown>;
  if (credential.type === "api_key") {
    return (credential.key === undefined || typeof credential.key === "string")
      && (credential.env === undefined || isStringRecord(credential.env));
  }
  return credential.type === "oauth"
    && typeof credential.access === "string"
    && typeof credential.refresh === "string"
    && typeof credential.expires === "number"
    && Number.isFinite(credential.expires);
}

function isStringRecord(value: unknown): boolean {
  return Boolean(value) && typeof value === "object"
    && Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}
