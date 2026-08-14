import type { Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { diagnoseEnvironment, isVersionAtLeast } from "../../src/main/environment-service";

const shellReady = {
  path: process.platform === "win32" ? "C:\\Windows\\system32\\bash.exe" : "/bin/bash",
  status: "ready" as const,
  usable: true,
  message: "Shell 可用。",
  checkedAt: "2026-08-14T00:00:00.000Z",
};

class TestCredentialStore implements CredentialStore {
  constructor(private readonly entries: Record<string, Credential> = {}) {}
  async read(providerId: string) { return this.entries[providerId]; }
  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.entries).map(([providerId, credential]) => ({ providerId, type: credential.type }));
  }
  async modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>) {
    const next = await fn(this.entries[providerId]);
    if (next) this.entries[providerId] = next;
    return next ?? this.entries[providerId];
  }
  async delete(providerId: string) { delete this.entries[providerId]; }
}

const base = {
  development: false,
  shellCheck: shellReady,
  piVersion: "0.84.1",
  nodeVersion: "22.21.1",
  electronVersion: "37.10.3",
  safeStorageAvailable: true,
  secureApiKey: null,
  environmentApiKey: false,
  appCredentials: new TestCredentialStore(),
  piCredentials: new TestCredentialStore(),
  activeSubscriptionApiKey: null,
};

describe("startup environment diagnostics", () => {
  it("uses the Pi Node engine boundary", () => {
    expect(isVersionAtLeast("22.18.0", [22, 19, 0])).toBe(false);
    expect(isVersionAtLeast("22.19.0", [22, 19, 0])).toBe(true);
    expect(isVersionAtLeast("24.0.0", [22, 19, 0])).toBe(true);
  });

  it("reports only runtime-relevant checks in an installed app", async () => {
    const report = await diagnoseEnvironment(base);
    const ids = report.checks.map((check) => check.id);
    expect(ids).toEqual(["electron", "node", "shell", "pi-core", "secure-storage"]);
    expect(report.checks.find((check) => check.id === "pi-core")).toMatchObject({ required: true, status: "ready" });
    expect(report.issues.some((issue) => issue.id === "provider-auth")).toBe(true);
  });

  it("reports an app API key without exposing secret material", async () => {
    const report = await diagnoseEnvironment({ ...base, secureApiKey: "not-returned-secret" });
    expect(report.agentReady).toBe(true);
    expect(report.activeProvider).toBe("openai");
    expect(report.providers[0]).toMatchObject({ configured: true, usable: true, source: "app" });
    expect(JSON.stringify(report)).not.toContain("not-returned-secret");
  });

  it("reports an unusable configured shell as a required startup issue", async () => {
    const report = await diagnoseEnvironment({
      ...base,
      shellCheck: { ...shellReady, status: "unusable", usable: false, message: "Shell 无法执行。" },
    });
    expect(report.checks.find((check) => check.id === "shell")).toMatchObject({ required: true, status: "missing" });
    expect(report.issues.find((issue) => issue.id === "shell")).toMatchObject({ action: "open-shell-settings" });
  });

  it("prefers an app subscription login over detected but unimported Pi CLI credentials", async () => {
    const report = await diagnoseEnvironment({
      ...base,
      appCredentials: new TestCredentialStore({
        "openai-codex": { type: "oauth", access: "opaque", refresh: "opaque", expires: Date.now() + 3_600_000 },
      }),
      piCredentials: new TestCredentialStore({ openai: { type: "api_key", key: "opaque" } }),
    });
    expect(report.activeProvider).toBe("openai-codex");
  });

  it("treats an active subscription with an API key as agent-ready", async () => {
    const report = await diagnoseEnvironment({ ...base, activeSubscriptionApiKey: "not-returned-secret" });
    expect(report.agentReady).toBe(true);
    expect(report.issues.some((issue) => issue.id === "provider-auth")).toBe(false);
    expect(JSON.stringify(report)).not.toContain("not-returned-secret");
  });
});
