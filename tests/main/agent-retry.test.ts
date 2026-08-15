import { describe, expect, it } from "vitest";
import { isTransientAgentError } from "../../src/main/agent-service";

describe("isTransientAgentError", () => {
  it("将流终止/网络/超时归为可重试", () => {
    expect(isTransientAgentError(new Error("OpenAI Responses stream n response event"))).toBe(true);
    expect(isTransientAgentError(new Error("fetch failed"))).toBe(true);
    expect(isTransientAgentError(new Error("socket hang up"))).toBe(true);
    expect(isTransientAgentError(new Error("connection reset"))).toBe(true);
    expect(isTransientAgentError(new Error("timeout"))).toBe(true);
    expect(isTransientAgentError(new Error("502 Bad Gateway"))).toBe(true);
  });

  it("认证/配额/模型类错误不重试", () => {
    expect(isTransientAgentError(new Error("OpenAI API error (401): invalid api key"))).toBe(false);
    expect(isTransientAgentError(new Error("insufficient_quota"))).toBe(false);
    expect(isTransientAgentError(new Error("Model minimax-m3 is not supported"))).toBe(false);
    expect(isTransientAgentError(new Error("429 rate limit"))).toBe(false);
  });
});
