import { contextBridge, ipcRenderer } from "electron";
import type { AgentRequestPayload, MagentBridge, RendererProjectPayload } from "../shared/bridge.js";

const bridge: MagentBridge = {
  openMidi: () => ipcRenderer.invoke("midi:open"),
  exportMidi: (payload: RendererProjectPayload) => ipcRenderer.invoke("midi:export", payload),
  openProject: () => ipcRenderer.invoke("project:open"),
  saveProject: (payload: RendererProjectPayload) => ipcRenderer.invoke("project:save", payload),
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
};

contextBridge.exposeInMainWorld("magent", bridge);
