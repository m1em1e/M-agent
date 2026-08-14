import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFile } from "node:fs/promises";

const MAX_AUTH_FILE_BYTES = 1024 * 1024;

/** Read-only view of the standard Pi coding-agent auth.json. */
export class PiCliCredentialStore implements Pick<CredentialStore, "read" | "list"> {
  constructor(readonly authFile = defaultPiAuthFile()) {}

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    const value = (await this.readAll())[providerId];
    if (value === undefined) return undefined;
    if (!isCredential(value)) throw new Error(`Pi 中 ${providerId} 的认证凭据格式无效。`);
    return value;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    const entries = await this.readAll();
    return Object.entries(entries).flatMap(([providerId, credential]) => (
      isCredential(credential) ? [{ providerId, type: credential.type }] : []
    ));
  }

  private async readAll(): Promise<Record<string, unknown>> {
    try {
      const contents = await readFile(this.authFile, "utf8");
      if (Buffer.byteLength(contents, "utf8") > MAX_AUTH_FILE_BYTES) throw new Error("Pi auth.json 超过大小上限。");
      const parsed: unknown = JSON.parse(contents);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Pi auth.json 必须是对象。");
      return parsed as Record<string, unknown>;
    } catch (error) {
      if (isMissingFile(error)) return {};
      throw new Error("无法读取 Pi 登录状态。", { cause: error });
    }
  }

}

export function defaultPiAuthFile(): string {
  const directory = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".pi", "agent");
  return join(directory, "auth.json");
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

function isMissingFile(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT";
}
