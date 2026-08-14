import { beforeEach, describe, expect, it, vi } from "vitest";

const backing = new Map<string, Record<string, unknown>>();

vi.mock("electron-store", () => {
  class MockStore {
    constructor(private readonly options: { name?: string; defaults?: Record<string, unknown> }) {
      const key = this.options.name ?? "default";
      if (!backing.has(key) && this.options.defaults) backing.set(key, { ...this.options.defaults });
    }
    get(key: string): unknown {
      return (backing.get(this.options.name ?? "default") ?? {})[key];
    }
    set(key: string, value: unknown): void {
      const data = backing.get(this.options.name ?? "default") ?? {};
      data[key] = value;
      backing.set(this.options.name ?? "default", data);
    }
    delete(key: string): void {
      const data = backing.get(this.options.name ?? "default") ?? {};
      delete data[key];
      backing.set(this.options.name ?? "default", data);
    }
  }
  return { default: MockStore };
});

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(`enc:${value}`, "utf8").toString("base64"),
    decryptString: (buffer: Buffer) => buffer.toString("utf8").replace(/^enc:/, ""),
  },
}));

import {
  activateSubscription,
  createSubscription,
  deleteSubscription,
  getActiveSubscriptionProfile,
  importSubscriptionProfiles,
  listSubscriptionProfiles,
  listSubscriptionSummaries,
  readSubscriptionApiKey,
  updateSubscription,
} from "../../src/main/subscription-store";

beforeEach(() => {
  backing.clear();
  backing.set("subscriptions", { profiles: [], encryptedKeys: {} });
});

describe("subscription store", () => {
  it("creates a subscription, encrypting its API key and marking the first as active", () => {
    const profile = createSubscription({
      name: "DeepSeek 主力",
      providerId: "deepseek",
      apiType: "openai-completions",
      baseUrl: "https://api.deepseek.com/",
      apiKey: "sk-secret-1",
      models: [{ id: "deepseek-chat", name: "DeepSeek Chat" }],
      notes: "备注",
    });
    expect(profile.isActive).toBe(true);
    expect(profile.baseUrl).toBe("https://api.deepseek.com");
    expect(readSubscriptionApiKey(profile.id)).toBe("sk-secret-1");
    expect(listSubscriptionSummaries()).toHaveLength(1);
    expect(JSON.stringify(listSubscriptionSummaries())).not.toContain("sk-secret-1");
    expect(listSubscriptionSummaries()[0].hasApiKey).toBe(true);
  });

  it("defaults a blank model context window and keeps later subscriptions inactive", () => {
    createSubscription({ name: "A", providerId: "a", apiType: "openai-responses", baseUrl: "https://a.example.com", models: [] });
    const second = createSubscription({ name: "B", providerId: "b", apiType: "openai-responses", baseUrl: "https://b.example.com", models: [{ id: "m", name: "M" }] });
    expect(second.isActive).toBe(false);
    expect(getActiveSubscriptionProfile()?.name).toBe("A");
    expect(second.models[0].contextWindow).toBeUndefined();
  });

  it("updates a subscription without overwriting the stored key when apiKey is omitted", () => {
    const profile = createSubscription({ name: "A", providerId: "a", apiType: "openai-responses", baseUrl: "https://a.example.com", apiKey: "sk-keep", models: [] });
    const updated = updateSubscription(profile.id, {
      name: "A renamed",
      providerId: "a",
      apiType: "openai-responses",
      baseUrl: "https://a.example.com",
      models: [{ id: "m", name: "M", contextWindow: 262_144 }],
    });
    expect(updated.name).toBe("A renamed");
    expect(updated.models[0].contextWindow).toBe(262_144);
    expect(readSubscriptionApiKey(profile.id)).toBe("sk-keep");
  });

  it("clears the key when apiKey is explicitly empty", () => {
    const profile = createSubscription({ name: "A", providerId: "a", apiType: "openai-responses", baseUrl: "https://a.example.com", apiKey: "sk-keep", models: [] });
    updateSubscription(profile.id, { name: "A", providerId: "a", apiType: "openai-responses", baseUrl: "https://a.example.com", apiKey: "", models: [] });
    expect(readSubscriptionApiKey(profile.id)).toBeNull();
  });

  it("activates one subscription at a time", () => {
    const a = createSubscription({ name: "A", providerId: "a", apiType: "openai-responses", baseUrl: "https://a.example.com", models: [] });
    const b = createSubscription({ name: "B", providerId: "b", apiType: "openai-responses", baseUrl: "https://b.example.com", models: [] });
    activateSubscription(b.id);
    expect(getActiveSubscriptionProfile()?.id).toBe(b.id);
    expect(listSubscriptionProfiles().find((profile) => profile.id === a.id)?.isActive).toBe(false);
  });

  it("deleting the active subscription activates the first remaining one", () => {
    createSubscription({ name: "A", providerId: "a", apiType: "openai-responses", baseUrl: "https://a.example.com", models: [] });
    const b = createSubscription({ name: "B", providerId: "b", apiType: "openai-responses", baseUrl: "https://b.example.com", models: [] });
    deleteSubscription(b.id);
    expect(getActiveSubscriptionProfile()?.name).toBe("A");
  });

  it("imports only new profiles and reports duplicates as skipped", () => {
    createSubscription({ name: "A", providerId: "a", apiType: "openai-responses", baseUrl: "https://a.example.com", models: [] });
    const result = importSubscriptionProfiles([
      { source: "pi", input: { name: "A", providerId: "a", apiType: "openai-responses", baseUrl: "https://a.example.com", models: [] } },
      { source: "cc-switch", input: { name: "C", providerId: "c", apiType: "anthropic-messages", baseUrl: "https://c.example.com", apiKey: "sk-c", models: [{ id: "m", name: "M" }] } },
    ]);
    expect(result.imported).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(listSubscriptionProfiles()).toHaveLength(2);
    const imported = listSubscriptionProfiles().find((profile) => profile.providerId === "c");
    expect(imported?.source).toBe("cc-switch");
    expect(readSubscriptionApiKey(imported!.id)).toBe("sk-c");
  });
});
