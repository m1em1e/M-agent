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
}

const DEFAULT_KEY_CENTER = 60;

export function parseSfzText(text: string): SfzParseResult {
  const regions: SfzRegion[] = [];
  let defaultPath: string | undefined;

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

  return { defaultPath, regions };
}

/** 按音符与力度选择命中的区域（支持力度分层，命中多个时全部返回）。 */
export function selectSfzRegions(regions: SfzRegion[], note: number, velocity: number): SfzRegion[] {
  return regions.filter((region) =>
    note >= region.lokey && note <= region.hikey
    && velocity >= region.lovel && velocity <= region.hivel);
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

  const attack = parseSeconds(opcodes.get("amp_env_attack"));
  const release = parseSeconds(opcodes.get("amp_env_release"));
  if (attack !== undefined) region.attack = attack;
  if (release !== undefined) region.release = release;

  return region;
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
