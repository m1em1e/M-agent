import { ipcMain, dialog, BrowserWindow } from "electron";
import { readFile } from "node:fs/promises";
import type { InstrumentType } from "../../shared/instrument.js";
import {
  addLibraryEntry,
  listLibraryEntries,
  removeLibraryEntry,
  updateLibraryEntry,
} from "./library-store.js";

const MAX_INSTRUMENT_READ_BYTES = 512 * 1024 * 1024;

export function registerInstrumentLibraryIpc(): void {
  ipcMain.handle("instrument-library:list", () => listLibraryEntries());

  ipcMain.handle("instrument-library:add", async (event, type: unknown, path?: unknown) => {
    const instrumentType = parseInstrumentType(type);
    let filePath = typeof path === "string" ? path : "";
    if (!filePath) {
      const owner = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const filters = instrumentType === "soundfont"
        ? [{ name: "SoundFont", extensions: ["sf2", "sf3"] }]
        : [{ name: "SFZ", extensions: ["sfz"] }];
      const selected = owner
        ? await dialog.showOpenDialog(owner, { properties: ["openFile"], filters })
        : await dialog.showOpenDialog({ properties: ["openFile"], filters });
      if (selected.canceled || !selected.filePaths[0]) return null;
      filePath = selected.filePaths[0];
    }
    return addLibraryEntry(filePath, instrumentType);
  });

  ipcMain.handle("instrument-library:update", (_event, id: unknown, patch: unknown) => {
    if (typeof id !== "string" || !id) throw new Error("音源 ID 无效。");
    return updateLibraryEntry(id, sanitizePatch(patch));
  });

  ipcMain.handle("instrument-library:remove", (_event, id: unknown) => {
    if (typeof id !== "string" || !id) throw new Error("音源 ID 无效。");
    removeLibraryEntry(id);
  });

  ipcMain.handle("instrument-library:read-file", async (_event, path: unknown) => {
    if (typeof path !== "string" || !path) throw new Error("音源文件路径无效。");
    const bytes = await readFile(path);
    if (bytes.byteLength > MAX_INSTRUMENT_READ_BYTES) throw new Error("音源文件超过大小上限。");
    // 通过 IPC 传输 ArrayBuffer（结构化克隆）。
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  });
}

function parseInstrumentType(value: unknown): InstrumentType {
  if (value === "soundfont" || value === "sfz") return value;
  throw new Error("音源类型无效。");
}

function sanitizePatch(value: unknown): Partial<{ name: string; enabled: boolean }> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("音源更新数据无效。");
  const patch = value as Record<string, unknown>;
  const result: Partial<{ name: string; enabled: boolean }> = {};
  if (patch.name !== undefined) {
    if (typeof patch.name !== "string" || !patch.name.trim()) throw new Error("音源名称无效。");
    result.name = patch.name.trim();
  }
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== "boolean") throw new Error("音源启用状态无效。");
    result.enabled = patch.enabled;
  }
  return result;
}
