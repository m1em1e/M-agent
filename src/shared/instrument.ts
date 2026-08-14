/**
 * 跨进程音源契约。MIDI 层只依赖这些可序列化的引用，不依赖具体音频引擎。
 */

export type InstrumentType = "soundfont" | "sfz";

/** MIDI Track 上保存的可序列化音源引用。 */
export type InstrumentReference =
  | {
      type: "soundfont";
      libraryId: string;
      bank: number;
      program: number;
    }
  | {
      type: "sfz";
      libraryId: string;
      presetId?: string;
    };

/** 音源库中的一条音源（全局库条目）。 */
export interface InstrumentLibraryEntry {
  id: string;
  type: InstrumentType;
  /** 音源文件路径（.sf2/.sf3/.sfz）。 */
  path: string;
  name: string;
  enabled: boolean;
  /** SoundFont：解析出的 bank/program → 音色名 映射（仅 soundfont 类型）。 */
  presets?: SoundFontPresetInfo[];
  /** SFZ：主 preset 名称（可选）。 */
  presetName?: string;
  /** SFZ：解析出的采样区域映射（仅 sfz 类型）。 */
  sfzRegions?: SfzRegion[];
  createdAt: number;
  updatedAt: number;
}

export interface SoundFontPresetInfo {
  bank: number;
  program: number;
  name: string;
}

/**
 * 单个 SFZ <region> 的解析结果。samplePath 为相对 .sfz 所在目录解析后的绝对路径；
 * 各键区/力度区默认值遵循 SFZ 规范（lokey=0/hikey=127/vel 0-127/keyCenter=60）。
 */
export interface SfzRegion {
  /** 采样文件绝对路径。 */
  samplePath: string;
  /** 最低适用音符。 */
  lokey: number;
  /** 最高适用音符。 */
  hikey: number;
  /** 最低适用力度。 */
  lovel: number;
  /** 最高适用力度。 */
  hivel: number;
  /** 采样基音（pitch_keycenter）。 */
  keyCenter: number;
  /** 音高微调（cents，SFZ 的 tuning）。 */
  tuning: number;
  /** 音量（dB）。 */
  volume: number;
  /** 声像（-100 到 100）。 */
  pan: number;
  /** 循环模式（SFZ 的 loop_mode）。 */
  loopMode?: "one_shot" | "continuous" | "sustain";
  /** 循环起始（sample 帧）。 */
  loopStart?: number;
  /** 循环结束（sample 帧）。 */
  loopEnd?: number;
  /** 攻击时间（秒）。 */
  attack?: number;
  /** 释放时间（秒）。 */
  release?: number;
}

/** Renderer 可见的库条目摘要。 */
export type InstrumentLibrarySummary = Omit<InstrumentLibraryEntry, "presets"> & {
  presetCount: number;
  presets?: SoundFontPresetInfo[];
};

/**
 * 项目级音源条目（随工程保存）。id 为工程作用域内的稳定标识，
 * 对应轨道 InstrumentReference.libraryId；path 为绝对路径快照。
 */
export interface ProjectInstrument {
  id: string;
  type: InstrumentType;
  path: string;
  name?: string;
  /** SoundFont 完整快照。 */
  presets?: SoundFontPresetInfo[];
  /** SFZ 主 preset 名称。 */
  presetName?: string;
  /** SFZ 采样区域完整快照。 */
  sfzRegions?: SfzRegion[];
}

/** 主进程解析单文件后返回的项目级音源快照（不含工程作用域 id）。 */
export type ProjectInstrumentSnapshot = Omit<ProjectInstrument, "id">;

/**
 * 保存时自动快照轨道引用的音源（工程级优先，系统级按完整元数据快照），按 id 去重。
 * 无引用的音源或无法解析的引用会被跳过。
 */
export function buildProjectInstruments(
  tracks: ReadonlyArray<{ instrument?: InstrumentReference }>,
  systemLibrary: ReadonlyArray<InstrumentLibrarySummary>,
  projectLibrary: ReadonlyArray<ProjectInstrument>,
): ProjectInstrument[] | undefined {
  const used = new Map<string, ProjectInstrument>();
  for (const track of tracks) {
    const reference = track.instrument;
    if (!reference) continue;
    if (used.has(reference.libraryId)) continue;
    const projectEntry = projectLibrary.find((entry) => entry.id === reference.libraryId);
    if (projectEntry) {
      used.set(reference.libraryId, { ...projectEntry });
      continue;
    }
    const systemEntry = systemLibrary.find((entry) => entry.id === reference.libraryId);
    if (systemEntry) {
      used.set(reference.libraryId, {
        id: systemEntry.id,
        type: systemEntry.type,
        path: systemEntry.path,
        name: systemEntry.name,
        presets: systemEntry.presets,
        presetName: systemEntry.presetName,
        sfzRegions: systemEntry.sfzRegions,
      });
    }
  }
  return used.size > 0 ? [...used.values()] : undefined;
}

/** 主进程扫描/解析音源文件后的结果。 */
export interface InstrumentScanResult {
  id: string;
  name: string;
  type: InstrumentType;
  presets?: SoundFontPresetInfo[];
  presetName?: string;
  sfzRegions?: SfzRegion[];
}

export function instrumentReferenceLabel(reference: InstrumentReference | undefined, entryName?: string): string {
  if (!reference) return "默认（振荡器）";
  if (reference.type === "soundfont") {
    return entryName ?? `SoundFont #${reference.libraryId}`;
  }
  return entryName ?? `SFZ #${reference.libraryId}`;
}

export function instrumentReferenceKey(reference: InstrumentReference): string {
  if (reference.type === "soundfont") {
    return `soundfont:${reference.libraryId}:${reference.bank}:${reference.program}`;
  }
  return `sfz:${reference.libraryId}:${reference.presetId ?? ""}`;
}

/** 按文件扩展名推断音源类型；无法识别时返回 undefined。 */
export function inferInstrumentTypeFromPath(path: string): InstrumentType | undefined {
  const lower = path.toLowerCase();
  if (lower.endsWith(".sf2") || lower.endsWith(".sf3")) return "soundfont";
  if (lower.endsWith(".sfz")) return "sfz";
  return undefined;
}
