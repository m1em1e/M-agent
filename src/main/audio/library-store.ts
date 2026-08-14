import Store from "electron-store";
import type {
  InstrumentLibraryEntry,
  InstrumentLibrarySummary,
  InstrumentType,
  SoundFontPresetInfo,
} from "../../shared/instrument.js";
import { parseSf2Presets } from "../soundfont-parser.js";

interface LibraryStoreSchema {
  entries: InstrumentLibraryEntry[];
}

const MAX_ENTRIES = 256;

let store: Store<LibraryStoreSchema> | undefined;

function libraryStore(): Store<LibraryStoreSchema> {
  return store ??= new Store<LibraryStoreSchema>({ name: "instrument-library", defaults: { entries: [] } });
}

export function listLibraryEntries(): InstrumentLibrarySummary[] {
  return libraryStore()
    .get("entries")
    .map((entry) => ({
      id: entry.id,
      type: entry.type,
      path: entry.path,
      name: entry.name,
      enabled: entry.enabled,
      presetName: entry.presetName,
      presetCount: entry.presets?.length ?? 0,
      presets: entry.presets,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
    }));
}

export function getLibraryEntry(id: string): InstrumentLibraryEntry | undefined {
  return libraryStore().get("entries").find((entry) => entry.id === id);
}

export function resolveLibraryReference(
  reference: { libraryId: string; type: InstrumentType },
): InstrumentLibraryEntry | undefined {
  const entry = getLibraryEntry(reference.libraryId);
  if (!entry || !entry.enabled || entry.type !== reference.type) return undefined;
  return entry;
}

export async function addLibraryEntry(path: string, type: InstrumentType): Promise<InstrumentLibraryEntry> {
  const cleanPath = path.trim();
  if (!cleanPath) throw new Error("音源文件路径不能为空。");
  const entries = libraryStore().get("entries");
  if (entries.length >= MAX_ENTRIES) throw new Error("音源库条目数量超过上限。");
  if (entries.some((entry) => entry.path.toLowerCase() === cleanPath.toLowerCase())) {
    throw new Error("该音源文件已在音源库中。");
  }
  const now = Date.now();
  let presets: SoundFontPresetInfo[] | undefined;
  let presetName: string | undefined;
  if (type === "soundfont") {
    presets = await parseSf2Presets(cleanPath);
  } else if (type === "sfz") {
    presetName = sfzPresetName(cleanPath);
  } else {
    throw new Error(`不支持的音源类型：${type}`);
  }
  const entry: InstrumentLibraryEntry = {
    id: `${type}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    type,
    path: cleanPath,
    name: basename(cleanPath),
    enabled: true,
    presets,
    presetName,
    createdAt: now,
    updatedAt: now,
  };
  libraryStore().set("entries", [...entries, entry]);
  return entry;
}

export function updateLibraryEntry(
  id: string,
  patch: Partial<Pick<InstrumentLibraryEntry, "name" | "enabled">>,
): InstrumentLibraryEntry {
  const entries = libraryStore().get("entries");
  const index = entries.findIndex((entry) => entry.id === id);
  if (index < 0) throw new Error(`音源库不存在条目：${id}`);
  const updated = { ...entries[index], ...patch, updatedAt: Date.now() };
  const next = [...entries];
  next[index] = updated;
  libraryStore().set("entries", next);
  return updated;
}

export function removeLibraryEntry(id: string): void {
  libraryStore().set("entries", libraryStore().get("entries").filter((entry) => entry.id !== id));
}

export function sfzPresetName(path: string): string {
  return basename(path).replace(/\.sfz$/i, "");
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
