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
  createdAt: number;
  updatedAt: number;
}

export interface SoundFontPresetInfo {
  bank: number;
  program: number;
  name: string;
}

/** Renderer 可见的库条目摘要。 */
export type InstrumentLibrarySummary = Omit<InstrumentLibraryEntry, "presets"> & {
  presetCount: number;
  presets?: SoundFontPresetInfo[];
};

/** 主进程扫描/解析音源文件后的结果。 */
export interface InstrumentScanResult {
  id: string;
  name: string;
  type: InstrumentType;
  presets?: SoundFontPresetInfo[];
  presetName?: string;
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
