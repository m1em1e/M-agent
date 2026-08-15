import { app } from "electron";
import Store from "electron-store";
import { createWriteStream } from "node:fs";
import { cp, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type {
  InstrumentLibrarySummary,
  InstrumentType,
  ProjectInstrumentSnapshot,
  SfzRegion,
  SoundFontPresetInfo,
} from "../../shared/instrument.js";
import { inferInstrumentTypeFromPath } from "../../shared/instrument.js";
import { parseSf2Presets, parseSfz } from "../soundfont-parser.js";
import { collectInstrumentFiles, stableId } from "./system-scan.js";

/**
 * 系统级音源库：托管目录模型。
 * 条目由配置目录（默认 Documents/m-agent/Instruments）下的 .sf2/.sf3/.sfz 递归扫描生成；
 * 解析结果按「路径 + mtime」缓存，禁用状态按路径持久化。
 */

interface ScanCacheEntry {
  mtime: number;
  type: InstrumentType;
  name: string;
  presets?: SoundFontPresetInfo[];
  presetName?: string;
  sfzRegions?: SfzRegion[];
}

interface LibraryStoreSchema {
  systemPath?: string;
  scanCache: Record<string, ScanCacheEntry>;
  disabledPaths: string[];
}

const MAX_SCANNED_ENTRIES = 256;

/** 推荐音源（GeneralUser GS，GM/GS 兼容，约 32MB）。 */
const RECOMMENDED_SF2_URL = "https://raw.githubusercontent.com/mrbumpy409/GeneralUser-GS/main/GeneralUser-GS.sf2";
const RECOMMENDED_SF2_FILE = "GeneralUser-GS.sf2";

/**
 * 下载推荐音源到系统音源库目录（若已存在则跳过下载）。
 * 仅下载音源文件本体，不解析；文件落入目录后由下次扫描自动登记。
 */
export async function downloadRecommendedSoundfont(): Promise<{
  ok: boolean;
  path?: string;
  downloaded: boolean;
  error?: string;
}> {
  const dir = await ensureSystemInstrumentDirectory();
  const filePath = join(dir, RECOMMENDED_SF2_FILE);
  try {
    await stat(filePath);
    return { ok: true, path: filePath, downloaded: false };
  } catch {
    // 不存在则下载。
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("下载超时，请检查网络。")), 10 * 60_000);
  try {
    const response = await fetch(RECOMMENDED_SF2_URL, { signal: controller.signal });
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status} ${response.statusText}`);
    if (!response.body) throw new Error("下载失败：响应无内容。");
    // 流式写入，避免大文件全部驻留内存。
    const output = createWriteStream(filePath);
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value && !output.write(value)) {
        await new Promise<void>((resolve) => output.once("drain", resolve));
      }
    }
    await new Promise<void>((resolve, reject) => {
      output.end((error?: Error | null) => (error ? reject(error) : resolve()));
    });
    const info = await stat(filePath);
    if (info.size < 1_024) {
      await rm(filePath, { force: true });
      throw new Error("下载内容异常（文件过小）。");
    }
    return { ok: true, path: filePath, downloaded: true };
  } catch (error) {
    await rm(filePath, { force: true });
    return { ok: false, downloaded: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
  }
}

let store: Store<LibraryStoreSchema> | undefined;

function libraryStore(): Store<LibraryStoreSchema> {
  return store ??= new Store<LibraryStoreSchema>({
    name: "instrument-library",
    defaults: { scanCache: {}, disabledPaths: [] },
  });
}

export function getSystemInstrumentPath(): string {
  return libraryStore().get("systemPath") ?? defaultSystemPath();
}

export function defaultSystemPath(): string {
  return join(app.getPath("documents"), "m-agent", "Instruments");
}

export async function ensureSystemInstrumentDirectory(): Promise<string> {
  const dir = getSystemInstrumentPath();
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 解析单个音源文件为项目级快照（校验扩展名与大小）。 */
export async function bindInstrumentToProject(path: string): Promise<ProjectInstrumentSnapshot> {
  const parsed = await parseInstrumentFile(path);
  return {
    type: parsed.type,
    path,
    name: parsed.name,
    presets: parsed.presets,
    presetName: parsed.presetName,
    sfzRegions: parsed.sfzRegions,
  };
}

/** 扫描系统目录并返回全部条目（含解析缓存与禁用状态）。 */
export async function listSystemInstruments(): Promise<InstrumentLibrarySummary[]> {
  const dir = getSystemInstrumentPath();
  const cache = { ...libraryStore().get("scanCache") };
  let files: string[];
  try {
    files = await collectInstrumentFiles(dir);
  } catch {
    return [];
  }
  const present = new Set(files);
  const summaries: InstrumentLibrarySummary[] = [];
  for (const file of files) {
    const cached = cache[file];
    let parsed: Omit<ScanCacheEntry, "mtime"> | undefined = cached;
    let mtimeMs = cached?.mtime ?? 0;
    if (cached === undefined) {
      try {
        const info = await stat(file);
        mtimeMs = info.mtimeMs;
      } catch {
        continue;
      }
    }
    if (cached === undefined || cached.mtime !== mtimeMs) {
      try {
        parsed = await parseInstrumentFile(file);
        cache[file] = { ...parsed, mtime: mtimeMs };
      } catch {
        continue;
      }
    }
    if (!parsed) continue;
    const disabled = libraryStore().get("disabledPaths").includes(file);
    summaries.push(toSummary(parsed, file, disabled));
    if (summaries.length >= MAX_SCANNED_ENTRIES) break;
  }
  // 清理已不存在的缓存条目。
  for (const path of Object.keys(cache)) {
    if (!present.has(path)) delete cache[path];
  }
  libraryStore().set("scanCache", cache);
  summaries.sort((a, b) => a.name.localeCompare(b.name));
  return summaries;
}

/** 修改系统级目录；migrate=true 时把原目录内容迁移到新目录。 */
export async function setSystemInstrumentPath(path: string, migrate: boolean): Promise<{ path: string; migrated: boolean }> {
  const clean = path.trim();
  if (!clean) throw new Error("系统级音源目录不能为空。");
  if (clean.length > 1_024) throw new Error("系统级音源目录路径过长。");
  const previous = getSystemInstrumentPath();
  const next = clean === previous ? previous : clean;
  if (migrate && next !== previous) {
    let previousExists = false;
    try {
      await stat(previous);
      previousExists = true;
    } catch {
      previousExists = false;
    }
    if (previousExists) {
      await cp(previous, next, { recursive: true });
      await rm(previous, { recursive: true, force: true });
    }
    libraryStore().set("scanCache", {});
    libraryStore().set("disabledPaths", []);
  }
  await mkdir(next, { recursive: true });
  libraryStore().set("systemPath", next);
  return { path: next, migrated: migrate && next !== previous };
}

/** 设置系统级音源条目启用状态（移除 = 仅禁用）。 */
export async function setInstrumentEnabled(path: string, enabled: boolean): Promise<InstrumentLibrarySummary[]> {
  const disabled = new Set(libraryStore().get("disabledPaths"));
  if (enabled) disabled.delete(path);
  else disabled.add(path);
  libraryStore().set("disabledPaths", [...disabled]);
  return listSystemInstruments();
}

async function parseInstrumentFile(path: string): Promise<Omit<ScanCacheEntry, "mtime">> {
  const type = inferInstrumentTypeFromPath(path);
  if (!type) throw new Error("不支持的音源文件类型，仅支持 .sf2 / .sf3 / .sfz。");
  if (type === "soundfont") {
    const presets = await parseSf2Presets(path);
    return { type, name: basename(path), presets };
  }
  const parsed = await parseSfz(path);
  return { type, name: basename(path), presetName: parsed.presetName, sfzRegions: parsed.regions };
}

function toSummary(parsed: Omit<ScanCacheEntry, "mtime">, path: string, disabled: boolean): InstrumentLibrarySummary {
  return {
    id: stableId(path),
    type: parsed.type,
    path,
    name: parsed.name,
    enabled: !disabled,
    presetName: parsed.presetName,
    presetCount: parsed.presets?.length ?? 0,
    presets: parsed.presets,
    sfzRegions: parsed.sfzRegions,
    createdAt: 0,
    updatedAt: 0,
  };
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
