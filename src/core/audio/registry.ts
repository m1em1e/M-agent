import type {
  InstrumentLibraryEntry,
  InstrumentLibrarySummary,
  InstrumentReference,
  InstrumentScanResult,
  InstrumentType,
} from "../../shared/instrument.js";
import { instrumentReferenceKey } from "../../shared/instrument.js";

export interface RegistryDeps {
  /** 解析音源文件，返回其元信息与 preset 清单。 */
  scan(path: string): Promise<InstrumentScanResult>;
  now?(): number;
  newId?(): string;
}

const DEFAULT_MAX_ENTRIES = 256;

/**
 * 全局音源库的纯逻辑实现：增删改查、扫描、启用/禁用、搜索。
 * 不依赖 Electron / 音频引擎，可单测。
 */
export class InstrumentRegistry {
  private readonly entries = new Map<string, InstrumentLibraryEntry>();

  constructor(private readonly deps: RegistryDeps) {}

  list(): InstrumentLibrarySummary[] {
    return [...this.entries.values()]
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((entry) => ({
        id: entry.id,
        type: entry.type,
        path: entry.path,
        name: entry.name,
        enabled: entry.enabled,
        presetName: entry.presetName,
        presetCount: entry.presets?.length ?? 0,
        sfzRegions: entry.sfzRegions,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
      }));
  }

  get(id: string): InstrumentLibraryEntry | undefined {
    return this.entries.get(id);
  }

  search(type?: InstrumentType, query?: string): InstrumentLibrarySummary[] {
    const q = query?.trim().toLowerCase();
    return this.list().filter((entry) => {
      if (type && entry.type !== type) return false;
      if (!q) return true;
      return entry.name.toLowerCase().includes(q) || entry.path.toLowerCase().includes(q);
    });
  }

  async add(path: string, type: InstrumentType): Promise<InstrumentLibraryEntry> {
    const scan = await this.deps.scan(path);
    const now = this.deps.now?.() ?? Date.now();
    const id = this.deps.newId?.() ?? `${type}-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: InstrumentLibraryEntry = {
      id,
      type,
      path,
      name: scan.name || basename(path),
      enabled: true,
      presets: type === "soundfont" ? scan.presets : undefined,
      presetName: type === "sfz" ? scan.presetName : undefined,
      sfzRegions: type === "sfz" ? scan.sfzRegions : undefined,
      createdAt: now,
      updatedAt: now,
    };
    if (this.entries.size >= DEFAULT_MAX_ENTRIES && !this.entries.has(id)) {
      throw new Error("音源库条目数量超过上限。");
    }
    this.entries.set(id, entry);
    return entry;
  }

  update(id: string, patch: Partial<Pick<InstrumentLibraryEntry, "name" | "enabled">>): InstrumentLibraryEntry {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`音源库不存在条目：${id}`);
    const updated = { ...entry, ...patch, updatedAt: this.deps.now?.() ?? Date.now() };
    this.entries.set(id, updated);
    return updated;
  }

  remove(id: string): boolean {
    return this.entries.delete(id);
  }

  /**
   * 校验并解析一个 Track 上的 InstrumentReference。
   * 若条目不存在或禁用，返回 undefined。
   */
  resolve(reference: InstrumentReference): InstrumentLibraryEntry | undefined {
    const entry = this.entries.get(reference.libraryId);
    if (!entry || !entry.enabled) return undefined;
    return entry;
  }

  /** 生成引用对应的稳定键，用于缓存引擎实例。 */
  referenceKey(reference: InstrumentReference): string {
    return instrumentReferenceKey(reference);
  }
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
