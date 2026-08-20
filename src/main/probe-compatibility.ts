import type { SubscriptionApiType } from "../shared/subscriptions.js";

/** 端点探测状态分类：ok=端点存在且可达；notfound=404 端点不存在；server-error=服务端 5xx；network=网络失败。 */
export type ProbeStatus = "ok" | "notfound" | "server-error" | "network";

/** 端点兼容性建议：建议把订阅的 API 类型切换为 recommendedApiType。 */
export interface CompatibilitySuggestion {
  recommendedApiType: "openai-completions" | "openai-responses";
  reason: string;
}

const OPENAI_TYPES: ReadonlyArray<SubscriptionApiType> = ["openai-completions", "openai-responses"];
/** 探测用占位模型名：避免真实推理/计费，仅用于确认端点是否存在与可达。 */
const PROBE_MODEL = "__probe__nonexistent__";

export function classifyProbeStatus(status: number): ProbeStatus {
  if (status >= 200 && status < 300) return "ok";
  if (status === 404) return "notfound";
  if (status >= 500) return "server-error";
  // 400/401/403 等：端点存在且可达（鉴权或模型不存在问题不算端点不兼容）。
  return "ok";
}

export async function probeOpenAIEndpoint(
  baseUrl: string,
  apiKey: string,
  endpoint: "chat/completions" | "responses",
  signal?: AbortSignal,
): Promise<ProbeStatus> {
  try {
    const body = endpoint === "responses"
      ? JSON.stringify({ model: PROBE_MODEL, input: "hi" })
      : JSON.stringify({ model: PROBE_MODEL, messages: [{ role: "user", content: "hi" }], max_tokens: 1 });
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/${endpoint}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body,
      signal,
    });
    return classifyProbeStatus(response.status);
  } catch {
    return "network";
  }
}

/**
 * 检测 OpenAI-compatible 订阅的 API 类型是否与端点不匹配。
 * 仅对 openai-completions / openai-responses 之间检测；anthropic/gemini 返回 null。
 * 当「当前端点不可用而另一端点可用」时返回建议；两端点都异常（服务端整体故障）
 * 或网络无法判定时返回 null（不打扰用户）。
 */
export async function detectCompatibilitySuggestion(params: {
  baseUrl: string;
  apiKey: string;
  currentApiType: SubscriptionApiType;
}): Promise<CompatibilitySuggestion | null> {
  if (!OPENAI_TYPES.includes(params.currentApiType)) return null;
  const other: "openai-completions" | "openai-responses" =
    params.currentApiType === "openai-completions" ? "openai-responses" : "openai-completions";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const current = await probeOpenAIEndpoint(
      params.baseUrl,
      params.apiKey,
      params.currentApiType === "openai-completions" ? "chat/completions" : "responses",
      controller.signal,
    );
    const alt = await probeOpenAIEndpoint(
      params.baseUrl,
      params.apiKey,
      other === "openai-completions" ? "chat/completions" : "responses",
      controller.signal,
    );
    if (alt === "network") return null;
    if (current === "ok" || current === "network") return null;
    if (alt === "ok") {
      return {
        recommendedApiType: other,
        reason: `检测到当前 API 类型（${params.currentApiType}）对应的端点不可用，而 ${other} 端点可用，建议切换。`,
      };
    }
    return null;
  } finally {
    clearTimeout(timer);
  }
}
