import { safeStorage } from "electron";
import Store from "electron-store";
import type {
  SubscriptionInput,
  SubscriptionProfile,
  SubscriptionSummary,
} from "../shared/subscriptions.js";
import { DEFAULT_CONTEXT_WINDOW, normalizeBaseUrl, normalizeProviderId } from "../shared/subscriptions.js";

interface SubscriptionStoreSchema {
  profiles: SubscriptionProfile[];
  encryptedKeys: Record<string, string>;
}

const MAX_MODELS_PER_SUBSCRIPTION = 500;
const MAX_NOTES_LENGTH = 2_000;

let store: Store<SubscriptionStoreSchema> | undefined;

function subscriptionStore(): Store<SubscriptionStoreSchema> {
  return store ??= new Store<SubscriptionStoreSchema>({ name: "subscriptions", defaults: { profiles: [], encryptedKeys: {} } });
}

export function listSubscriptionProfiles(): SubscriptionProfile[] {
  return subscriptionStore().get("profiles");
}

export function getSubscriptionProfile(id: string): SubscriptionProfile | undefined {
  return listSubscriptionProfiles().find((profile) => profile.id === id);
}

export function getActiveSubscriptionProfile(): SubscriptionProfile | undefined {
  return listSubscriptionProfiles().find((profile) => profile.isActive);
}

export function readSubscriptionApiKey(id: string): string | null {
  const encrypted = subscriptionStore().get("encryptedKeys")[id];
  if (!encrypted || !safeStorage.isEncryptionAvailable()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(encrypted, "base64"));
  } catch {
    return null;
  }
}

export function toSubscriptionSummary(profile: SubscriptionProfile): SubscriptionSummary {
  return {
    id: profile.id,
    name: profile.name,
    providerId: profile.providerId,
    apiType: profile.apiType,
    baseUrl: profile.baseUrl,
    models: profile.models,
    notes: profile.notes,
    source: profile.source,
    isActive: profile.isActive,
    activeModelId: profile.activeModelId,
    hasApiKey: readSubscriptionApiKey(profile.id) !== null,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  };
}

export function listSubscriptionSummaries(): SubscriptionSummary[] {
  return listSubscriptionProfiles().map(toSubscriptionSummary);
}

function nextUniqueId(existing: SubscriptionProfile[], preferred: string): string {
  if (!existing.some((profile) => profile.id === preferred)) return preferred;
  let index = 2;
  while (existing.some((profile) => profile.id === `${preferred}-${index}`)) index += 1;
  return `${preferred}-${index}`;
}

function saveProfile(updated: SubscriptionProfile[]): void {
  subscriptionStore().set("profiles", updated);
}

export function createSubscription(input: SubscriptionInput, source: SubscriptionProfile["source"] = "manual"): SubscriptionProfile {
  const current = listSubscriptionProfiles();
  const id = nextUniqueId(current, normalizeProviderId(input.providerId) || randomId());
  const now = Date.now();
  const profile: SubscriptionProfile = {
    id,
    name: input.name.trim() || normalizeProviderId(input.providerId) || id,
    providerId: normalizeProviderId(input.providerId) || id,
    apiType: input.apiType,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    models: sanitizeModels(input.models),
    notes: sanitizeNotes(input.notes),
    source,
    isActive: current.length === 0,
    activeModelId: sanitizeActiveModelId(input.activeModelId, input.models),
    createdAt: now,
    updatedAt: now,
  };
  const key = input.apiKey?.trim();
  if (key) setSubscriptionApiKey(id, key);
  saveProfile([...current, profile]);
  return profile;
}

export function updateSubscription(id: string, input: SubscriptionInput): SubscriptionProfile {
  const current = listSubscriptionProfiles();
  const existing = current.find((profile) => profile.id === id);
  if (!existing) throw new Error("订阅档案不存在。");
  const updated: SubscriptionProfile = {
    ...existing,
    name: input.name.trim() || existing.name,
    providerId: normalizeProviderId(input.providerId) || existing.providerId,
    apiType: input.apiType,
    baseUrl: normalizeBaseUrl(input.baseUrl),
    models: sanitizeModels(input.models),
    notes: sanitizeNotes(input.notes),
    activeModelId: sanitizeActiveModelId(input.activeModelId, input.models),
    updatedAt: Date.now(),
  };
  const key = input.apiKey?.trim();
  if (key) setSubscriptionApiKey(id, key);
  else if (input.apiKey === "") deleteSubscriptionApiKey(id);
  saveProfile(current.map((profile) => profile.id === id ? updated : profile));
  return updated;
}

export function deleteSubscription(id: string): void {
  const current = listSubscriptionProfiles();
  const next = current.filter((profile) => profile.id !== id);
  const keys = { ...subscriptionStore().get("encryptedKeys") };
  delete keys[id];
  subscriptionStore().set("encryptedKeys", keys);
  if (next.length === 0) {
    saveProfile([]);
    return;
  }
  const hadActive = current.some((profile) => profile.id === id && profile.isActive);
  if (hadActive) {
    const [first, ...rest] = next;
    saveProfile([{ ...first, isActive: true, updatedAt: Date.now() }, ...rest]);
  } else {
    saveProfile(next);
  }
}

export function activateSubscription(id: string): SubscriptionProfile[] {
  const current = listSubscriptionProfiles();
  if (!current.some((profile) => profile.id === id)) throw new Error("订阅档案不存在。");
  const now = Date.now();
  saveProfile(current.map((profile) => ({
    ...profile,
    isActive: profile.id === id,
    updatedAt: profile.id === id ? now : profile.updatedAt,
  })));
  return listSubscriptionProfiles();
}

export function importSubscriptionProfiles(
  candidates: Array<{ input: SubscriptionInput; source: SubscriptionProfile["source"] }>,
): { imported: number; skipped: string[] } {
  const current = listSubscriptionProfiles();
  const existingKeys = new Set(current.map((profile) => `${normalizeProviderId(profile.providerId)}|${normalizeBaseUrl(profile.baseUrl)}`));
  let imported = 0;
  const skipped: string[] = [];
  for (const candidate of candidates) {
    const providerId = normalizeProviderId(candidate.input.providerId);
    const baseUrl = normalizeBaseUrl(candidate.input.baseUrl);
    if (!providerId || !baseUrl) {
      skipped.push(`缺少 Provider ID 或 BaseURL 的条目（${candidate.input.name}）`);
      continue;
    }
    const key = `${providerId}|${baseUrl}`;
    if (existingKeys.has(key)) {
      skipped.push(`已存在：${candidate.input.name}`);
      continue;
    }
    createSubscription({ ...candidate.input, providerId, baseUrl }, candidate.source);
    existingKeys.add(key);
    imported += 1;
  }
  return { imported, skipped };
}

function sanitizeModels(models: unknown): SubscriptionProfile["models"] {
  if (!Array.isArray(models)) return [];
  const result: SubscriptionProfile["models"] = [];
  for (const entry of models) {
    if (!entry || typeof entry !== "object") continue;
    const model = entry as Record<string, unknown>;
    const id = typeof model.id === "string" ? model.id.trim() : "";
    if (!id) continue;
    const name = typeof model.name === "string" && model.name.trim() ? model.name.trim() : id;
    const contextWindow = model.contextWindow === undefined || model.contextWindow === null || model.contextWindow === ""
      ? undefined
      : typeof model.contextWindow === "number" && Number.isFinite(model.contextWindow) && model.contextWindow > 0
        ? Math.round(model.contextWindow)
        : undefined;
    result.push({ id, name, contextWindow });
    if (result.length >= MAX_MODELS_PER_SUBSCRIPTION) break;
  }
  return result;
}

function sanitizeActiveModelId(activeModelId: unknown, models: SubscriptionProfile["models"]): string | undefined {
  if (typeof activeModelId !== "string" || !activeModelId.trim()) return undefined;
  if (models.some((model) => model.id === activeModelId)) return activeModelId;
  return models[0]?.id;
}

function sanitizeNotes(notes: unknown): string | undefined {
  if (typeof notes !== "string") return undefined;
  const clean = notes.trim().slice(0, MAX_NOTES_LENGTH);
  return clean || undefined;
}

function setSubscriptionApiKey(id: string, key: string): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("当前系统无法安全加密 API Key。");
  }
  const keys = { ...subscriptionStore().get("encryptedKeys") };
  keys[id] = safeStorage.encryptString(key).toString("base64");
  subscriptionStore().set("encryptedKeys", keys);
}

function deleteSubscriptionApiKey(id: string): void {
  const keys = { ...subscriptionStore().get("encryptedKeys") };
  delete keys[id];
  subscriptionStore().set("encryptedKeys", keys);
}

export function subscriptionContextWindow(model: SubscriptionProfile["models"][number]): number {
  return model.contextWindow ?? DEFAULT_CONTEXT_WINDOW;
}

function randomId(): string {
  return `sub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
