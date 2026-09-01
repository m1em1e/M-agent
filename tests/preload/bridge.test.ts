import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { transform } from "esbuild";
import type { MagentBridge } from "../../src/shared/bridge";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  exposeInMainWorld: vi.fn(),
  getPathForFile: vi.fn(),
}));

const electronMock = {
  contextBridge: { exposeInMainWorld: mocks.exposeInMainWorld },
  ipcRenderer: { invoke: mocks.invoke, on: mocks.on, removeListener: mocks.removeListener },
  webUtils: { getPathForFile: mocks.getPathForFile },
};

const PRELOAD_SOURCE = new URL("../../src/preload/index.cts", import.meta.url);

/** 用 esbuild 把 sandbox preload（.cts → CJS）转译后以 mock 的 electron 求值，捕获暴露的 bridge。 */
async function loadBridge(argv = process.argv): Promise<MagentBridge> {
  const source = readFileSync(PRELOAD_SOURCE, "utf8");
  const result = await transform(source, { loader: "ts", format: "cjs", target: "node18" });
  const module = { exports: {} };
  const requireMock = (id: string) => {
    if (id === "electron") return electronMock;
    throw new Error(`preload 不应在运行时依赖未 mock 的模块：${id}`);
  };
  const fakeProcess = { ...process, argv };
  new Function("require", "module", "exports", "process", result.code)(requireMock, module, module.exports, fakeProcess);
  const call = mocks.exposeInMainWorld.mock.calls.find(([name]) => name === "magent");
  if (!call) throw new Error("preload 未调用 contextBridge.exposeInMainWorld(\"magent\", …)");
  return call[1] as MagentBridge;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("preload bridge 契约", () => {
  it("通过 contextBridge.exposeInMainWorld(\"magent\", …) 暴露接口", async () => {
    const bridge = await loadBridge();
    expect(bridge).toBeDefined();
    expect(mocks.exposeInMainWorld).toHaveBeenCalledWith("magent", expect.any(Object));
  });

  it("透传平台信息且 startupIntent 默认为空", async () => {
    const bridge = await loadBridge();
    expect(bridge.platform).toBe(process.platform);
    expect(bridge.startupIntent).toBe("");
  });

  it.each([
    ["openMidi", [], "midi:open"],
    ["openProject", [], "project:open"],
    ["getStartupEnvironment", [], "environment:get-startup-report"],
    ["loginOpenAICodex", [], "provider:login-openai-codex"],
    ["logoutOpenAICodex", [], "provider:logout-openai-codex"],
    ["getShellSettings", [], "shell:get-settings"],
    ["browseShell", [], "shell:browse"],
    ["cancelAgent", [], "agent:cancel"],
    ["listAgentSkills", [], "agent:list-skills"],
    ["listRecentProjects", [], "projects:list-recent"],
    ["listSubscriptions", [], "subscriptions:list"],
    ["importSubscriptions", [], "subscriptions:import"],
    ["getUsageSummary", [], "usage:get-summary"],
    ["clearUsage", [], "usage:clear"],
    ["minimizeWindow", [], "window:minimize"],
    ["toggleMaximizeWindow", [], "window:toggle-maximize"],
    ["closeWindow", [], "window:close"],
    ["confirmWindowClose", [], "window:confirm-close"],
    ["listInstruments", [], "instrument-library:list"],
    ["downloadRecommendedInstrument", [], "instrument-library:download-recommended"],
    ["pickInstrumentFiles", [], "instrument-library:pick-files"],
    ["getInstrumentSystemPath", [], "instrument-library:get-system-path"],
    ["openInstrumentFolder", [], "instrument-library:open-system-folder"],
  ] as Array<[keyof MagentBridge, unknown[], string]>)("路由 %s → %s", async (method, args, channel) => {
    const bridge = await loadBridge();
    await (bridge[method] as (...params: unknown[]) => Promise<unknown>)(...args);
    expect(mocks.invoke).toHaveBeenCalledWith(channel);
  });

  it.each([
    ["exportMidi", ["midi:export", "song.mid"], "midi:export"],
    ["exportAudio", [{ format: "wav", bytes: new ArrayBuffer(0), defaultName: "song.wav" }], "audio:export"],
    ["saveProject", ["midi:project", "song.magent"], "project:save"],
    ["saveProviderApiKey", ["openai", "sk-test"], "provider:save-api-key"],
    ["clearProviderApiKey", ["openai"], "provider:clear-api-key"],
    ["checkShell", ["C:\\Windows\\system32\\bash.exe"], "shell:check"],
    ["runAgent", ["agent:request"], "agent:run"],
    ["openProjectAt", ["C:\\song.magent"], "project:open-path"],
    ["saveProjectTo", ["midi:project", "C:\\song.magent"], "project:save-to"],
    ["createProjectWindow", ["new-project"], "window:create-project"],
    ["createSubscription", ["subscription:input"], "subscriptions:create"],
    ["updateSubscription", ["sub-1", "subscription:input"], "subscriptions:update"],
    ["deleteSubscription", ["sub-1"], "subscriptions:delete"],
    ["activateSubscription", ["sub-1"], "subscriptions:activate"],
    ["fetchSubscriptionModels", ["fetch:models"], "subscriptions:fetch-models"],
    ["getUsageDays", [2], "usage:get-days"],
    ["getUsageModels", [1], "usage:get-models"],
    ["bindInstrumentToProject", ["C:\\piano.sf2"], "instrument-library:bind-instrument"],
    ["setInstrumentSystemPath", ["C:\\Instruments", true], "instrument-library:set-system-path"],
    ["setInstrumentEnabled", ["C:\\piano.sf2", false], "instrument-library:set-enabled"],
    ["readInstrumentFile", ["C:\\piano.sf2"], "instrument-library:read-file"],
  ] as Array<[keyof MagentBridge, unknown[], string]>)("透传 %s 的参数 → %s", async (method, args, channel) => {
    const bridge = await loadBridge();
    await (bridge[method] as (...params: unknown[]) => Promise<unknown>)(...args);
    expect(mocks.invoke).toHaveBeenCalledWith(channel, ...args);
  });

  it("getPathForFile 使用 webUtils 解析文件路径", async () => {
    mocks.getPathForFile.mockReturnValue("C:\\piano\\file.mid");
    const bridge = await loadBridge();
    const file = { name: "file.mid" } as File;
    expect(bridge.getPathForFile(file)).toBe("C:\\piano\\file.mid");
    expect(mocks.getPathForFile).toHaveBeenCalledWith(file);
  });

  it.each([
    ["onMenuAction", "menu:action"],
    ["onMenuOpenRecent", "menu:open-recent"],
    ["onAgentLive", "agent:live"],
    ["onBeforeWindowClose", "app:before-close"],
  ] as Array<[keyof MagentBridge, string]>)("%s 订阅 %s 并返回取消函数", async (method, channel) => {
    const bridge = await loadBridge();
    const unsubscribe = (bridge[method] as (callback: (...params: unknown[]) => void) => () => void)(vi.fn());
    expect(mocks.on).toHaveBeenCalledWith(channel, expect.any(Function));
    unsubscribe();
    expect(mocks.removeListener).toHaveBeenCalledWith(channel, expect.any(Function));
  });
});

describe("preload startupIntent 解析", () => {
  it.each([
    ["--magent-intent=new-project", "new-project"],
    ["--magent-intent=open-project", "open-project"],
    ["--magent-intent=import-midi", "import-midi"],
    ["--magent-intent=unknown", ""],
  ] as Array<[string, string]>)("argv %s → %s", async (flag, expected) => {
    const bridge = await loadBridge([...process.argv.filter((arg) => !arg.startsWith("--magent-intent=")), flag]);
    expect(bridge.startupIntent).toBe(expected);
  });
});