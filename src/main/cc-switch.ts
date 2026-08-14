import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SubscriptionInput, SubscriptionApiType } from "../shared/subscriptions.js";

export interface CcSwitchDetectedProvider {
  name: string;
  appType: string;
  apiType: SubscriptionApiType;
  baseUrl: string;
  apiKey?: string;
  models: Array<{ id: string; name: string }>;
}

export function defaultCcSwitchDatabasePath(): string {
  return join(homedir(), ".cc-switch", "cc-switch.db");
}

/**
 * Best-effort read of the CC Switch SQLite database. Returns provider
 * candidates that can be mapped to M Agent subscription profiles. Never
 * throws on a missing/unreadable database — it returns an empty list.
 */
export function detectCcSwitchProviders(dbPath = defaultCcSwitchDatabasePath()): CcSwitchDetectedProvider[] {
  if (!existsSync(dbPath)) return [];
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare(
      "SELECT app_type, name, settings_config, category FROM providers ORDER BY sort_index",
    ).all() as Array<{ app_type: string; name: string; settings_config: string; category: string | null }>;
    const providers: CcSwitchDetectedProvider[] = [];
    for (const row of rows) {
      if (row.category === "official") continue;
      let config: unknown;
      try { config = JSON.parse(row.settings_config); } catch { continue; }
      if (!config || typeof config !== "object") continue;
      const mapped = mapCcSwitchProvider(row.app_type, row.name, config as Record<string, unknown>);
      if (mapped) providers.push(mapped);
    }
    return providers;
  } catch {
    return [];
  } finally {
    try { db?.close(); } catch { /* ignore */ }
  }
}

function mapCcSwitchProvider(
  appType: string,
  name: string,
  config: Record<string, unknown>,
): CcSwitchDetectedProvider | null {
  if (appType === "codex") return mapCodexProvider(name, config);
  if (appType === "claude" || appType === "claude-desktop") return mapClaudeProvider(name, config);
  if (appType === "gemini") return mapGeminiProvider(name, config);
  if (appType === "grokbuild") return mapGrokBuildProvider(name, config);
  return null;
}

function mapCodexProvider(name: string, config: Record<string, unknown>): CcSwitchDetectedProvider | null {
  const auth = asRecord(config.auth);
  const apiKey = typeof auth?.OPENAI_API_KEY === "string" ? auth.OPENAI_API_KEY : "";
  const toml = typeof config.config === "string" ? config.config : "";
  const parsed = parseProviderToml(toml);
  const activeProvider = parsed.modelProvider;
  const providerEntry = activeProvider ? parsed.providers[activeProvider] : parsed.providers[Object.keys(parsed.providers)[0]];
  const baseUrl = providerEntry?.baseUrl ?? parsed.baseUrl;
  const wireApi = providerEntry?.wireApi ?? parsed.wireApi;
  if (!baseUrl) return null;
  const apiType: SubscriptionApiType = wireApi === "chat" ? "openai-completions" : "openai-responses";
  const models: Array<{ id: string; name: string }> = [];
  if (providerEntry?.name) models.push({ id: providerEntry.name, name: providerEntry.name });
  if (parsed.model && !models.some((model) => model.id === parsed.model)) {
    models.push({ id: parsed.model, name: parsed.model });
  }
  return { name, appType: "codex", apiType, baseUrl, apiKey: apiKey || undefined, models };
}

function mapClaudeProvider(name: string, config: Record<string, unknown>): CcSwitchDetectedProvider | null {
  const env = asRecord(config.env);
  if (!env) return null;
  const baseUrl = typeof env.ANTHROPIC_BASE_URL === "string" && env.ANTHROPIC_BASE_URL.trim() ? env.ANTHROPIC_BASE_URL.trim() : "https://api.anthropic.com";
  const apiKey = typeof env.ANTHROPIC_AUTH_TOKEN === "string" && env.ANTHROPIC_AUTH_TOKEN
    ? env.ANTHROPIC_AUTH_TOKEN
    : typeof env.ANTHROPIC_API_KEY === "string" && env.ANTHROPIC_API_KEY
      ? env.ANTHROPIC_API_KEY
      : "";
  const models: Array<{ id: string; name: string }> = [];
  const model = typeof env.ANTHROPIC_MODEL === "string" && env.ANTHROPIC_MODEL ? env.ANTHROPIC_MODEL : "";
  if (model) models.push({ id: model, name: model });
  return { name, appType: "claude", apiType: "anthropic-messages", baseUrl, apiKey: apiKey || undefined, models };
}

function mapGeminiProvider(name: string, config: Record<string, unknown>): CcSwitchDetectedProvider | null {
  const env = asRecord(config.env);
  if (!env) return null;
  const baseUrl = typeof env.GOOGLE_GEMINI_BASE_URL === "string" && env.GOOGLE_GEMINI_BASE_URL.trim()
    ? env.GOOGLE_GEMINI_BASE_URL.trim()
    : "https://generativelanguage.googleapis.com/v1beta";
  const apiKey = typeof env.GEMINI_API_KEY === "string" && env.GEMINI_API_KEY
    ? env.GEMINI_API_KEY
    : typeof env.GOOGLE_API_KEY === "string" && env.GOOGLE_API_KEY
      ? env.GOOGLE_API_KEY
      : "";
  const models: Array<{ id: string; name: string }> = [];
  const model = typeof env.GEMINI_MODEL === "string" && env.GEMINI_MODEL ? env.GEMINI_MODEL : "";
  if (model) models.push({ id: model, name: model });
  return { name, appType: "gemini", apiType: "google-generative-ai", baseUrl, apiKey: apiKey || undefined, models };
}

function mapGrokBuildProvider(name: string, config: Record<string, unknown>): CcSwitchDetectedProvider | null {
  const toml = typeof config.config === "string" ? config.config : "";
  if (!toml.trim()) return null;
  const parsed = parseGrokToml(toml);
  const entry = (parsed.default ? parsed.models[parsed.default] : undefined) ?? Object.values(parsed.models)[0];
  if (!entry) return null;
  const apiType: SubscriptionApiType = entry.apiBackend === "chat_completions" ? "openai-completions" : "openai-responses";
  const models: Array<{ id: string; name: string }> = [];
  for (const [id, model] of Object.entries(parsed.models)) {
    if (id) models.push({ id, name: model.name || id });
  }
  return {
    name,
    appType: "grokbuild",
    apiType,
    baseUrl: entry.baseUrl,
    apiKey: entry.apiKey || undefined,
    models,
  };
}

interface TomlProviderEntry {
  baseUrl?: string;
  wireApi?: string;
  name?: string;
}

interface ParsedToml {
  modelProvider?: string;
  baseUrl?: string;
  wireApi?: string;
  model?: string;
  providers: Record<string, TomlProviderEntry>;
}

/** Minimal TOML reader for the Codex config format cc-switch writes. */
function parseProviderToml(toml: string): ParsedToml {
  const result: ParsedToml = { providers: {} };
  let currentSection = "";
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1]!.trim();
      if (currentSection.startsWith("model_providers.")) {
        const id = currentSection.slice("model_providers.".length).replace(/^"|"$/g, "");
        result.providers[id] = result.providers[id] ?? {};
      }
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv) continue;
    const key = kv[1]!.trim();
    let value = kv[2]!.trim();
    if (value.startsWith("\"")) value = value.replace(/^"|"$/g, "");
    if (key === "model_provider") result.modelProvider = value;
    else if (key === "base_url" && !currentSection) result.baseUrl = value;
    else if (key === "wire_api" && !currentSection) result.wireApi = value;
    else if (key === "model" && !currentSection) result.model = value;
    if (currentSection.startsWith("model_providers.")) {
      const id = currentSection.slice("model_providers.".length).replace(/^"|"$/g, "");
      const entry = result.providers[id] ?? (result.providers[id] = {});
      if (key === "base_url") entry.baseUrl = value;
      else if (key === "wire_api") entry.wireApi = value;
      else if (key === "name") entry.name = value;
    }
  }
  return result;
}

interface GrokModelEntry {
  name?: string;
  baseUrl: string;
  apiKey?: string;
  apiBackend?: string;
}

interface ParsedGrokToml {
  default?: string;
  models: Record<string, GrokModelEntry>;
}

function parseGrokToml(toml: string): ParsedGrokToml {
  const result: ParsedGrokToml = { models: {} };
  let currentSection = "";
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      const section = sectionMatch[1]!.trim();
      const modelMatch = section.match(/^model\.(.*)$/);
      if (modelMatch) {
        currentSection = modelMatch[1]!.replace(/^"|"$/g, "");
        result.models[currentSection] = result.models[currentSection] ?? { baseUrl: "" };
      } else {
        currentSection = "";
      }
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!kv || !currentSection) continue;
    const key = kv[1]!.trim();
    let value = kv[2]!.trim();
    if (value.startsWith("\"")) value = value.replace(/^"|"$/g, "");
    const entry = result.models[currentSection]!;
    if (key === "name") entry.name = value;
    else if (key === "base_url") entry.baseUrl = value;
    else if (key === "api_key") entry.apiKey = value;
    else if (key === "api_backend") entry.apiBackend = value;
  }
  const defaultMatch = toml.match(/^\s*\[models\]\s*$/m);
  if (defaultMatch) {
    const after = toml.slice(defaultMatch.index! + defaultMatch[0].length);
    const defaultKv = after.match(/^\s*default\s*=\s*"([^"]+)"/m);
    if (defaultKv) result.default = defaultKv[1];
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function toSubscriptionInput(detected: CcSwitchDetectedProvider): SubscriptionInput {
  return {
    name: detected.name,
    providerId: `cc-switch-${detected.appType}-${slugify(detected.name)}`,
    apiType: detected.apiType,
    baseUrl: detected.baseUrl,
    apiKey: detected.apiKey,
    models: detected.models.map((model) => ({ id: model.id, name: model.name })),
    notes: `从 CC Switch 导入（${detected.appType}）。`,
  };
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "provider";
}
