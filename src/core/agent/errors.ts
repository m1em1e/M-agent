/**
 * Agent 瞬时错误判定：供主进程重试与子 Skill 重试复用。
 * 判定某个失败是否为可重试的瞬时错误（流终止/网络/超时/上游不稳）。
 */

/** 非瞬时（不可重试）错误模式：鉴权、配额、参数、模型不存在等。 */
const NON_TRANSIENT_AGENT_ERROR_PATTERN =
  /(401|403|429|insufficient_quota|billing|quota|balance|api[ _]?key|authentication|unauthorized|permission|not supported|unknown model|model.*not|invalid request)/i;

/** 瞬时（可重试）错误模式：流结束/网络/连接/超时/上游 5xx 等。 */
const TRANSIENT_AGENT_ERROR_PATTERN =
  /(n response event|stream ended|stream did not end|ended before|fetch failed|network error|connection (refused|lost|reset)|socket hang up|other side closed|reset before headers|timed ?out|timeout|terminated|ECONNRESET|EPIPE|ENOTFOUND|EAI_AGAIN|upstream connect|502|503|504|524|overloaded|service unavailable|internal error)/i;

export function isTransientAgentError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (NON_TRANSIENT_AGENT_ERROR_PATTERN.test(message)) return false;
  return TRANSIENT_AGENT_ERROR_PATTERN.test(message);
}

/** 瞬时错误重试退避：每次重试前等待，给上游恢复窗口。 */
export const RETRY_BACKOFF_MS = 1_000;

export function delayRetry(ms = RETRY_BACKOFF_MS): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
