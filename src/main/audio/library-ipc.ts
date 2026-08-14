import { ipcMain, dialog, shell, BrowserWindow } from "electron";
import { readFile } from "node:fs/promises";
import type { ProjectInstrumentSnapshot } from "../../shared/instrument.js";
import {
  bindInstrumentToProject,
  ensureSystemInstrumentDirectory,
  getSystemInstrumentPath,
  listSystemInstruments,
  setInstrumentEnabled,
  setSystemInstrumentPath,
} from "./library-store.js";

const MAX_INSTRUMENT_READ_BYTES = 512 * 1024 * 1024;
const INSTRUMENT_FILTERS = [{ name: "音源文件", extensions: ["sf2", "sf3", "sfz"] }];

export function registerInstrumentLibraryIpc(): void {
  ipcMain.handle("instrument-library:list", () => listSystemInstruments());

  ipcMain.handle("instrument-library:pick-files", async (event): Promise<string[]> => {
    const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
    const selected = owner
      ? await dialog.showOpenDialog(owner, { properties: ["openFile", "multiSelections"], filters: INSTRUMENT_FILTERS })
      : await dialog.showOpenDialog({ properties: ["openFile", "multiSelections"], filters: INSTRUMENT_FILTERS });
    return selected.canceled ? [] : selected.filePaths;
  });

  ipcMain.handle("instrument-library:bind-instrument", async (_event, path: unknown): Promise<ProjectInstrumentSnapshot> => {
    const clean = assertPath(path);
    return bindInstrumentToProject(clean);
  });

  ipcMain.handle("instrument-library:get-system-path", () => getSystemInstrumentPath());

  ipcMain.handle("instrument-library:set-system-path", async (_event, path: unknown, migrate: unknown) => {
    const clean = assertPath(path);
    if (typeof migrate !== "boolean") throw new Error("迁移标志无效。");
    return setSystemInstrumentPath(clean, migrate);
  });

  ipcMain.handle("instrument-library:open-system-folder", async () => {
    const dir = await ensureSystemInstrumentDirectory();
    const result = await shell.openPath(dir);
    return { ok: result === "", error: result === "" ? undefined : result };
  });

  ipcMain.handle("instrument-library:set-enabled", async (_event, path: unknown, enabled: unknown) => {
    const clean = assertPath(path);
    if (typeof enabled !== "boolean") throw new Error("启用状态无效。");
    return setInstrumentEnabled(clean, enabled);
  });

  ipcMain.handle("instrument-library:read-file", async (_event, path: unknown) => {
    const clean = assertPath(path);
    const bytes = await readFile(clean);
    if (bytes.byteLength > MAX_INSTRUMENT_READ_BYTES) throw new Error("音源文件超过大小上限。");
    // 通过 IPC 传输 ArrayBuffer（结构化克隆）。
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  });
}

function assertPath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("音源文件路径无效。");
  const clean = value.trim();
  if (clean.length > 1_024) throw new Error("音源文件路径过长。");
  return clean;
}
