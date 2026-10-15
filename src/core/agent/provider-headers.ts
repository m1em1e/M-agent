/**
 * 供应商请求头补充。
 *
 * OpenCode Go 网关（`https://opencode.ai/...`）要求客户端在推理请求上携带稳定会话 ID，
 * 并使用自己的 User-Agent 标识客户端：
 * - 缺少 `x-opencode-session` 时网关直接返回 400 MissingSessionID，请求不会被路由；
 * - 官方要求客户端以自身名称标识，而不是沿用 SDK/HTTP 库的默认 User-Agent。
 *
 * 其他 OpenAI 兼容供应商没有这两个约定，因此仅在 opencode.ai 主机上附加，避免影响已有订阅。
 * 见 https://opencode.ai/docs/go/#where-can-i-use-it
 */

/** OpenCode Go 的会话头名称。 */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/** 客户端标识：官方示例形如 `my-coding-agent/1.0`；这里只用产品名，避免与打包版本号脱节。 */
export const OPENCODE_CLIENT_USER_AGENT = "m-agent";

/** 判断 BaseURL 是否指向 OpenCode Go 网关（opencode.ai 及其子域）。 */
export function isOpenCodeGateway(baseUrl: string | undefined | null): boolean {
  if (typeof baseUrl !== "string") return false;
  const value = baseUrl.trim();
  if (!value) return false;
  let host: string;
  try {
    host = new URL(value).hostname.toLowerCase();
  } catch {
    // 非法或缺协议的 BaseURL 由供应商适配层报错，这里不猜测主机名。
    return false;
  }
  return host === "opencode.ai" || host.endsWith(".opencode.ai");
}

/**
 * 构造 OpenCode Go 请求的附加头；非 OpenCode 主机返回 undefined，调用方保持原请求不变。
 * `sessionId` 应在同一会话内保持稳定，网关据此优化路由与提示缓存。
 */
export function openCodeRequestHeaders(params: {
  baseUrl?: string | null;
  sessionId?: string | null;
}): Record<string, string> | undefined {
  if (!isOpenCodeGateway(params.baseUrl)) return undefined;
  const sessionId = typeof params.sessionId === "string" ? params.sessionId.trim() : "";
  return {
    "User-Agent": OPENCODE_CLIENT_USER_AGENT,
    ...(sessionId ? { [OPENCODE_SESSION_HEADER]: sessionId } : {}),
  };
}
