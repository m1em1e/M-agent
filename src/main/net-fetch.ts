import { app, net } from "electron";

let installed = false;
let originalFetch: typeof fetch | undefined;

/**
 * 把主进程的全局 fetch 替换为 Electron 的 net.fetch，让模型调用等 HTTP
 * 请求走 Chromium 网络栈，从而自动尊重操作系统系统代理（Windows 的
 * WinINET 全局代理、macOS/Linux 的系统代理设置）。
 *
 * 背景：主进程的模型请求由 Node 的 fetch（undici）发出，它既不读 Windows
 * 系统代理，默认也不读 HTTP(S)_PROXY 环境变量，因此开"全局代理"时请求仍
 * 是直连（被地区限制拦截），只有 TUN 模式（网卡层接管全部流量）才能生效。
 * net.fetch 在 app ready 前不可用，此时回退到原始 fetch 保持旧行为。
 */
export function installSystemProxyFetch(): void {
  if (installed) return;
  installed = true;
  originalFetch = globalThis.fetch;
  const fallback = originalFetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    if (!app.isReady()) {
      return fallback(input, init);
    }
    const netInput: string =
      input instanceof URL ? input.href : typeof input === "string" ? input : input.url;
    return net.fetch(netInput, init);
  }) as typeof fetch;
}

export function restoreGlobalFetch(): void {
  if (!installed) return;
  installed = false;
  if (originalFetch) globalThis.fetch = originalFetch;
  originalFetch = undefined;
}