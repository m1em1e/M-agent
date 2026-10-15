import { afterEach, describe, expect, it } from "vitest";
import { createMidiProject, createMidiTrack } from "../../src/core/midi";
import { runPiKernel, type PiCustomProviderConfig } from "../../src/core/agent/pi-kernel";
import {
  OPENCODE_CLIENT_USER_AGENT,
  OPENCODE_SESSION_HEADER,
  isOpenCodeGateway,
  openCodeRequestHeaders,
} from "../../src/core/agent/provider-headers";

function project() {
  const value = createMidiProject({ id: "provider-headers", title: "Loop", ppq: 480, bpm: 100 });
  value.tracks.push(createMidiTrack({
    id: "melody",
    name: "Melody",
    role: "melody",
    channel: 0,
    program: 1,
    notes: [
      { id: "n1", pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 },
      { id: "n2", pitch: 64, startTick: 480, durationTicks: 480, velocity: 88 },
    ],
  }));
  return value;
}

function providerConfig(baseUrl: string, apiType: PiCustomProviderConfig["apiType"] = "openai-completions"): PiCustomProviderConfig {
  return {
    providerId: "opencode-go",
    apiType,
    baseUrl,
    apiKey: "sk-test",
    models: [{ id: "test-model", name: "test-model" }],
    activeModelId: "test-model",
  };
}

interface CapturedRequest {
  url: string;
  headers: Record<string, string>;
}

/** 用桩 fetch 捕获内核真实发出的请求头；返回 400 让运行快速失败，不产生真实网络调用。 */
function captureRequests(): { calls: CapturedRequest[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: CapturedRequest[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    calls.push({
      url: typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url,
      headers: Object.fromEntries(new Headers(source).entries()),
    });
    return new Response(JSON.stringify({ error: { message: "stub", type: "stub" } }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

describe("OpenCode Go 网关判定", () => {
  it("匹配 opencode.ai 及其子域", () => {
    expect(isOpenCodeGateway("https://opencode.ai/zen/go/v1")).toBe(true);
    expect(isOpenCodeGateway("https://api.opencode.ai/v1")).toBe(true);
    expect(isOpenCodeGateway("HTTPS://OpenCode.AI/zen/go/v1")).toBe(true);
  });

  it("不匹配其他供应商、伪装域名与非法地址", () => {
    expect(isOpenCodeGateway("https://api.openai.com/v1")).toBe(false);
    expect(isOpenCodeGateway("https://opencode.ai.example.com/v1")).toBe(false);
    expect(isOpenCodeGateway("https://example.com/opencode.ai/v1")).toBe(false);
    expect(isOpenCodeGateway("")).toBe(false);
    expect(isOpenCodeGateway(undefined)).toBe(false);
    // 缺协议的 BaseURL 会被供应商适配层直接拒绝，这里不做主机名猜测。
    expect(isOpenCodeGateway("opencode.ai/zen/go/v1")).toBe(false);
  });

  it("仅为 OpenCode 主机构造附加头", () => {
    expect(openCodeRequestHeaders({ baseUrl: "https://opencode.ai/zen/go/v1", sessionId: "s-1" })).toEqual({
      "User-Agent": OPENCODE_CLIENT_USER_AGENT,
      [OPENCODE_SESSION_HEADER]: "s-1",
    });
    expect(openCodeRequestHeaders({ baseUrl: "https://api.openai.com/v1", sessionId: "s-1" })).toBeUndefined();
    // 会话 ID 缺失时仍标识客户端；调用方不传会话 ID 属于编程错误，网关会给出明确报错。
    expect(openCodeRequestHeaders({ baseUrl: "https://opencode.ai/zen/go/v1", sessionId: "  " })).toEqual({
      "User-Agent": OPENCODE_CLIENT_USER_AGENT,
    });
  });
});

describe("内核模型请求头", () => {
  const restoreStack: Array<() => void> = [];
  afterEach(() => {
    while (restoreStack.length > 0) restoreStack.pop()?.();
  });

  async function runWithoutNetwork(baseUrl: string, requestId: string, apiType?: PiCustomProviderConfig["apiType"]) {
    const capture = captureRequests();
    restoreStack.push(capture.restore);
    await expect(runPiKernel({
      requestId,
      mode: "research",
      objective: "分析这段旋律的音域",
      project: project(),
      provider: "custom",
      customProvider: providerConfig(baseUrl, apiType),
      modelId: "test-model",
      maximumTurns: 1,
    })).rejects.toThrow();
    expect(capture.calls.length).toBeGreaterThan(0);
    return capture.calls[0];
  }

  it("OpenCode Go 请求携带稳定会话 ID 与自有 User-Agent", async () => {
    const request = await runWithoutNetwork("https://opencode.ai/zen/go/v1", "kernel-session-1");
    expect(request.url).toContain("opencode.ai");
    expect(request.headers[OPENCODE_SESSION_HEADER]).toBe("kernel-session-1");
    expect(request.headers["user-agent"]).toBe(OPENCODE_CLIENT_USER_AGENT);
  });

  it("Responses 端点（预设默认 API 类型）同样携带会话头", async () => {
    const request = await runWithoutNetwork("https://opencode.ai/zen/go/v1", "kernel-session-3", "openai-responses");
    expect(request.url).toContain("/responses");
    expect(request.headers[OPENCODE_SESSION_HEADER]).toBe("kernel-session-3");
    expect(request.headers["user-agent"]).toBe(OPENCODE_CLIENT_USER_AGENT);
  });

  it("其他供应商不改写请求头", async () => {
    const request = await runWithoutNetwork("https://gateway.example.com/v1", "kernel-session-2");
    expect(request.headers[OPENCODE_SESSION_HEADER]).toBeUndefined();
    expect(request.headers["user-agent"]).not.toBe(OPENCODE_CLIENT_USER_AGENT);
  });
});
