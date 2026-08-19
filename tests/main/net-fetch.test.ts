import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const netFetchMock = vi.fn();
const isReadyMock = vi.fn(() => true);

vi.mock("electron", () => ({
  app: { isReady: () => isReadyMock() },
  net: { fetch: (...args: unknown[]) => netFetchMock(...args) },
}));

import { installSystemProxyFetch, restoreGlobalFetch } from "../../src/main/net-fetch";

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  netFetchMock.mockReset();
  isReadyMock.mockReset();
  isReadyMock.mockReturnValue(true);
  restoreGlobalFetch();
});

afterEach(() => {
  restoreGlobalFetch();
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("installSystemProxyFetch", () => {
  it("替换全局 fetch 并转发到 net.fetch", async () => {
    const response = { ok: true, status: 200 } as unknown as Response;
    netFetchMock.mockResolvedValue(response);

    installSystemProxyFetch();
    expect(globalThis.fetch).not.toBe(ORIGINAL_FETCH);

    const result = await globalThis.fetch("https://api.example.com/v1/chat", { method: "POST" });
    expect(netFetchMock).toHaveBeenCalledTimes(1);
    expect(netFetchMock).toHaveBeenCalledWith("https://api.example.com/v1/chat", { method: "POST" });
    expect(result).toBe(response);
  });

  it("URL 对象输入转成字符串转发给 net.fetch", async () => {
    installSystemProxyFetch();
    const url = new URL("https://api.example.com/v1/chat");
    await globalThis.fetch(url);
    expect(netFetchMock).toHaveBeenCalledWith("https://api.example.com/v1/chat", undefined);
  });

  it("app 未就绪时回退到安装时的原始 fetch", async () => {
    isReadyMock.mockReturnValue(false);
    const fallbackMock = vi.fn();
    globalThis.fetch = fallbackMock as unknown as typeof fetch;

    installSystemProxyFetch();
    await globalThis.fetch("https://api.example.com/");
    expect(fallbackMock).toHaveBeenCalledWith("https://api.example.com/", undefined);
    expect(netFetchMock).not.toHaveBeenCalled();
  });

  it("重复安装只生效一次，restoreGlobalFetch 恢复原始 fetch", () => {
    installSystemProxyFetch();
    const first = globalThis.fetch;
    installSystemProxyFetch();
    expect(globalThis.fetch).toBe(first);

    restoreGlobalFetch();
    expect(globalThis.fetch).toBe(ORIGINAL_FETCH);
  });
});