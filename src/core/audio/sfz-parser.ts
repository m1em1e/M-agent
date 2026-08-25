import type { SfzRegion } from "../../shared/instrument.js";

/**
 * 轻量 SFZ 文本解析器。纯逻辑、无文件系统依赖，可单测。
 * 仅覆盖轻量试听所需的最小 opcode 集：
 * sample / key / lokey / hikey / lovel / hivel / pitch_keycenter / tuning /
 * volume / pan / loop_mode / loop_start / loop_end / amp_env_attack / amp_env_release。
 */

export interface SfzParseResult {
  /** <control> 段的 default_path（可选）。 */
  defaultPath?: string;
  /** 解析出的区域列表。samplePath 暂为文本中的原始 sample 值，由调用方解析为绝对路径。 */
  regions: SfzRegion[];
  /** <include> 引用的子文件路径（相对本文件所在目录解析）。 */
  includes?: string[];
}

const DEFAULT_KEY_CENTER = 60;

export function parseSfzText(text: string): SfzParseResult {
  const regions: SfzRegion[] = [];
  let defaultPath: string | undefined;
  const includes: string[] = [];

  const globals = new Map<string, string>();
  let groups = new Map<string, string>();
  let locals: Map<string, string> | null = null;
  let context: "global" | "group" | "region" | "control" | null = null;

  const flushRegion = (): void => {
    if (locals === null) return;
    const region = buildRegion(new Map([...globals, ...groups, ...locals]));
    if (region) regions.push(region);
    locals = null;
  };

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    if (trimmed.startsWith("<")) {
      // <include>path</include>：单独处理（不含 opcode）。
      const includeMatch = /^<include>\s*(.+?)\s*<\/include>\s*$/i.exec(trimmed);
      if (includeMatch) {
        flushRegion();
        includes.push(includeMatch[1]);
        continue;
      }
      flushRegion();
      const closeIndex = trimmed.indexOf(">");
      if (closeIndex < 0) continue;
      const headerBody = trimmed.slice(1, closeIndex).trim();
      const remainder = trimmed.slice(closeIndex + 1).trim();
      const tokens = `${headerBody} ${remainder}`.trim().split(/\s+/);
      const header = tokens[0];
      const opcodes = parseOpcodes(tokens.slice(1).join(" "));
      if (header === "global") {
        globals.clear();
        mergeOpcodes(globals, opcodes);
        context = "global";
      } else if (header === "group") {
        groups = new Map();
        mergeOpcodes(groups, opcodes);
        context = "group";
      } else if (header === "region") {
        locals = new Map();
        mergeOpcodes(locals, opcodes);
        context = "region";
      } else if (header === "control") {
        if (opcodes.get("default_path") !== undefined) defaultPath = opcodes.get("default_path");
        context = "control";
      }
      continue;
    }

    // 无头 opcode 行：归属当前上下文（region > group > global）。
    const opcodes = parseOpcodes(trimmed);
    if (context === "region" && locals !== null) {
      mergeOpcodes(locals, opcodes);
    } else if (context === "group") {
      mergeOpcodes(groups, opcodes);
    } else {
      mergeOpcodes(globals, opcodes);
    }
  }
  flushRegion();

  return { defaultPath, regions, includes: includes.length > 0 ? includes : undefined };
}

/** 按音符与力度选择命中的区域（支持力度分层，命中多个时全部返回）。 */
export function selectSfzRegions(regions: SfzRegion[], note: number, velocity: number): SfzRegion[] {
  return regions.filter((region) =>
    note >= region.lokey && note <= region.hikey
    && velocity >= region.lovel && velocity <= region.hivel);
}

/** 分组行为（seq 轮换 / random / trigger）所需的状态。 */
export interface SfzPickState {
  /** note → 该键的轮换触发计数（从 0 起，每次触发 +1）。 */
  seqCounts?: Map<number, number>;
}

/**
 * 带分组行为的区域选择：
 * - trigger：attack（默认）只选非 release 区域；release 只选 release 区域。
 * - seq_length/seq_position：按 note 触发计数顺序轮换。
 * - random：按权重（0–100）随机保留，避免全滤时回退到全部命中。
 * 保留 selectSfzRegions 的基础键区/力度过滤。
 */
export function pickSfzRegions(
  regions: SfzRegion[],
  note: number,
  velocity: number,
  trigger: "attack" | "release",
  state?: SfzPickState,
  random: () => number = Math.random,
  keyswitch?: number,
  legato = false,
): SfzRegion[] {
  const base = selectSfzRegions(regions, note, velocity);
  if (base.length === 0) return base;
  const matched = base.filter((region) => matchTrigger(region.trigger, trigger, legato));
  if (matched.length === 0) return trigger === "release" ? matched : base;

  // D：keyswitch 过滤（总是应用）—— 有 sw_* 的区域需落在激活键区间内；无激活键时只选 sw_default。
  const keyswitched = matched.filter((region) => {
    if (region.swLokey === undefined && region.swHikey === undefined) return true;
    if (keyswitch === undefined) return region.swDefault === 1;
    return keyswitch >= (region.swLokey ?? 0) && keyswitch <= (region.swHikey ?? 127);
  });
  if (keyswitched.length === 0) return [];
  const selection = keyswitched;

  // seq 轮换：有 seq_length/seq_position 的区域按触发计数选当前位。
  const seqRegions = selection.filter((region) => region.seqLength !== undefined && region.seqPosition !== undefined);
  if (seqRegions.length > 0) {
    const length = seqRegions[0].seqLength ?? 1;
    const count = state?.seqCounts?.get(note) ?? 0;
    state?.seqCounts?.set(note, count + 1);
    const expected = (count % length) + 1;
    return selection.filter((region) =>
      region.seqPosition === undefined || region.seqPosition === expected);
  }

  // random：按权重独立保留，全部滤掉时回退全部。
  const withRandom = selection.filter((region) => region.randomChance !== undefined);
  if (withRandom.length > 0) {
    const kept = selection.filter((region) =>
      region.randomChance === undefined || random() * 100 < region.randomChance);
    return kept.length > 0 ? kept : selection;
  }

  return selection;
}

/** 单个交叉淡化带（键或力度区）的淡化系数：淡入带 inStart(0)→inEnd(1)，淡出带 outStart(1)→outEnd(0)，中间 1。 */
function crossfadeGain(value: number, inStart: number, inEnd: number, outStart: number, outEnd: number): number {
  if (inStart !== inEnd && value >= inStart && value <= inEnd) {
    return Math.max(0, Math.min(1, (value - inStart) / (inEnd - inStart)));
  }
  if (outStart !== outEnd && value >= outStart && value <= outEnd) {
    return Math.max(0, Math.min(1, (outEnd - value) / (outEnd - outStart)));
  }
  return 1;
}

/** 力度曲线插值：按力度从 velCurve 表中线性插值音量系数（无表返回 undefined）。 */
export function sampleVelCurve(curve: Record<number, number> | undefined, velocity: number): number | undefined {
  if (!curve) return undefined;
  const points = Object.keys(curve).map(Number).sort((a, b) => a - b);
  if (points.length === 0) return undefined;
  if (velocity <= points[0]) return curve[points[0]];
  const last = points[points.length - 1];
  if (velocity >= last) return curve[last];
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i];
    const p1 = points[i + 1];
    if (velocity >= p0 && velocity <= p1) {
      const t = (velocity - p0) / (p1 - p0);
      return curve[p0] + (curve[p1] - curve[p0]) * t;
    }
  }
  return curve[last];
}

/** trigger 匹配：release 只选 release；非 release 时 legato 选 legato 区域，否则选 attack/first/默认。 */
function matchTrigger(regionTrigger: SfzRegion["trigger"], trigger: "attack" | "release", legato: boolean): boolean {
  if (trigger === "release") return regionTrigger === "release";
  if (regionTrigger === "release") return false;
  if (regionTrigger === "legato") return legato;
  return !legato;
}

/**
 * 带交叉淡化与选择策略的区域选择：返回命中区域及其音量系数。
 * 键/力度命中扩展到 xfin/xfout 范围；gain = 键淡化 × 力度淡化。
 * trigger / keyswitch / seq / random 过滤与 pickSfzRegions 一致。
 */
export function pickSfzRegionsWithGain(
  regions: SfzRegion[],
  note: number,
  velocity: number,
  trigger: "attack" | "release",
  state?: SfzPickState,
  random: () => number = Math.random,
  keyswitch?: number,
  legato = false,
): Array<{ region: SfzRegion; gain: number }> {
  const matched = regions.filter((region) => {
    // 有效键区：淡入起点到淡出终点；力度区同理。
    const keyLow = region.xfinLokey ?? region.lokey;
    const keyHigh = region.xfoutHikey ?? region.hikey;
    if (note < keyLow || note > keyHigh) return false;
    const velLow = region.xfinLovel ?? region.lovel;
    const velHigh = region.xfoutHivel ?? region.hivel;
    if (velocity < velLow || velocity > velHigh) return false;
    if (!matchTrigger(region.trigger, trigger, legato)) return false;
    // keyswitch 过滤。
    if (region.swLokey !== undefined || region.swHikey !== undefined) {
      if (keyswitch === undefined ? region.swDefault !== 1
        : keyswitch < (region.swLokey ?? 0) || keyswitch > (region.swHikey ?? 127)) return false;
    }
    return true;
  });
  if (matched.length === 0) return [];

  // seq 轮换：有 seq_length/seq_position 的区域按触发计数选当前位。
  const seqRegions = matched.filter((region) => region.seqLength !== undefined && region.seqPosition !== undefined);
  let selection = matched;
  if (seqRegions.length > 0) {
    const length = seqRegions[0].seqLength ?? 1;
    const count = state?.seqCounts?.get(note) ?? 0;
    state?.seqCounts?.set(note, count + 1);
    const expected = (count % length) + 1;
    selection = matched.filter((region) => region.seqPosition === undefined || region.seqPosition === expected);
    if (selection.length === 0) selection = matched;
  }

  // random：按权重独立保留，全部滤掉时回退全部。
  const withRandom = selection.filter((region) => region.randomChance !== undefined);
  if (withRandom.length > 0) {
    const kept = selection.filter((region) =>
      region.randomChance === undefined || random() * 100 < region.randomChance);
    selection = kept.length > 0 ? kept : selection;
  }

  return selection.map((region) => ({
    region,
    gain: crossfadeGain(note, region.xfinLokey ?? region.lokey, region.xfinHikey ?? region.lokey, region.xfoutLokey ?? region.hikey, region.xfoutHikey ?? region.hikey)
      * crossfadeGain(velocity, region.xfinLovel ?? region.lovel, region.xfinHivel ?? region.lovel, region.xfoutLovel ?? region.hivel, region.xfoutHivel ?? region.hivel),
  }));
}

function buildRegion(opcodes: Map<string, string>): SfzRegion | null {
  const sample = opcodes.get("sample");
  if (!sample) return null;

  const keyCenter = pickInt(opcodes, "key", "pitch_keycenter", DEFAULT_KEY_CENTER);

  const region: SfzRegion = {
    samplePath: sample,
    lokey: pickInt(opcodes, "lokey", 0),
    hikey: pickInt(opcodes, "hikey", 127),
    lovel: pickInt(opcodes, "lovel", 0),
    hivel: pickInt(opcodes, "hivel", 127),
    keyCenter,
    tuning: pickInt(opcodes, "tuning", 0),
    volume: pickInt(opcodes, "volume", 0),
    pan: clamp(pickInt(opcodes, "pan", 0), -100, 100),
  };

  // key opcode 同时设置 lokey/hikey/keyCenter（若这些尚未显式给出）。
  if (opcodes.has("key")) {
    if (!opcodes.has("lokey")) region.lokey = keyCenter;
    if (!opcodes.has("hikey")) region.hikey = keyCenter;
    if (!opcodes.has("pitch_keycenter")) region.keyCenter = keyCenter;
  }

  const loopMode = opcodes.get("loop_mode");
  if (loopMode === "one_shot") {
    region.loopMode = "one_shot";
  } else if (loopMode === "loop_continuous") {
    region.loopMode = "continuous";
  } else if (loopMode === "loop_sustain") {
    region.loopMode = "sustain";
  }
  if (region.loopMode && opcodes.get("loop_start") !== undefined) {
    region.loopStart = positiveInt(opcodes.get("loop_start") ?? "0");
  }
  if (region.loopMode && opcodes.get("loop_end") !== undefined) {
    region.loopEnd = positiveInt(opcodes.get("loop_end") ?? "0");
  }

  const attack = parseSeconds(pickOpcode(opcodes, "amp_env_attack", "ampeg_attack"));
  const decay = parseSeconds(pickOpcode(opcodes, "amp_env_decay", "ampeg_decay"));
  const sustain = parsePercent(pickOpcode(opcodes, "amp_env_sustain", "ampeg_sustain"));
  const release = parseSeconds(pickOpcode(opcodes, "amp_env_release", "ampeg_release"));
  const hold = parseSeconds(pickOpcode(opcodes, "amp_env_hold", "ampeg_hold"));
  if (attack !== undefined) region.attack = attack;
  if (decay !== undefined) region.decay = decay;
  if (sustain !== undefined) region.sustain = sustain;
  if (release !== undefined) region.release = release;
  if (hold !== undefined) region.hold = hold;

  const offset = positiveInt(pickOpcode(opcodes, "offset") ?? "0");
  const end = positiveInt(pickOpcode(opcodes, "end") ?? "0");
  if (opcodes.has("offset")) region.offset = offset;
  if (opcodes.has("end")) region.end = end;

  const velTrack = parsePercent(pickOpcode(opcodes, "amp_veltrack", "ampeg_veltrack"));
  if (velTrack !== undefined) region.ampVelTrack = velTrack;

  // A：别名与补全 —— tune/pitch 为 tuning 的别名；delay、pitch_keytrack、pitch_offset。
  const tuningRaw = pickOpcode(opcodes, "tuning", "tune", "pitch");
  if (tuningRaw !== undefined) {
    const parsedTuning = Number(tuningRaw);
    if (Number.isFinite(parsedTuning)) region.tuning = parsedTuning;
  }
  const delay = parseSeconds(pickOpcode(opcodes, "delay", "amp_env_delay", "ampeg_delay"));
  if (delay !== undefined) region.delay = delay;
  const keytrack = parsePercent(pickOpcode(opcodes, "pitch_keytrack"));
  if (keytrack !== undefined) region.keytrack = keytrack;
  const pitchOffset = pickInt(opcodes, "pitch_offset", 0);
  if (opcodes.has("pitch_offset")) region.pitchOffset = pitchOffset;

  // B：滤波器 —— fil_type / cutoff / resonance。
  const filterType = pickOpcode(opcodes, "fil_type");
  if (filterType !== undefined) {
    const mapped = mapFilterType(filterType);
    if (mapped) region.filterType = mapped;
  }
  if (opcodes.has("cutoff")) {
    const cutoff = positiveInt(opcodes.get("cutoff") ?? "0");
    if (cutoff > 0) region.cutoffHz = cutoff;
  }
  if (opcodes.has("resonance")) {
    const resonance = positiveInt(opcodes.get("resonance") ?? "0");
    // SFZ resonance 0–40（dB 风格）；映射到 BiquadFilter Q（约 0.5–20）。
    if (resonance > 0) region.resonanceQ = 0.5 + (resonance / 40) * 19.5;
  }

  // C：分组行为 —— seq_length / seq_position / random / trigger。
  if (opcodes.has("seq_length")) {
    const seqLength = positiveInt(opcodes.get("seq_length") ?? "0");
    if (seqLength > 0) region.seqLength = seqLength;
  }
  if (opcodes.has("seq_position")) {
    const seqPosition = positiveInt(opcodes.get("seq_position") ?? "0");
    if (seqPosition > 0) region.seqPosition = seqPosition;
  }
  const randomChance = parsePercent(pickOpcode(opcodes, "random"));
  if (randomChance !== undefined) region.randomChance = randomChance;
  const trigger = pickOpcode(opcodes, "trigger");
  if (trigger === "release" || trigger === "first" || trigger === "legato") {
    region.trigger = trigger;
  } else if (trigger !== undefined) {
    region.trigger = "attack";
  }

  // D：keyswitch —— sw_lokey / sw_hikey / sw_default。
  if (opcodes.has("sw_lokey")) {
    const swLokey = positiveInt(opcodes.get("sw_lokey") ?? "0");
    if (swLokey >= 0) region.swLokey = swLokey;
  }
  if (opcodes.has("sw_hikey")) {
    const swHikey = positiveInt(opcodes.get("sw_hikey") ?? "0");
    if (swHikey >= 0) region.swHikey = swHikey;
  }
  if (opcodes.has("sw_default")) {
    region.swDefault = pickInt(opcodes, "sw_default", 0) === 1 ? 1 : 0;
  }

  // F：调制 —— LFO（pitch/pan/amp）与 pitch 包络。
  if (opcodes.has("pitch_lfo_freq")) region.pitchLfoFreq = positiveInt(opcodes.get("pitch_lfo_freq") ?? "0");
  if (opcodes.has("pitch_lfo_depth")) region.pitchLfoDepth = positiveInt(opcodes.get("pitch_lfo_depth") ?? "0");
  if (opcodes.has("pan_lfo_freq")) region.panLfoFreq = positiveInt(opcodes.get("pan_lfo_freq") ?? "0");
  if (opcodes.has("pan_lfo_depth")) region.panLfoDepth = positiveInt(opcodes.get("pan_lfo_depth") ?? "0");
  if (opcodes.has("amp_lfo_freq")) region.ampLfoFreq = positiveInt(opcodes.get("amp_lfo_freq") ?? "0");
  if (opcodes.has("amp_lfo_depth")) region.ampLfoDepth = positiveInt(opcodes.get("amp_lfo_depth") ?? "0");
  if (opcodes.has("pitch_env_depth")) region.pitchEnvDepth = positiveInt(opcodes.get("pitch_env_depth") ?? "0");
  const pitchEnvAttack = parseSeconds(pickOpcode(opcodes, "pitch_env_attack"));
  const pitchEnvDecay = parseSeconds(pickOpcode(opcodes, "pitch_env_decay"));
  const pitchEnvSustain = parsePercent(pickOpcode(opcodes, "pitch_env_sustain"));
  if (pitchEnvAttack !== undefined) region.pitchEnvAttack = pitchEnvAttack;
  if (pitchEnvDecay !== undefined) region.pitchEnvDecay = pitchEnvDecay;
  if (pitchEnvSustain !== undefined) region.pitchEnvSustain = pitchEnvSustain;

  // 交叉淡化（键/力度）：xfin_*/xfout_*。
  const pair = (key: string): number | undefined => {
    const value = opcodes.get(key);
    if (value === undefined) return undefined;
    const parsed = positiveInt(value);
    return parsed >= 0 ? parsed : undefined;
  };
  const xfinLokey = pair("xfin_lokey");
  const xfinHikey = pair("xfin_hikey");
  const xfoutLokey = pair("xfout_lokey");
  const xfoutHikey = pair("xfout_hikey");
  const xfinLovel = pair("xfin_lovel");
  const xfinHivel = pair("xfin_hivel");
  const xfoutLovel = pair("xfout_lovel");
  const xfoutHivel = pair("xfout_hivel");
  if (xfinLokey !== undefined) region.xfinLokey = xfinLokey;
  if (xfinHikey !== undefined) region.xfinHikey = xfinHikey;
  if (xfoutLokey !== undefined) region.xfoutLokey = xfoutLokey;
  if (xfoutHikey !== undefined) region.xfoutHikey = xfoutHikey;
  if (xfinLovel !== undefined) region.xfinLovel = xfinLovel;
  if (xfinHivel !== undefined) region.xfinHivel = xfinHivel;
  if (xfoutLovel !== undefined) region.xfoutLovel = xfoutLovel;
  if (xfoutHivel !== undefined) region.xfoutHivel = xfoutHivel;

  // 滤波包络：fil_env_depth/attack/decay/sustain。
  if (opcodes.has("fil_env_depth")) region.filEnvDepth = positiveInt(opcodes.get("fil_env_depth") ?? "0");
  const filEnvAttack = parseSeconds(pickOpcode(opcodes, "fil_env_attack"));
  const filEnvDecay = parseSeconds(pickOpcode(opcodes, "fil_env_decay"));
  const filEnvSustain = parsePercent(pickOpcode(opcodes, "fil_env_sustain"));
  if (filEnvAttack !== undefined) region.filEnvAttack = filEnvAttack;
  if (filEnvDecay !== undefined) region.filEnvDecay = filEnvDecay;
  if (filEnvSustain !== undefined) region.filEnvSustain = filEnvSustain;

  // 力度曲线：amp_velcurve_N（力度点 → 音量 0–1）。
  const curve: Record<number, number> = {};
  for (const [key, value] of opcodes) {
    const match = /^amp_velcurve_(\d+)$/i.exec(key);
    if (!match) continue;
    const point = Number(match[1]);
    if (!Number.isInteger(point) || point < 0 || point > 127) continue;
    const level = Number(value);
    if (Number.isFinite(level)) curve[point] = Math.max(0, Math.min(1, level));
  }
  const curveKeys = Object.keys(curve);
  if (curveKeys.length > 0) region.velCurve = curve;

  // trigger 补全：release_time。
  if (opcodes.has("release_time")) region.releaseTime = parseSeconds(opcodes.get("release_time"));

  // 调制补全：veltrack 变体与 LFO delay。
  if (opcodes.has("pitch_veltrack")) region.pitchVelTrack = positiveInt(opcodes.get("pitch_veltrack") ?? "0");
  if (opcodes.has("cutoff_veltrack")) region.cutoffVelTrack = positiveInt(opcodes.get("cutoff_veltrack") ?? "0");
  if (opcodes.has("pan_veltrack")) region.panVelTrack = positiveInt(opcodes.get("pan_veltrack") ?? "0");
  if (opcodes.has("pitch_lfo_delay")) region.pitchLfoDelay = parseSeconds(opcodes.get("pitch_lfo_delay"));
  if (opcodes.has("pan_lfo_delay")) region.panLfoDelay = parseSeconds(opcodes.get("pan_lfo_delay"));
  if (opcodes.has("amp_lfo_delay")) region.ampLfoDelay = parseSeconds(opcodes.get("amp_lfo_delay"));

  return region;
}

/** 映射 SFZ fil_type 到 Web Audio 滤波器类型；无法识别返回 undefined。 */
function mapFilterType(value: string): SfzRegion["filterType"] | undefined {
  const normalized = value.toLowerCase();
  if (normalized.includes("lpf") || normalized.includes("lowpass")) return "lowpass";
  if (normalized.includes("hpf") || normalized.includes("highpass")) return "highpass";
  if (normalized.includes("bpf") || normalized.includes("bandpass")) return "bandpass";
  if (normalized.includes("brf") || normalized.includes("bandreject") || normalized.includes("notch")) return "bandreject";
  return undefined;
}

/** 依次从多个候选 key 中取第一个存在的值。 */
function pickOpcode(opcodes: Map<string, string>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    if (opcodes.has(key)) return opcodes.get(key);
  }
  return undefined;
}

/** 解析 0–100 百分比；非法或缺失返回 undefined。 */
function parsePercent(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? clamp(parsed, 0, 100) : undefined;
}

/** 解析一行 `key=value key="value with space"` 形式的 opcode。 */
function parseOpcodes(text: string): Map<string, string> {
  const result = new Map<string, string>();
  const tokenPattern = /([^\s=]+)=(?:"([^"]*)"|(\S*))/g;
  let match: RegExpExecArray | null;
  while ((match = tokenPattern.exec(text)) !== null) {
    result.set(match[1], match[2] !== undefined ? match[2] : (match[3] ?? ""));
  }
  return result;
}

function mergeOpcodes(target: Map<string, string>, source: Map<string, string>): void {
  for (const [key, value] of source) target.set(key, value);
}

function pickInt(opcodes: Map<string, string>, key: string, fallback: number): number;
function pickInt(opcodes: Map<string, string>, first: string, second: string, fallback: number): number;
function pickInt(opcodes: Map<string, string>, first: string, secondOrFallback: string | number, maybeFallback?: number): number {
  const value = opcodes.get(first);
  if (value !== undefined) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof secondOrFallback === "string") {
    const second = opcodes.get(secondOrFallback);
    if (second !== undefined) {
      const parsed = Number(second);
      if (Number.isFinite(parsed)) return parsed;
    }
    return maybeFallback ?? 0;
  }
  return secondOrFallback;
}

function positiveInt(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function parseSeconds(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
