import { readFile } from "node:fs/promises";
import { SoundBankLoader } from "spessasynth_core";
import type { SoundFontPresetInfo } from "../shared/instrument.js";

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
