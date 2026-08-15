import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type OpenDialogOptions } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, stat, writeFile } from "node:fs/promises";
import { exportMidi, importMidi } from "../core/midi/index.js";
import type { RendererProjectPayload } from "../shared/bridge.js";
import type { MidiProject } from "../shared/midi.js";
import { assertProjectFile, rendererPayloadToProject } from "./project-adapter.js";
import { clearApiKey, getApiKey, hasApiKey } from "./secure-settings.js";
import { runAgent } from "./agent-service.js";
import {
  getStartupEnvironmentReport,
  clearProviderApiKey,
  importPiCliCredentials,
  loginOpenAICodex,
  logoutOpenAICodex,
  resolveAgentAuthentication,
  saveProviderApiKey,
  migrateLegacyApiKey,
} from "./environment-service.js";
import { getPiCredentialStore } from "./pi-credential-store.js";
import { checkAndSaveConfiguredShell, getConfiguredShellSettings } from "./shell-service.js";
import { registerSubscriptionIpc } from "./subscription-ipc.js";
import { registerUsageIpc } from "./usage-ipc.js";
import { registerInstrumentLibraryIpc } from "./audio/library-ipc.js";
import { loadAvailableSkills } from "./skill-loader.js";
import { listRecentProjects, recordRecentProject } from "./recent-projects.js";
import { APP_MENU_GROUPS, type AppMenuItem } from "../shared/menu.js";
import type { ProjectOpenIntent } from "../shared/bridge.js";

/** 用户在本会话中经对话框/打开确认过的可写工程路径（供「保存项目」免对话框直写）。 */
const approvedSavePaths = new Set<string>();

const currentDir = dirname(fileURLToPath(import.meta.url));
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const MAX_MIDI_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PROJECT_FILE_BYTES = 32 * 1024 * 1024;
const UI_ZOOM_FACTOR = 1.15;

if (process.platform === "win32") {
  // Keep the Electron development host out of installed-app taskbar groups and stale pins.
  app.setAppUserModelId(isDevelopment ? "studio.magent.desktop.dev" : "studio.magent.desktop");
}

// 在 whenReady 中按平台安装菜单：macOS 使用原生 Menu Bar，其余平台不显示应用菜单。
// 菜单项来自共享数据源 APP_MENU_GROUPS，与 Windows/Linux 应用内菜单保持同步。
function installApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const sendAction = (action: string) => {
    BrowserWindow.getFocusedWindow()?.webContents.send("menu:action", action);
  };
  const buildItems = (items: AppMenuItem[]): Electron.MenuItemConstructorOptions[] => items.map((item) => {
    if (item.separator) return { type: "separator" };
    if (item.role) return { role: item.role, label: item.label };
    if (item.recentProjects) {
      const recent = listRecentProjects();
      return {
        label: item.label,
        submenu: recent.length > 0
          ? recent.map((entry) => ({
              label: entry.title || entry.path.split(/[\\/]/).pop() || entry.path,
              click: () => BrowserWindow.getFocusedWindow()?.webContents.send("menu:open-recent", entry.path),
            }))
          : [{ label: "暂无最近项目", enabled: false }],
      };
    }
    if (item.submenu) {
      return { label: item.label, submenu: buildItems(item.submenu) };
    }
    return {
      label: item.label,
      ...(item.accelerator ? { accelerator: item.accelerator } : {}),
      click: () => item.action && sendAction(item.action),
    };
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: "M Agent",
      submenu: [
        { role: "about", label: "关于 M Agent" },
        { type: "separator" },
        { role: "hide", label: "隐藏 M Agent" },
        { role: "hideOthers", label: "隐藏其他" },
        { role: "unhide", label: "全部显示" },
        { type: "separator" },
        { role: "quit", label: "退出 M Agent" },
      ],
    },
    ...APP_MENU_GROUPS.map((group) => ({
      label: group.label,
      submenu: buildItems(group.items),
    })),
  ]));
}

function createWindow(openIntent?: ProjectOpenIntent): void {
  const productionUrl = pathToFileURL(join(currentDir, "../../dist/index.html")).toString();
  const developmentIconRoot = join(currentDir, "../../build");
  const windowIcon = process.platform === "win32"
    ? app.isPackaged
      ? join(process.resourcesPath, "icons/icon.ico")
      : join(developmentIconRoot, "icon.ico")
    : process.platform === "linux"
      ? app.isPackaged
        ? join(process.resourcesPath, "icons/icon.png")
        : join(developmentIconRoot, "icons/512x512.png")
      : undefined;
  const window = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1250,
    minHeight: 800,
    backgroundColor: "#101214",
    ...(windowIcon ? { icon: windowIcon } : {}),
    titleBarStyle: "hiddenInset",
    webPreferences: {
      // Sandboxed preloads must use Electron's CommonJS-compatible loader.
      preload: join(currentDir, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      ...(openIntent ? { additionalArguments: [`--magent-intent=${openIntent}`] } : {}),
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  // macOS 已有原生菜单的编辑角色处理剪贴板快捷键；其余平台补回。
  if (process.platform !== "darwin") registerClipboardShortcuts(window);
  window.webContents.on("will-navigate", (event, url) => {
    const allowed = isDevelopment
      ? new URL(url).origin === new URL(process.env.VITE_DEV_SERVER_URL!).origin
      : url === productionUrl;
    if (!allowed) event.preventDefault();
  });
  window.webContents.setZoomFactor(UI_ZOOM_FACTOR);
  window.webContents.on("did-finish-load", () => {
    window.webContents.setZoomFactor(UI_ZOOM_FACTOR);
  });
  if (isDevelopment) void window.loadURL(process.env.VITE_DEV_SERVER_URL!);
  else void window.loadURL(productionUrl);
}

ipcMain.handle("midi:open", async () => {
  const selected = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "MIDI", extensions: ["mid", "midi"] }] });
  if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
  const filePath = selected.filePaths[0];
  await assertFileSize(filePath, MAX_MIDI_FILE_BYTES, "MIDI 文件");
  const result = importMidi(new Uint8Array(await readFile(filePath)), { title: filePath.split(/[\\/]/).pop()?.replace(/\.midi?$/i, "") });
  return { canceled: false, filePath, project: result.project, warnings: result.warnings.map((warning) => warning.message) };
});

ipcMain.handle("midi:export", async (_event, payload: RendererProjectPayload) => {
  const project = rendererPayloadToProject(payload);
  const selected = await dialog.showSaveDialog({ defaultPath: `${project.title}.mid`, filters: [{ name: "MIDI", extensions: ["mid"] }] });
  if (selected.canceled || !selected.filePath) return { canceled: true };
  await writeFile(selected.filePath, exportMidi(project, { format: 1 }));
  return { canceled: false, filePath: selected.filePath };
});

ipcMain.handle("project:open", async () => {
  const selected = await dialog.showOpenDialog({ properties: ["openFile"], filters: [{ name: "M Agent Project", extensions: ["magent"] }] });
  if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
  return openProjectFile(selected.filePaths[0]);
});

ipcMain.handle("project:open-path", async (_event, path: unknown) => {
  if (typeof path !== "string" || !path.trim()) throw new Error("工程文件路径无效。");
  return openProjectFile(path.trim());
});

ipcMain.handle("project:save", async (_event, payload: RendererProjectPayload) => {
  const project = rendererPayloadToProject(payload);
  const selected = await dialog.showSaveDialog({ defaultPath: `${project.title}.magent`, filters: [{ name: "M Agent Project", extensions: ["magent"] }] });
  if (selected.canceled || !selected.filePath) return { canceled: true };
  await saveProjectToFile(project, selected.filePath);
  return { canceled: false, filePath: selected.filePath };
});

ipcMain.handle("project:save-to", async (_event, payload: RendererProjectPayload, path: unknown) => {
  if (typeof path !== "string" || !path.trim()) throw new Error("工程文件路径无效。");
  const cleanPath = path.trim();
  if (!cleanPath.toLowerCase().endsWith(".magent")) throw new Error("仅支持保存为 .magent 工程文件。");
  if (!approvedSavePaths.has(cleanPath)) throw new Error("该路径未经用户确认，拒绝直接保存。");
  const project = rendererPayloadToProject(payload);
  await saveProjectToFile(project, cleanPath);
  return { canceled: false, filePath: cleanPath };
});

ipcMain.handle("projects:list-recent", () => listRecentProjects());

ipcMain.handle("window:create-project", (_event, intent: unknown) => {
  if (intent !== "new-project" && intent !== "open-project" && intent !== "import-midi") {
    throw new Error("窗口意图无效。");
  }
  createWindow(intent);
});

ipcMain.handle("shell:get-settings", () => getConfiguredShellSettings());
ipcMain.handle("shell:browse", async (event) => {
  const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  const options: OpenDialogOptions = {
    title: "选择 Shell 可执行文件",
    buttonLabel: "选择 Shell",
    properties: ["openFile"],
    ...(process.platform === "win32"
      ? { filters: [{ name: "Shell 可执行文件", extensions: ["exe"] }] }
      : {}),
  };
  const selected = owner
    ? await dialog.showOpenDialog(owner, options)
    : await dialog.showOpenDialog(options);
  if (selected.canceled || !selected.filePaths[0]) return { canceled: true };
  return { canceled: false, filePath: selected.filePaths[0] };
});
const activeShellChecks = new Set<number>();
ipcMain.handle("shell:check", async (event, path: unknown) => {
  const senderId = event.sender.id;
  if (activeShellChecks.has(senderId)) throw new Error("当前窗口已有 Shell 检测正在进行。");
  activeShellChecks.add(senderId);
  try {
    return await checkAndSaveConfiguredShell(path);
  } finally {
    activeShellChecks.delete(senderId);
  }
});

ipcMain.handle("settings:save-api-key", async (_event, key: unknown) => {
  await saveProviderApiKey("openai", key);
});
ipcMain.handle("settings:clear-api-key", async () => {
  clearApiKey();
  await clearProviderApiKey("openai");
});
ipcMain.handle("settings:has-api-key", async () => (
  hasApiKey() || Boolean(await getPiCredentialStore().read("openai"))
));
ipcMain.handle("environment:get-startup-report", () => getStartupEnvironmentReport());
ipcMain.handle("provider:save-api-key", async (_event, providerId: unknown, key: unknown) => {
  if (providerId !== "openai") throw new Error("不支持的 API Key 供应商。");
  await saveProviderApiKey(providerId, key);
  return getStartupEnvironmentReport();
});
ipcMain.handle("provider:clear-api-key", async (_event, providerId: unknown) => {
  if (providerId !== "openai") throw new Error("不支持的 API Key 供应商。");
  clearApiKey();
  await clearProviderApiKey(providerId);
  return getStartupEnvironmentReport();
});
const activeProviderLogins = new Map<number, AbortController>();
ipcMain.handle("provider:login-openai-codex", async (event) => {
  const senderId = event.sender.id;
  if (activeProviderLogins.has(senderId)) throw new Error("当前窗口已有供应商登录正在进行。");
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("登录等待超时，请重试。")), 5 * 60_000);
  const abortOnDestroyed = () => controller.abort();
  activeProviderLogins.set(senderId, controller);
  event.sender.once("destroyed", abortOnDestroyed);
  try {
    await loginOpenAICodex((url) => shell.openExternal(url), controller.signal);
    return getStartupEnvironmentReport();
  } finally {
    clearTimeout(timeout);
    event.sender.removeListener("destroyed", abortOnDestroyed);
    activeProviderLogins.delete(senderId);
  }
});
ipcMain.handle("provider:logout-openai-codex", async () => {
  await logoutOpenAICodex();
  return getStartupEnvironmentReport();
});
const activeAgentRuns = new Map<number, AbortController>();
ipcMain.handle("agent:run", async (event, payload: unknown) => {
  const senderId = event.sender.id;
  if (activeAgentRuns.has(senderId)) throw new Error("当前窗口已有 Agent 任务正在运行。");
  const controller = new AbortController();
  // 不设固定墙钟超时：长任务（Skill 嵌套编排）由用户按「取消」控制；
  // 成本由 token/轮次预算兜底，挂死由 agent:cancel 兜底。
  const abortOnDestroyed = () => controller.abort();
  activeAgentRuns.set(senderId, controller);
  event.sender.once("destroyed", abortOnDestroyed);
  try {
    return await runAgent(
      payload,
      await resolveAgentAuthentication(controller.signal),
      controller.signal,
      (update) => { if (!event.sender.isDestroyed()) event.sender.send("agent:live", update); },
    );
  } finally {
    event.sender.removeListener("destroyed", abortOnDestroyed);
    activeAgentRuns.delete(senderId);
  }
});

ipcMain.handle("agent:cancel", (event) => {
  activeAgentRuns.get(event.sender.id)?.abort(new Error("Agent 已取消。工程未发生修改。"));
});

ipcMain.handle("window:minimize", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.minimize();
});
ipcMain.handle("window:toggle-maximize", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
});
ipcMain.handle("window:close", (event) => {
  BrowserWindow.fromWebContents(event.sender)?.close();
});

ipcMain.handle("agent:list-skills", async () => {
  const skills = await loadAvailableSkills();
  return skills.map((skill) => ({ name: skill.name, description: skill.description }));
});

registerSubscriptionIpc();
registerUsageIpc();
registerInstrumentLibraryIpc();

app.whenReady().then(() => {
  installApplicationMenu();
  void (async () => {
    try {
      const legacyKey = getApiKey();
      if (legacyKey) {
        await migrateLegacyApiKey(legacyKey);
        clearApiKey();
      }
    } catch (error) {
      console.warn("旧版 API Key 迁移未完成：", error instanceof Error ? error.message : "未知错误");
    }
    try {
      await importPiCliCredentials();
    } catch (error) {
      console.warn("Pi 凭据导入未完成：", error instanceof Error ? error.message : "未知错误");
    }
  })().finally(() => createWindow());
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });

async function assertFileSize(filePath: string, maximumBytes: number, label: string): Promise<void> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error(`${label}路径不是普通文件。`);
  if (info.size > maximumBytes) throw new Error(`${label}超过允许的大小上限。`);
}

async function openProjectFile(filePath: string): Promise<{ canceled: false; filePath: string; project: MidiProject }> {
  await assertFileSize(filePath, MAX_PROJECT_FILE_BYTES, "工程文件");
  const project: unknown = JSON.parse(await readFile(filePath, "utf8"));
  assertProjectFile(project);
  recordRecentProject(filePath, project.title);
  approvedSavePaths.add(filePath);
  refreshNativeMenu();
  return { canceled: false, filePath, project };
}

async function saveProjectToFile(project: MidiProject, filePath: string): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  recordRecentProject(filePath, project.title);
  approvedSavePaths.add(filePath);
  refreshNativeMenu();
}

function refreshNativeMenu(): void {
  if (process.platform === "darwin") installApplicationMenu();
}

/**
 * 应用菜单被移除后，macOS 上 Cmd+C/V/X/A 等剪贴板快捷键会失效（Windows/Linux 由
 * Chromium 原生处理，不受影响）。这里在主进程补回等价快捷键，保持无菜单栏设计。
 */
function registerClipboardShortcuts(window: BrowserWindow): void {
  const useMeta = process.platform === "darwin";
  window.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || input.isAutoRepeat) return;
    const mod = useMeta ? input.meta : input.control;
    if (!mod || input.alt) return;
    const key = input.key.toLowerCase();
    if (key === "v") {
      event.preventDefault();
      window.webContents.paste();
    } else if (key === "c") {
      event.preventDefault();
      window.webContents.copy();
    } else if (key === "x") {
      event.preventDefault();
      window.webContents.cut();
    } else if (key === "a" && !input.shift) {
      event.preventDefault();
      window.webContents.selectAll();
    }
  });
}
