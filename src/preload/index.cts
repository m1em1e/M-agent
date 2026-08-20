import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  AgentLiveUpdate,
  AgentRequestPayload,
  MagentBridge,
  ProjectOpenIntent,
  RendererProjectPayload,
} from "../shared/bridge.js";
import type {
  FetchModelsRequest,
  SubscriptionInput,
} from "../shared/subscriptions.js";

const startupIntent: ProjectOpenIntent | "" = (() => {
  const arg = process.argv.find((entry) => entry.startsWith("--magent-intent="));
  const value = arg?.split("=")[1];
  return value === "new-project" || value === "open-project" || value === "import-midi" ? value : "";
})();

const bridge: MagentBridge = {
  platform: process.platform,
  startupIntent,
  onMenuAction: (callback: (action: string) => void) => {
    const listener = (_event: unknown, action: string) => callback(action);
    ipcRenderer.on("menu:action", listener);
    return () => ipcRenderer.removeListener("menu:action", listener);
  },
  onMenuOpenRecent: (callback: (path: string) => void) => {
    const listener = (_event: unknown, path: string) => callback(path);
    ipcRenderer.on("menu:open-recent", listener);
    return () => ipcRenderer.removeListener("menu:open-recent", listener);
  },
  openMidi: () => ipcRenderer.invoke("midi:open"),
  exportMidi: (payload: RendererProjectPayload, defaultName?: string) => ipcRenderer.invoke("midi:export", payload, defaultName),
  exportAudio: (payload) => ipcRenderer.invoke("audio:export", payload),
  openProject: () => ipcRenderer.invoke("project:open"),
  saveProject: (payload: RendererProjectPayload, defaultName?: string) => ipcRenderer.invoke("project:save", payload, defaultName),
  saveApiKey: (key: string) => ipcRenderer.invoke("settings:save-api-key", key),
  clearApiKey: () => ipcRenderer.invoke("settings:clear-api-key"),
  hasApiKey: () => ipcRenderer.invoke("settings:has-api-key"),
  saveProviderApiKey: (providerId: "openai", key: string) => ipcRenderer.invoke("provider:save-api-key", providerId, key),
  clearProviderApiKey: (providerId: "openai") => ipcRenderer.invoke("provider:clear-api-key", providerId),
  getStartupEnvironment: () => ipcRenderer.invoke("environment:get-startup-report"),
  loginOpenAICodex: () => ipcRenderer.invoke("provider:login-openai-codex"),
  logoutOpenAICodex: () => ipcRenderer.invoke("provider:logout-openai-codex"),
  getShellSettings: () => ipcRenderer.invoke("shell:get-settings"),
  browseShell: () => ipcRenderer.invoke("shell:browse"),
  checkShell: (path: string) => ipcRenderer.invoke("shell:check", path),
  runAgent: (payload: AgentRequestPayload) => ipcRenderer.invoke("agent:run", payload),
  cancelAgent: () => ipcRenderer.invoke("agent:cancel"),
  onAgentLive: (callback: (update: AgentLiveUpdate) => void) => {
    const listener = (_event: unknown, update: AgentLiveUpdate) => callback(update);
    ipcRenderer.on("agent:live", listener);
    return () => ipcRenderer.removeListener("agent:live", listener);
  },
  listAgentSkills: () => ipcRenderer.invoke("agent:list-skills"),
  listRecentProjects: () => ipcRenderer.invoke("projects:list-recent"),
  openProjectAt: (path: string) => ipcRenderer.invoke("project:open-path", path),
  saveProjectTo: (payload: RendererProjectPayload, path: string) => ipcRenderer.invoke("project:save-to", payload, path),
  createProjectWindow: (intent: ProjectOpenIntent) => ipcRenderer.invoke("window:create-project", intent),
  listSubscriptions: () => ipcRenderer.invoke("subscriptions:list"),
  createSubscription: (input: SubscriptionInput) => ipcRenderer.invoke("subscriptions:create", input),
  updateSubscription: (id: string, input: SubscriptionInput) => ipcRenderer.invoke("subscriptions:update", id, input),
  deleteSubscription: (id: string) => ipcRenderer.invoke("subscriptions:delete", id),
  activateSubscription: (id: string) => ipcRenderer.invoke("subscriptions:activate", id),
  importSubscriptions: () => ipcRenderer.invoke("subscriptions:import"),
  fetchSubscriptionModels: (request: FetchModelsRequest) => ipcRenderer.invoke("subscriptions:fetch-models", request),
  getUsageSummary: () => ipcRenderer.invoke("usage:get-summary"),
  getUsageDays: (page: number) => ipcRenderer.invoke("usage:get-days", page),
  getUsageModels: (page: number) => ipcRenderer.invoke("usage:get-models", page),
  clearUsage: () => ipcRenderer.invoke("usage:clear"),
  minimizeWindow: () => ipcRenderer.invoke("window:minimize"),
  toggleMaximizeWindow: () => ipcRenderer.invoke("window:toggle-maximize"),
  closeWindow: () => ipcRenderer.invoke("window:close"),
  confirmWindowClose: () => ipcRenderer.invoke("window:confirm-close"),
  onBeforeWindowClose: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("app:before-close", listener);
    return () => ipcRenderer.removeListener("app:before-close", listener);
  },
  listInstruments: () => ipcRenderer.invoke("instrument-library:list"),
  downloadRecommendedInstrument: () => ipcRenderer.invoke("instrument-library:download-recommended"),
  pickInstrumentFiles: () => ipcRenderer.invoke("instrument-library:pick-files"),
  bindInstrumentToProject: (path: string) => ipcRenderer.invoke("instrument-library:bind-instrument", path),
  getInstrumentSystemPath: () => ipcRenderer.invoke("instrument-library:get-system-path"),
  setInstrumentSystemPath: (path: string, migrate: boolean) => ipcRenderer.invoke("instrument-library:set-system-path", path, migrate),
  openInstrumentFolder: () => ipcRenderer.invoke("instrument-library:open-system-folder"),
  setInstrumentEnabled: (path: string, enabled: boolean) => ipcRenderer.invoke("instrument-library:set-enabled", path, enabled),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  readInstrumentFile: (path: string) => ipcRenderer.invoke("instrument-library:read-file", path),
};

contextBridge.exposeInMainWorld("magent", bridge);
