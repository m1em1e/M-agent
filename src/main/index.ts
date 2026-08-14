import { app, BrowserWindow, dialog, ipcMain, Menu, shell, type OpenDialogOptions } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, stat, writeFile } from "node:fs/promises";
import { exportMidi, importMidi } from "../core/midi/index.js";
import type { RendererProjectPayload } from "../shared/bridge.js";
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
function installApplicationMenu(): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const sendAction = (action: string) => {
    BrowserWindow.getFocusedWindow()?.webContents.send("menu:action", action);
  };
  const item = (label: string, action: string, accelerator?: string): Electron.MenuItemConstructorOptions => ({
    label,
    ...(accelerator ? { accelerator } : {}),
    click: () => sendAction(action),
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
    {
      label: "文件",
      submenu: [
        item("导入 MIDI", "file-open-midi", "CmdOrCtrl+O"),
        item("打开工程", "file-open-project", "CmdOrCtrl+Shift+O"),
        item("保存工程", "file-save-project", "CmdOrCtrl+S"),
        item("导出 MIDI", "file-export-midi", "CmdOrCtrl+Shift+S"),
        { type: "separator" },
        item("关闭窗口", "window-close", "CmdOrCtrl+W"),
      ],
    },
    {
      label: "编辑",
      submenu: [
        item("撤销", "edit-undo", "CmdOrCtrl+Z"),
        item("重做", "edit-redo", "CmdOrCtrl+Shift+Z"),
        { type: "separator" },
        { role: "cut", label: "剪切" },
        { role: "copy", label: "拷贝" },
        { role: "paste", label: "粘贴" },
        { role: "selectAll", label: "全选" },
      ],
    },
    {
      label: "视图",
      submenu: [
        item("重新检测运行环境", "view-check-environment"),
        item("设置", "view-settings", "CmdOrCtrl+,"),
        { type: "separator" },
        { role: "togglefullscreen", label: "切换全屏" },
      ],
    },
    {
      label: "窗口",
      submenu: [
        { role: "minimize", label: "最小化" },
        { role: "zoom", label: "缩放" },
        { type: "separator" },
        { role: "front", label: "前置全部窗口" },
      ],
    },
    {
      label: "音源",
      submenu: [item("音源库管理", "instruments-settings")],
    },
    {
      label: "插件",
      submenu: [item("插件管理", "plugins-settings")],
    },
    {
      label: "帮助",
      submenu: [
        item("关于 M Agent", "help-about"),
        item("设置", "help-settings"),
      ],
    },
  ]));
}

function createWindow(): void {
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
  const filePath = selected.filePaths[0];
  await assertFileSize(filePath, MAX_PROJECT_FILE_BYTES, "工程文件");
  const project: unknown = JSON.parse(await readFile(filePath, "utf8"));
  assertProjectFile(project);
  return { canceled: false, filePath, project };
});

ipcMain.handle("project:save", async (_event, payload: RendererProjectPayload) => {
  const project = rendererPayloadToProject(payload);
  const selected = await dialog.showSaveDialog({ defaultPath: `${project.title}.magent`, filters: [{ name: "M Agent Project", extensions: ["magent"] }] });
  if (selected.canceled || !selected.filePath) return { canceled: true };
  await writeFile(selected.filePath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  return { canceled: false, filePath: selected.filePath };
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
  const timeout = setTimeout(() => controller.abort(), 60_000);
  const abortOnDestroyed = () => controller.abort();
  activeAgentRuns.set(senderId, controller);
  event.sender.once("destroyed", abortOnDestroyed);
  try {
    return await runAgent(payload, await resolveAgentAuthentication(controller.signal), controller.signal);
  } finally {
    clearTimeout(timeout);
    event.sender.removeListener("destroyed", abortOnDestroyed);
    activeAgentRuns.delete(senderId);
  }
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
