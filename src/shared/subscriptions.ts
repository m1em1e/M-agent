export type SubscriptionApiType =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

export type SubscriptionSource = "manual" | "pi" | "cc-switch" | "preset";

export const SUBSCRIPTION_API_TYPES: ReadonlyArray<{ id: SubscriptionApiType; label: string }> = [
  { id: "openai-completions", label: "OpenAI Completions" },
  { id: "openai-responses", label: "OpenAI Responses" },
  { id: "anthropic-messages", label: "Anthropic Messages" },
  { id: "google-generative-ai", label: "Google Generative AI" },
];

export const DEFAULT_CONTEXT_WINDOW = 128_000;

export function subscriptionApiTypeLabel(apiType: SubscriptionApiType): string {
  return SUBSCRIPTION_API_TYPES.find((entry) => entry.id === apiType)?.label ?? apiType;
}

export interface SubscriptionModel {
  id: string;
  name: string;
  /** 上下文窗口（tokens）。未填写时按 DEFAULT_CONTEXT_WINDOW 处理。 */
  contextWindow?: number;
}

export interface SubscriptionProfile {
  id: string;
  name: string;
  providerId: string;
  apiType: SubscriptionApiType;
  baseUrl: string;
  models: SubscriptionModel[];
  notes?: string;
  source: SubscriptionSource;
  isActive: boolean;
  activeModelId?: string;
  createdAt: number;
  updatedAt: number;
}

/** Renderer 可见的订阅摘要，绝不包含 API Key。 */
export interface SubscriptionSummary {
  id: string;
  name: string;
  providerId: string;
  apiType: SubscriptionApiType;
  baseUrl: string;
  models: SubscriptionModel[];
  notes?: string;
  source: SubscriptionSource;
  isActive: boolean;
  activeModelId?: string;
  hasApiKey: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 新建或编辑订阅时从 Renderer 提交的载荷。 */
export interface SubscriptionInput {
  name: string;
  providerId: string;
  apiType: SubscriptionApiType;
  baseUrl: string;
  /** 留空表示不更新（编辑时保留原 key；新建时为空则视为无 key）。 */
  apiKey?: string;
  models: SubscriptionModel[];
  notes?: string;
  activeModelId?: string;
}

export interface FetchModelsRequest {
  apiType: SubscriptionApiType;
  baseUrl: string;
  apiKey: string;
}

export interface FetchModelsResult {
  models: Array<{ id: string; name: string }>;
  message?: string;
}

export interface ImportResult {
  imported: number;
  skipped: string[];
}

export function normalizeBaseUrl(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

export function normalizeProviderId(value: string): string {
  return value.trim().replace(/\s+/g, "-").toLowerCase();
}
