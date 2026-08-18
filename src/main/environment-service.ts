import type {
  AuthPrompt,
  Credential,
  CredentialInfo,
  CredentialStore,
} from "@earendil-works/pi-ai";
import { app, safeStorage } from "electron";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EnvironmentCheck,
  EnvironmentIssue,
  ProviderStatus,
  StartupEnvironmentReport,
} from "../shared/bridge.js";
import type { PiCustomProviderConfig } from "../core/agent/pi-kernel.js";
import { getApiKey } from "./secure-settings.js";
import { getPiCredentialStore } from "./pi-credential-store.js";
import { PiCliCredentialStore } from "./pi-cli-credential-store.js";
import { getActiveSubscriptionProfile, readSubscriptionApiKey } from "./subscription-store.js";
import { checkConfiguredShell } from "./shell-service.js";
import type { ShellCheckResult } from "../shared/shell.js";

/**
 * 惰性加载 pi-ai 运行期值：启动路径（环境报告）不依赖 pi-ai 模块，
 * 包缺失时红色「内置 Pi 内核」提示仍能渲染；仅认证/登录等真正用到时
 * 才动态加载，失败抛可辨识错误而非崩溃。
 */
async function loadPiRuntime(): Promise<{
  createModels: typeof import("@earendil-works/pi-ai").createModels;
  openaiProvider: () => ReturnType<typeof import("@earendil-works/pi-ai/providers/openai").openaiProvider>;
  openaiCodexProvider: () => ReturnType<typeof import("@earendil-works/pi-ai/providers/openai-codex").openaiCodexProvider>;
}> {
  const [{ createModels }, { openaiProvider }, { openaiCodexProvider }] = await Promise.all([
    import("@earendil-works/pi-ai"),
    import("@earendil-works/pi-ai/providers/openai"),
    import("@earendil-works/pi-ai/providers/openai-codex"),
  ]);
  return { createModels, openaiProvider, openaiCodexProvider };
}

export type AgentAuthentication =
  | { provider: "openai"; apiKey?: string; credentials?: CredentialStore }
  | { provider: "openai-codex"; credentials: CredentialStore }
  | { provider: "custom"; customProvider: PiCustomProviderConfig }
  | null;

export type AppCredentialStore = Pick<CredentialStore, "read" | "list" | "modify" | "delete">;

interface EnvironmentDependencies {
  development: boolean;
  shellCheck: ShellCheckResult;
  piVersion: string | null;
  nodeVersion: string;
  electronVersion: string;
  safeStorageAvailable: boolean;
  secureApiKey: string | null;
  environmentApiKey: boolean;
  appCredentials: CredentialStore;
  piCredentials: Pick<CredentialStore, "read" | "list">;
  activeSubscriptionApiKey: string | null;
}

const MINIMUM_PI_NODE = [22, 19, 0] as const;
const APP_LOGIN_PROVIDER = "openai-codex";

export async function getStartupEnvironmentReport(): Promise<StartupEnvironmentReport> {
  const shellCheck = await checkConfiguredShell();
  return diagnoseEnvironment({
    development: !app.isPackaged,
    shellCheck,
    piVersion: installedPiVersion(),
    nodeVersion: process.versions.node,
    electronVersion: process.versions.electron ?? "",
    safeStorageAvailable: safeStorage.isEncryptionAvailable(),
    secureApiKey: getApiKey(),
    environmentApiKey: Boolean(process.env.OPENAI_API_KEY?.trim()),
    appCredentials: getPiCredentialStore(),
    piCredentials: new PiCliCredentialStore(),
    activeSubscriptionApiKey: (() => {
      const active = getActiveSubscriptionProfile();
      return active ? readSubscriptionApiKey(active.id) : null;
    })(),
  });
}

export async function diagnoseEnvironment(
  dependencies: EnvironmentDependencies,
): Promise<StartupEnvironmentReport> {
  const providerResult = await inspectProviders(dependencies);
  const nodeReady = isVersionAtLeast(dependencies.nodeVersion, MINIMUM_PI_NODE);
  const checks: EnvironmentCheck[] = [
    {
      id: "electron",
      label: "Electron 运行时",
      status: dependencies.electronVersion ? "ready" : "missing",
      required: true,
      version: dependencies.electronVersion || undefined,
      message: dependencies.electronVersion ? "桌面运行时可用。" : "未检测到 Electron 运行时。",
    },
    {
      id: "node",
      label: "内置 Node.js",
      status: nodeReady ? "ready" : "missing",
      required: true,
      version: dependencies.nodeVersion,
      message: nodeReady ? "满足 Pi 内核版本要求。" : "Pi 0.84.1 需要 Node.js 22.19.0 或更高版本。",
    },
    {
      id: "shell",
      label: "统一 Shell",
      status: dependencies.shellCheck.usable ? "ready" : "missing",
      required: true,
      version: dependencies.shellCheck.version,
      message: dependencies.shellCheck.message,
    },
    {
      id: "pi-core",
      label: "内置 Pi 内核",
      status: dependencies.piVersion ? "ready" : "missing",
      required: true,
      version: dependencies.piVersion || undefined,
      message: dependencies.piVersion ? "Pi SDK 已随应用内置，无需另行安装。" : "应用内置 Pi SDK 无法加载，请重新安装应用。",
    },
    {
      id: "secure-storage",
      label: "系统凭据加密",
      status: dependencies.safeStorageAvailable ? "ready" : "warning",
      required: false,
      message: dependencies.safeStorageAvailable
        ? "可安全保存应用内 API Key 与订阅登录。"
        : "当前系统无法安全保存新凭据；仍可读取环境变量或 Pi CLI 登录。",
    },
  ];
  const issues: EnvironmentIssue[] = [];
  for (const check of checks) {
    if (check.required && check.status === "missing") {
      issues.push({
        id: check.id,
        message: `${check.label}不可用`,
        instruction: check.id === "shell"
          ? "请在设置 > 通用 > Shell 路径中选择可用的 Bash 或 PowerShell 并检测。"
          : "请修复或重新安装 M Agent。",
        action: check.id === "shell" ? "open-shell-settings" : "repair-app",
      });
    }
  }
  const agentReady = providerResult.providers.some((provider) => provider.usable)
    || Boolean(dependencies.activeSubscriptionApiKey);
  if (!agentReady) {
    issues.push({
      id: "provider-auth",
      message: "尚无可用的在线模型供应商",
      instruction: "请在设置 > 供应商 中新建、导入或激活一个带 API Key 的订阅；未配置时仅能使用离线演示。",
      action: "open-provider-settings",
    });
  }
  return {
    schemaVersion: 1,
    checkedAt: new Date().toISOString(),
    development: dependencies.development,
    checks,
    providers: providerResult.providers,
    agentReady,
    activeProvider: providerResult.activeProvider,
    issues,
  };
}

export async function resolveAgentAuthentication(signal?: AbortSignal): Promise<AgentAuthentication> {
  if (process.env.MAGENT_FORCE_OFFLINE === "1") return null;
  const activeSubscription = getActiveSubscriptionProfile();
  if (activeSubscription) {
    const apiKey = readSubscriptionApiKey(activeSubscription.id);
    if (apiKey) {
      const activeModelId = activeSubscription.activeModelId
        ?? activeSubscription.models[0]?.id
        ?? "";
      if (activeModelId) {
        return {
          provider: "custom",
          customProvider: {
            providerId: activeSubscription.providerId,
            apiType: activeSubscription.apiType,
            baseUrl: activeSubscription.baseUrl,
            apiKey,
            models: activeSubscription.models,
            activeModelId,
          },
        };
      }
    }
  }
  const secureApiKey = getApiKey();
  if (secureApiKey) return { provider: "openai", apiKey: secureApiKey };
  const appCredentials = getPiCredentialStore();
  const pi = await loadPiRuntime();
  const appModels = pi.createModels({ credentials: appCredentials });
  appModels.setProvider(pi.openaiCodexProvider());
  if (await appModels.getAuth("openai-codex", { signal })) {
    return { provider: "openai-codex", credentials: appCredentials };
  }
  const models = await createProviderModels(appCredentials);
  if (await models.getAuth("openai", { signal })) return { provider: "openai", credentials: appCredentials };
  return null;
}

export async function loginOpenAICodex(
  openExternal: (url: string) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("当前系统无法安全加密订阅凭据，不能在应用内登录。");
  }
  const pi = await loadPiRuntime();
  const models = pi.createModels({ credentials: getPiCredentialStore() });
  models.setProvider(pi.openaiCodexProvider());
  let browserOpenError: Error | undefined;
  await models.login(APP_LOGIN_PROVIDER, "oauth", {
    signal,
    prompt: async (prompt) => handleLoginPrompt(prompt),
    notify: (event) => {
      if (event.type !== "auth_url") return;
      try {
        const url = new URL(event.url);
        if (url.protocol !== "https:" || url.hostname !== "auth.openai.com") {
          throw new Error("Pi 返回了未获准的登录地址。");
        }
        void openExternal(url.toString()).catch((error) => {
          browserOpenError = error instanceof Error ? error : new Error(String(error));
        });
      } catch (error) {
        browserOpenError = error instanceof Error ? error : new Error(String(error));
      }
    },
  });
  if (browserOpenError) throw new Error("无法打开系统浏览器完成登录。", { cause: browserOpenError });
  const verified = await models.getAuth(APP_LOGIN_PROVIDER, { signal });
  if (!verified) throw new Error("订阅登录没有生成可用凭据。");
}

export async function saveProviderApiKey(
  providerId: "openai",
  apiKey: unknown,
): Promise<void> {
  if (typeof apiKey !== "string") throw new Error("API Key 必须是字符串。");
  const clean = apiKey.trim();
  if (!clean) throw new Error("API Key 不能为空。");
  if (clean.length > 1_024) throw new Error("API Key 长度超过上限。");
  if (!safeStorage.isEncryptionAvailable()) throw new Error("当前系统无法安全加密供应商凭据。");
  await getPiCredentialStore().modify(providerId, async () => ({ type: "api_key", key: clean }));
}

export async function migrateLegacyApiKey(apiKey: string): Promise<void> {
  const clean = apiKey.trim();
  if (!clean) return;
  await getPiCredentialStore().modify("openai", async (current) => (
    current ?? { type: "api_key", key: clean }
  ));
}

export async function importPiCliCredentials(): Promise<readonly CredentialInfo[]> {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("当前系统无法安全加密导入的 Pi 凭据。");
  }
  const source = new PiCliCredentialStore();
  const destination = getPiCredentialStore();
  const imported: CredentialInfo[] = [];
  for (const providerId of ["openai", APP_LOGIN_PROVIDER] as const) {
    const credential = await source.read(providerId);
    if (!credential) continue;
    await destination.modify(providerId, async (current) => current ?? credential);
    imported.push({ providerId, type: credential.type });
  }
  return imported;
}

export async function clearProviderApiKey(providerId: "openai"): Promise<void> {
  await getPiCredentialStore().delete(providerId);
}

export async function logoutOpenAICodex(): Promise<void> {
  await getPiCredentialStore().delete(APP_LOGIN_PROVIDER);
}

async function inspectProviders(dependencies: EnvironmentDependencies): Promise<{
  providers: ProviderStatus[];
  activeProvider: StartupEnvironmentReport["activeProvider"];
}> {
  const appEntries = await safeList(dependencies.appCredentials);
  const piEntries = await safeList(dependencies.piCredentials);
  const models = await createProviderModels(dependencies.appCredentials);
  const apiSource: ProviderStatus["source"] = dependencies.secureApiKey
    ? "app"
    : appEntries.some((entry) => entry.providerId === "openai")
      ? "app"
      : piEntries.some((entry) => entry.providerId === "openai")
        ? "pi"
        : dependencies.environmentApiKey
          ? "environment"
          : "none";
  const apiConfigured = apiSource !== "none";
  let apiUsable = apiConfigured && apiSource !== "pi";
  if (!dependencies.secureApiKey) {
    try { apiUsable = apiSource === "pi" ? false : Boolean(await models.checkAuth("openai")); }
    catch { apiUsable = false; }
  }
  const oauthSource: ProviderStatus["source"] = appEntries.some((entry) => entry.providerId === APP_LOGIN_PROVIDER)
    ? "app"
    : piEntries.some((entry) => entry.providerId === APP_LOGIN_PROVIDER)
      ? "pi"
      : "none";
  const oauthConfigured = oauthSource !== "none";
  let oauthUsable = false;
  if (oauthConfigured) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      oauthUsable = oauthSource === "pi"
        ? false
        : Boolean(await models.getAuth(APP_LOGIN_PROVIDER, { signal: controller.signal }));
    }
    catch { oauthUsable = false; }
    finally { clearTimeout(timeout); }
  }
  const providers: ProviderStatus[] = [
    {
      id: "openai",
      label: "OpenAI API",
      configured: apiConfigured,
      usable: apiUsable,
      authType: apiConfigured ? "api_key" : null,
      source: apiSource,
      message: apiUsable
        ? `API Key 已配置（${sourceLabel(apiSource)}，请求时验证）。`
        : apiConfigured
          ? "检测到 Pi API Key，但未能导入应用安全存储。"
          : "尚未配置 API Key。",
    },
    {
      id: APP_LOGIN_PROVIDER,
      label: "OpenAI Codex 订阅",
      configured: oauthConfigured,
      usable: oauthUsable,
      authType: oauthConfigured ? "oauth" : null,
      source: oauthSource,
      message: oauthUsable
        ? `ChatGPT Plus/Pro 登录可用（${sourceLabel(oauthSource)}）。`
        : oauthConfigured
          ? "检测到订阅登录，但凭据已失效；请重新登录。"
          : "尚未登录 ChatGPT Plus/Pro。",
    },
  ];
  return {
    providers,
    activeProvider: dependencies.secureApiKey
      ? "openai"
      : oauthUsable && oauthSource === "app"
        ? "openai-codex"
        : apiUsable
          ? "openai"
          : oauthUsable
            ? "openai-codex"
            : "offline",
  };
}

async function createProviderModels(credentials: CredentialStore) {
  const pi = await loadPiRuntime();
  const models = pi.createModels({ credentials });
  models.setProvider(pi.openaiProvider());
  models.setProvider(pi.openaiCodexProvider());
  return models;
}

async function handleLoginPrompt(prompt: AuthPrompt): Promise<string> {
  if (prompt.type === "select") {
    if (!prompt.options.some((option) => option.id === "browser")) throw new Error("Pi 不支持浏览器登录。");
    return "browser";
  }
  if (prompt.type === "manual_code") return waitForPromptCancellation(prompt.signal);
  throw new Error(`应用内登录暂不支持 Pi 提示类型：${prompt.type}`);
}

function waitForPromptCancellation(signal?: AbortSignal): Promise<string> {
  return new Promise((_, reject) => {
    const fail = () => reject(signal?.reason ?? new Error("浏览器登录步骤已结束。"));
    if (signal?.aborted) fail();
    else signal?.addEventListener("abort", fail, { once: true });
  });
}

async function safeList(store: Pick<CredentialStore, "list">): Promise<readonly CredentialInfo[]> {
  try { return await store.list(); }
  catch { return []; }
}

function installedPackageVersion(packageName: string): string | null {
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(currentDir, "../../node_modules", packageName, "package.json"),
      join(currentDir, "../../../node_modules", packageName, "package.json"),
    ];
    const manifestPath = candidates.find((candidate) => existsSync(candidate));
    if (!manifestPath) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

function installedPiVersion(): string | null {
  const core = installedPackageVersion("@earendil-works/pi-agent-core");
  const ai = installedPackageVersion("@earendil-works/pi-ai");
  return core && ai ? (core === ai ? core : `${core} / ${ai}`) : null;
}

function isVersionAtLeast(version: string, minimum: readonly [number, number, number]): boolean {
  const values = version.split(".").slice(0, 3).map(Number);
  if (values.length !== 3 || values.some((value) => !Number.isInteger(value))) return false;
  for (let index = 0; index < 3; index += 1) {
    if (values[index] > minimum[index]) return true;
    if (values[index] < minimum[index]) return false;
  }
  return true;
}

function sourceLabel(source: ProviderStatus["source"]): string {
  if (source === "app") return "应用安全存储";
  if (source === "pi") return "Pi 登录配置";
  if (source === "environment") return "环境变量";
  return "未配置";
}

export { isVersionAtLeast };
