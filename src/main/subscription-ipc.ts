import { ipcMain } from "electron";
import type {
  FetchModelsRequest,
  FetchModelsResult,
  ImportResult,
  SubscriptionInput,
} from "../shared/subscriptions.js";
import { detectCcSwitchProviders, toSubscriptionInput } from "./cc-switch.js";
import { PiCliCredentialStore } from "./pi-cli-credential-store.js";
import { importPiCliCredentials } from "./environment-service.js";
import {
  activateSubscription,
  createSubscription,
  deleteSubscription,
  importSubscriptionProfiles,
  listSubscriptionSummaries,
  toSubscriptionSummary,
  updateSubscription,
} from "./subscription-store.js";

const MAX_MODEL_FETCH_BYTES = 2 * 1024 * 1024;

export function registerSubscriptionIpc(): void {
  ipcMain.handle("subscriptions:list", () => listSubscriptionSummaries());
  ipcMain.handle("subscriptions:create", (_event, input: unknown) => {
    return createSubscription(assertSubscriptionInput(input));
  });
  ipcMain.handle("subscriptions:update", (_event, id: unknown, input: unknown) => {
    if (typeof id !== "string" || !id) throw new Error("订阅 ID 无效。");
    return updateSubscription(id, assertSubscriptionInput(input));
  });
  ipcMain.handle("subscriptions:delete", (_event, id: unknown) => {
    if (typeof id !== "string" || !id) throw new Error("订阅 ID 无效。");
    deleteSubscription(id);
  });
  ipcMain.handle("subscriptions:activate", (_event, id: unknown) => {
    if (typeof id !== "string" || !id) throw new Error("订阅 ID 无效。");
    return activateSubscription(id).map(toSubscriptionSummary);
  });
  ipcMain.handle("subscriptions:import", async (): Promise<ImportResult> => {
    const skipped: string[] = [];
    let imported = 0;

    const piCredentials = new PiCliCredentialStore();
    const piCandidates: Array<{ input: SubscriptionInput; source: "pi" }> = [];
    try {
      const openaiCredential = await piCredentials.read("openai");
      if (openaiCredential?.type === "api_key" && openaiCredential.key) {
        piCandidates.push({
          source: "pi",
          input: {
            name: "Pi · OpenAI",
            providerId: "pi-openai",
            apiType: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            apiKey: openaiCredential.key,
            models: [],
            notes: "从 Pi 登录状态导入。",
          },
        });
      }
    } catch (error) {
      skipped.push(`读取 Pi 登录状态失败：${errorMessage(error)}`);
    }

    const ccSwitchProviders = detectCcSwitchProviders();
    const ccCandidates = ccSwitchProviders.map((provider) => ({
      source: "cc-switch" as const,
      input: toSubscriptionInput(provider),
    }));

    const result = importSubscriptionProfiles([...piCandidates, ...ccCandidates]);
    imported += result.imported;
    skipped.push(...result.skipped);

    try {
      await importPiCliCredentials();
    } catch (error) {
      skipped.push(`Pi 凭据复制未完成：${errorMessage(error)}`);
    }

    return { imported, skipped };
  });
  ipcMain.handle("subscriptions:fetch-models", async (_event, request: unknown): Promise<FetchModelsResult> => {
    const parsed = assertFetchModelsRequest(request);
    return fetchModelsFromProvider(parsed);
  });
}

async function fetchModelsFromProvider(request: FetchModelsRequest): Promise<FetchModelsResult> {
  const { apiType, baseUrl, apiKey } = request;
  if (!baseUrl.trim()) throw new Error("请先填写 BaseURL。");
  if (!apiKey.trim()) throw new Error("请先填写 API Key 后才能拉取模型列表。");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    let url: string;
    let headers: Record<string, string>;
    if (apiType === "anthropic-messages") {
      url = `${trimSlash(baseUrl)}/v1/models`;
      headers = { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    } else if (apiType === "google-generative-ai") {
      url = `${trimSlash(baseUrl)}/models`;
      headers = { "x-goog-api-key": apiKey };
    } else {
      url = `${trimSlash(baseUrl)}/models`;
      headers = { Authorization: `Bearer ${apiKey}` };
    }
    const response = await fetch(url, { headers, signal: controller.signal });
    if (!response.ok) {
      throw new Error(`拉取模型失败：HTTP ${response.status} ${response.statusText}`);
    }
    const text = await response.text();
    if (Buffer.byteLength(text, "utf8") > MAX_MODEL_FETCH_BYTES) throw new Error("模型列表响应过大。");
    const body: unknown = JSON.parse(text);
    const models = extractModelList(body, apiType);
    if (models.length === 0) throw new Error("接口返回中未识别到可用模型。");
    return { models, message: `拉取到 ${models.length} 个模型。` };
  } catch (error) {
    if (controller.signal.aborted) throw new Error("拉取模型超时，请检查 BaseURL 或网络。");
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractModelList(body: unknown, apiType: FetchModelsRequest["apiType"]): Array<{ id: string; name: string }> {
  if (!body || typeof body !== "object") return [];
  const record = body as Record<string, unknown>;
  if (Array.isArray(record.data)) {
    return record.data.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const model = entry as Record<string, unknown>;
      const id = typeof model.id === "string" ? model.id : "";
      if (!id) return [];
      const name = typeof model.display_name === "string" && model.display_name
        ? model.display_name
        : typeof model.name === "string" && model.name
          ? model.name
          : id;
      return [{ id, name }];
    });
  }
  if (Array.isArray(record.models)) {
    return record.models.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const model = entry as Record<string, unknown>;
      const raw = typeof model.name === "string" ? model.name : "";
      const id = raw.startsWith("models/") ? raw.slice("models/".length) : raw;
      if (!id) return [];
      const name = typeof model.displayName === "string" && model.displayName ? model.displayName : id;
      return [{ id, name }];
    });
  }
  return [];
}

function trimSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function assertFetchModelsRequest(value: unknown): FetchModelsRequest {
  if (!value || typeof value !== "object") throw new Error("拉取模型请求无效。");
  const request = value as Partial<FetchModelsRequest>;
  if (request.apiType !== "openai-completions"
    && request.apiType !== "openai-responses"
    && request.apiType !== "anthropic-messages"
    && request.apiType !== "google-generative-ai") {
    throw new Error("API 类型无效。");
  }
  if (typeof request.baseUrl !== "string") throw new Error("BaseURL 无效。");
  if (typeof request.apiKey !== "string") throw new Error("API Key 无效。");
  return { apiType: request.apiType, baseUrl: request.baseUrl, apiKey: request.apiKey };
}

function assertSubscriptionInput(value: unknown): SubscriptionInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("订阅数据无效。");
  const input = value as Partial<SubscriptionInput>;
  if (typeof input.name !== "string") throw new Error("显示名称无效。");
  if (typeof input.providerId !== "string") throw new Error("Provider ID 无效。");
  if (input.apiType !== "openai-completions"
    && input.apiType !== "openai-responses"
    && input.apiType !== "anthropic-messages"
    && input.apiType !== "google-generative-ai") {
    throw new Error("API 类型无效。");
  }
  if (typeof input.baseUrl !== "string") throw new Error("BaseURL 无效。");
  if (input.apiKey !== undefined && typeof input.apiKey !== "string") throw new Error("API Key 无效。");
  if (input.models !== undefined && !Array.isArray(input.models)) throw new Error("模型列表无效。");
  if (input.notes !== undefined && typeof input.notes !== "string") throw new Error("备注无效。");
  if (input.activeModelId !== undefined && typeof input.activeModelId !== "string") throw new Error("默认模型无效。");
  return {
    name: input.name,
    providerId: input.providerId,
    apiType: input.apiType,
    baseUrl: input.baseUrl,
    apiKey: input.apiKey,
    models: input.models ?? [],
    notes: input.notes,
    activeModelId: input.activeModelId,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
