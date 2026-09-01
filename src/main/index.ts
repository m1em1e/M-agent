import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type OpenDialogOptions } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFile, stat, writeFile } from "node:fs/promises";
import { exportMidi, importMidi } from "../core/midi/index.js";
import type { RendererProjectPayload } from "../shared/bridge.js";
import type { MidiProject } from "../shared/midi.js";
import { assertProjectFile, rendererPayloadToProject } from "./project-adapter.js";
import { clearLegacyApiKey, readLegacyApiKey } from "./secure-settings.js";
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
import { checkAndSaveConfiguredShell, getConfiguredShellSettings } from "./shell-service.js";
import { registerSubscriptionIpc } from "./subscription-ipc.js";
import { registerUsageIpc } from "./usage-ipc.js";
import { registerInstrumentLibraryIpc } from "./audio/library-ipc.js";
import { listSkillMeta } from "./skill-loader.js";
import { listRecentProjects, recordRecentProject, removeRecentProject } from "./recent-projects.js";
import { APP_MENU_GROUPS, recentProjectLabel, type AppMenuItem } from "../shared/menu.js";
import { computeUiZoomFactor } from "./ui-zoom.js";
import { installSystemProxyFetch } from "./net-fetch.js";
import type { ProjectOpenIntent } from "../shared/bridge.js";

/** 用户在本会话中经对话框/打开确认过的可写工程路径（供「保存项目」免对话框直写）。 */
const approvedSavePaths = new Set<string>();
/** 各窗口「允许关闭」放行标记：确认未保存改动后置真，供 close 事件放行。 */
const allowCloseWindows = new WeakMap<BrowserWindow, boolean>();

const currentDir = dirname(fileURLToPath(import.meta.url));
const isDevelopment = Boolean(process.env.VITE_DEV_SERVER_URL);
const MAX_MIDI_FILE_BYTES = 64 * 1024 * 1024;
const MAX_PROJECT_FILE_BYTES = 32 * 1024 * 1024;
/** 音频导出字节上限（WAV 最大约 30 分钟 @48kHz 立体声 16bit）。 */
const MAX_AUDIO_EXPORT_BYTES = 512 * 1024 * 1024;
const ZOOM_APPLY_THRESHOLD = 0.01;
/** 打开工程文件的访问超时：避免已卸载/不可达路径（网络盘等）挂起阻塞启动。 */
const FILE_ACCESS_TIMEOUT_MS = 3000;
/** 工程文件不存在或不可访问时的可辨识错误标记（渲染端据此弹窗引导）。 */
const PROJECT_MISSING_MARKER = "PROJECT_MISSING";

// 让主进程的模型请求走系统代理（见 net-fetch.ts）。必须在任何请求发出前安装。
installSystemProxyFetch();

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
          ? recent.slice(0, 10).map((entry) => ({
              label: recentProjectLabel(entry),
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
    minWidth: 1000,
    minHeight: 640,
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
  // 未保存改动确认：窗口 close（系统关闭按钮/Alt+F4/Cmd+Q 等）时先询问渲染端。
  // 渲染端确认后经 window:confirm-close 放行；未放行则阻止关闭。
  window.on("close", (event) => {
    if (allowCloseWindows.get(window)) return;
    event.preventDefault();
    if (!window.webContents.isDestroyed()) window.webContents.send("app:before-close");
  });
  // macOS 已有原生菜单的编辑角色处理剪贴板快捷键；其余平台补回。
  if (process.platform !== "darwin") registerClipboardShortcuts(window);
  window.webContents.on("will-navigate", (event, url) => {
    const allowed = isDevelopment
      ? new URL(url).origin === new URL(process.env.VITE_DEV_SERVER_URL!).origin
      : url === productionUrl;
    if (!allowed) event.preventDefault();
  });
  const applyUiZoom = () => {
    const { width, height } = window.getBounds();
    const zoom = computeUiZoomFactor(width, height);
    if (Math.abs(zoom - window.webContents.getZoomFactor()) < ZOOM_APPLY_THRESHOLD) return;
    window.webContents.setZoomFactor(zoom);
  };
  applyUiZoom();
  window.on("resize", applyUiZoom);
  window.webContents.on("did-finish-load", applyUiZoom);
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

ipcMain.handle("midi:export", async (_event, payload: RendererProjectPayload, defaultName: unknown) => {
  const project = rendererPayloadToProject(payload);
  const base = typeof defaultName === "string" && defaultName.trim() ? defaultName.trim() : project.title;
  const selected = await dialog.showSaveDialog({ defaultPath: `${sanitizeExportName(base)}.mid`, filters: [{ name: "MIDI", extensions: ["mid"] }] });
  if (selected.canceled || !selected.filePath) return { canceled: true };
  await writeFile(selected.filePath, exportMidi(project, { format: 1 }));
  return { canceled: false, filePath: selected.filePath };
});

ipcMain.handle("audio:export", async (_event, payload: unknown) => {
  const request = readAudioExportPayload(payload);
  const extension = request.format === "ogg" ? "ogg" : "wav";
  const defaultPath = `${sanitizeExportName(request.defaultName)}.${extension}`;
  const selected = await dialog.showSaveDialog({ defaultPath, filters: [{ name: request.format === "ogg" ? "Ogg Vorbis 音频" : "WAV 音频", extensions: [extension] }] });
  if (selected.canceled || !selected.filePath) return { canceled: true };
  if (request.bytes.byteLength > MAX_AUDIO_EXPORT_BYTES) throw new Error("导出音频文件超过允许的大小上限。");
  await writeFile(selected.filePath, Buffer.from(request.bytes));
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

ipcMain.handle("project:save", async (_event, payload: RendererProjectPayload, defaultName: unknown) => {
  const project = rendererPayloadToProject(payload);
  const base = typeof defaultName === "string" && defaultName.trim() ? defaultName.trim() : project.title;
  const selected = await dialog.showSaveDialog({ defaultPath: `${sanitizeExportName(base)}.magent`, filters: [{ name: "M Agent Project", extensions: ["magent"] }] });
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

ipcMain.handle("environment:get-startup-report", () => getStartupEnvironmentReport());
ipcMain.handle("provider:save-api-key", async (_event, providerId: unknown, key: unknown) => {
  if (providerId !== "openai") throw new Error("不支持的 API Key 供应商。");
  await saveProviderApiKey(providerId, key);
  return getStartupEnvironmentReport();
});
ipcMain.handle("provider:clear-api-key", async (_event, providerId: unknown) => {
  if (providerId !== "openai") throw new Error("不支持的 API Key 供应商。");
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
    // 惰性加载 agent-service：内置 Pi 包缺失时不至于在启动阶段崩溃，
    // 而是返回可辨识错误（红色「内置 Pi 内核」提示可正常渲染）。
    let runAgent: typeof import("./agent-service.js").runAgent;
    try {
      ({ runAgent } = await import("./agent-service.js"));
    } catch (error) {
      throw new Error("内置 Pi 内核不可用，请重新安装应用。");
    }
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

/** 渲染端确认未保存改动后，放行并真正关闭窗口。 */
ipcMain.handle("window:confirm-close", (event) => {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (window) {
    allowCloseWindows.set(window, true);
    window.close();
  }
});

ipcMain.handle("agent:list-skills", async () => {
  return listSkillMeta();
});

registerSubscriptionIpc();
registerUsageIpc();
registerInstrumentLibraryIpc();

app.whenReady().then(() => {
  installApplicationMenu();
  // 安全：默认拒绝任何 Web 权限请求（摄像头/麦克风/通知/地理等均不需要）；
  // 明确需要的权限可在此白名单放行。
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  void (async () => {
    try {
      const legacyKey = readLegacyApiKey();
      if (legacyKey) {
        await migrateLegacyApiKey(legacyKey);
        clearLegacyApiKey();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface AudioExportPayload {
  format: "wav" | "ogg";
  bytes: Uint8Array;
  defaultName: string;
}

function readAudioExportPayload(payload: unknown): AudioExportPayload {
  if (!isRecord(payload) || typeof payload.format !== "string" || !(payload.format === "wav" || payload.format === "ogg")) {
    throw new Error("音频导出参数无效。");
  }
  if (typeof payload.defaultName !== "string" || !payload.defaultName.trim()) {
    throw new Error("音频导出缺少默认文件名。");
  }
  const bytes = bytesOf(payload.bytes);
  if (bytes === null) {
    throw new Error("音频导出缺少音频字节。");
  }
  return { format: payload.format, bytes, defaultName: payload.defaultName };
}

function bytesOf(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

function sanitizeExportName(name: string): string {
  const cleaned = name.trim().replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").slice(0, 120);
  return cleaned || "audio";
}

async function openProjectFile(filePath: string): Promise<{ canceled: false; filePath: string; project: MidiProject }> {
  try {
    const project: unknown = JSON.parse(await withTimeout(readProjectFile(filePath), FILE_ACCESS_TIMEOUT_MS));
    assertProjectFile(project);
    recordRecentProject(filePath, project.title);
    approvedSavePaths.add(filePath);
    refreshNativeMenu();
    return { canceled: false, filePath, project };
  } catch (error) {
    // 文件不存在（ENOENT）或访问超时（网络盘/已卸载盘挂起）视为「工程缺失」：
    // 自动从最近列表移除，避免每次启动重试与卡顿；并抛可辨识错误供渲染端弹窗引导。
    if (isProjectMissingError(error)) {
      removeRecentProject(filePath);
      throw new Error(PROJECT_MISSING_MARKER);
    }
    throw error;
  }
}

async function readProjectFile(filePath: string): Promise<string> {
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("工程文件路径不是普通文件。");
  if (info.size > MAX_PROJECT_FILE_BYTES) throw new Error("工程文件超过允许的大小上限。");
  return readFile(filePath, "utf8");
}

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(PROJECT_MISSING_MARKER)), milliseconds);
    }),
  ]).finally(() => { if (timer !== undefined) clearTimeout(timer); });
}

function isProjectMissingError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return (error as NodeJS.ErrnoException).code === "ENOENT" || error.message === PROJECT_MISSING_MARKER;
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
