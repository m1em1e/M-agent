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
  /** 衰减时间（秒）。 */
  decay?: number;
  /** 延音电平（0–100 百分比，相对峰值）。 */
  sustain?: number;
  /** 释放时间（秒）。 */
  release?: number;
  /** 保持时间（秒）。 */
  hold?: number;
  /** 采样起始截取（sample 帧）。 */
  offset?: number;
  /** 采样结束截取（sample 帧）。 */
  end?: number;
  /** 力度对音量的调制深度（0–100%，默认 100=力度完全决定）。 */
  ampVelTrack?: number;
  /** 触发延迟（秒）。 */
  delay?: number;
  /** 音高键跟随比例（0–100%，100=随键完全移调，0=固定键高）。 */
  keytrack?: number;
  /** 音高偏移（半音）。 */
  pitchOffset?: number;
  /** 滤波器类型。 */
  filterType?: "lowpass" | "highpass" | "bandpass" | "bandreject";
  /** 滤波器截止频率（Hz）。 */
  cutoffHz?: number;
  /** 滤波器 Q 值（resonance）。 */
  resonanceQ?: number;
  /** 分组轮换变体总数（seq_length）。 */
  seqLength?: number;
  /** 分组轮换变体序号（seq_position，从 1 起）。 */
  seqPosition?: number;
  /** 随机选中权重（0–100，越高越常被选中）。 */
  randomChance?: number;
  /** 触发条件（默认 attack）。 */
  trigger?: "attack" | "release" | "first" | "legato";
  /** keyswitch 触发键下界（sw_lokey）。 */
  swLokey?: number;
  /** keyswitch 触发键上界（sw_hikey）。 */
  swHikey?: number;
  /** 无激活 keyswitch 键时是否默认可选（sw_default=1）。 */
  swDefault?: number;
  /** 音高 LFO 频率（Hz）。 */
  pitchLfoFreq?: number;
  /** 音高 LFO 深度（cents）。 */
  pitchLfoDepth?: number;
  /** 声像 LFO 频率（Hz）。 */
  panLfoFreq?: number;
  /** 声像 LFO 深度（0–100）。 */
  panLfoDepth?: number;
  /** 音量 LFO 频率（Hz）。 */
  ampLfoFreq?: number;
  /** 音量 LFO 深度（0–100）。 */
  ampLfoDepth?: number;
  /** 音高包络深度（cents）。 */
  pitchEnvDepth?: number;
  /** 音高包络攻击（秒）。 */
  pitchEnvAttack?: number;
  /** 音高包络衰减（秒）。 */
  pitchEnvDecay?: number;
  /** 音高包络延音电平（0–100）。 */
  pitchEnvSustain?: number;
  /** 键区交叉淡化：淡入起点（xfin_lokey）。 */
  xfinLokey?: number;
  /** 键区交叉淡化：淡入终点（xfin_hikey，通常等于 lokey）。 */
  xfinHikey?: number;
  /** 键区交叉淡化：淡出起点（xfout_lokey，通常等于 hikey）。 */
  xfoutLokey?: number;
  /** 键区交叉淡化：淡出终点（xfout_hikey）。 */
  xfoutHikey?: number;
  /** 力度区交叉淡化：淡入起点（xfin_lovel）。 */
  xfinLovel?: number;
  /** 力度区交叉淡化：淡入终点（xfin_hivel）。 */
  xfinHivel?: number;
  /** 力度区交叉淡化：淡出起点（xfout_lovel）。 */
  xfoutLovel?: number;
  /** 力度区交叉淡化：淡出终点（xfout_hivel）。 */
  xfoutHivel?: number;
  /** 滤波包络深度（cents）。 */
  filEnvDepth?: number;
  /** 滤波包络攻击（秒）。 */
  filEnvAttack?: number;
  /** 滤波包络衰减（秒）。 */
  filEnvDecay?: number;
  /** 滤波包络延音电平（0–100）。 */
  filEnvSustain?: number;
  /** 力度→音量响应曲线（力度点 → 音量 0–1，amp_velcurve_N）。 */
  velCurve?: Record<number, number>;
  /** release 触发采样延迟（秒，release_time）。 */
  releaseTime?: number;
  /** 力度→音高调制（cents，pitch_veltrack）。 */
  pitchVelTrack?: number;
  /** 力度→滤波截止调制（Hz，cutoff_veltrack）。 */
  cutoffVelTrack?: number;
  /** 力度→声像调制（0–100，pan_veltrack）。 */
  panVelTrack?: number;
  /** 音高 LFO 延迟（秒）。 */
  pitchLfoDelay?: number;
  /** 声像 LFO 延迟（秒）。 */
  panLfoDelay?: number;
  /** 音量 LFO 延迟（秒）。 */
  ampLfoDelay?: number;
  /** 音高 LFO 波形（sine/triangle/square/sawtooth）。 */
  pitchLfoShape?: OscillatorType;
  /** 声像 LFO 波形。 */
  panLfoShape?: OscillatorType;
  /** 音量 LFO 波形。 */
  ampLfoShape?: OscillatorType;
  /** 音高 LFO 起始相位（度）。 */
  pitchLfoPhase?: number;
  /** 声像 LFO 起始相位（度）。 */
  panLfoPhase?: number;
  /** 音量 LFO 起始相位（度）。 */
  ampLfoPhase?: number;
  /** keyswitch 切换后保持（sw_last；0=松开 keyswitch 键后回默认）。 */
  swLast?: number;
  /** keyswitch 按此键时回退到上一个激活键（sw_previous）。 */
  swPrevious?: number;
  /** CC 交叉淡化：控制器号（xfin_ccN）。 */
  xfinCcN?: number;
  /** CC 交叉淡化：淡入起点值（xfin_ccN=value）。 */
  xfinCcValue?: number;
  /** CC 交叉淡化：控制器号（xfout_ccN）。 */
  xfoutCcN?: number;
  /** CC 交叉淡化：淡出终点值（xfout_ccN=value）。 */
  xfoutCcValue?: number;
  /** CC 触发切换：控制器号（on_ccN）。 */
  onccN?: number;
  /** CC 触发切换：匹配值（on_ccN=value）。 */
  onccValue?: number;
  /** CC→音量调制：控制器号（ccN_amp）。 */
  ccAmpN?: number;
  /** CC→音量调制深度（0–100，100=CC 完全决定音量）。 */
  ccAmpDepth?: number;
  /** CC→音高调制：控制器号（ccN_pitch）。 */
  ccPitchN?: number;
  /** CC→音高调制深度（cents）。 */
  ccPitchDepth?: number;
  /** CC→滤波截止调制：控制器号（ccN_cutoff）。 */
  ccCutoffN?: number;
  /** CC→滤波截止调制深度（Hz）。 */
  ccCutoffDepth?: number;
  /** CC→声像调制：控制器号（ccN_pan）。 */
  ccPanN?: number;
  /** CC→声像调制深度（-100..100）。 */
  ccPanDepth?: number;
  /** v2 合成振荡器波形（有值则非采样发声，优先于 sample）。 */
  oscillator?: OscillatorType;
  /** 采样播放速率 / 振荡器频率倍率（playback_rate）。 */
  playbackRate?: number;
  /** hint_* 元数据（如 hint_keyboard、hint_steam_selfmask），对发声无影响。 */
  hints?: Record<string, number>;
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
