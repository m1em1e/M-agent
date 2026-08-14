import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { SoundBankLoader } from "spessasynth_core";
import { parseSfzText } from "../core/audio/sfz-parser.js";
import type { SfzRegion, SoundFontPresetInfo } from "../shared/instrument.js";

const MAX_SF_BYTES = 512 * 1024 * 1024;

/**
 * 使用 spessasynth_core 解析 SF2/SF3 文件，提取 name/bank/program/preset 清单。
 * 纯主进程逻辑，不依赖 Web Audio。
 */
export async function parseSf2Presets(path: string): Promise<SoundFontPresetInfo[]> {
  const bytes = await readFile(path);
  if (bytes.byteLength > MAX_SF_BYTES) throw new Error("SoundFont 文件超过大小上限。");
  const bank = SoundBankLoader.fromArrayBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const seen = new Set<string>();
  const presets: SoundFontPresetInfo[] = [];
  for (const preset of bank.presets) {
    // bankMSB 为 GM bank；LSB 通常为 0。合并 LSB 以保留完整 bank 标识。
    const bankValue = preset.bankMSB * 128 + preset.bankLSB;
    const key = `${bankValue}:${preset.program}`;
    if (seen.has(key)) continue;
    seen.add(key);
    presets.push({ bank: bankValue, program: preset.program, name: preset.name || `Program ${preset.program}` });
    if (presets.length >= 10_000) break;
  }
  if (presets.length === 0) throw new Error("SoundFont 中未解析到任何音色。");
  return presets;
}

/**
 * 解析 .sfz 文本：提取 preset 名称与采样区域映射。
 * sample 相对路径以 .sfz 所在目录（叠加 <control> default_path）解析为绝对路径。
 */
export async function parseSfz(path: string): Promise<{ presetName: string; regions: SfzRegion[] }> {
  const text = await readFile(path, "utf8");
  const parsed = parseSfzText(text);
  const baseDir = path.slice(0, Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\")) + 1);
  const sampleBase = parsed.defaultPath
    ? resolve(baseDir, parsed.defaultPath.replace(/[\\/]+$/g, ""))
    : baseDir;
  const regions = parsed.regions.map((region) => ({
    ...region,
    samplePath: resolveSamplePath(sampleBase, region.samplePath),
  }));
  const presetName = basename(path).replace(/\.sfz$/i, "");
  return { presetName, regions };
}

function resolveSamplePath(base: string, sample: string): string {
  const normalized = sample.replace(/\\/g, "/");
  if (isAbsolute(normalized)) return normalized;
  return resolve(base, normalized);
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}
