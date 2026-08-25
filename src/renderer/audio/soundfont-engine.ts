import type { BasicSynthesizer } from "spessasynth_lib";

/**
 * SoundFont 库在共享合成器中的已加载状态。
 */
export interface LoadedSoundFont {
  libraryId: string;
  loaded: boolean;
}

/**
 * 共享合成器封装：加载多个 SoundFont 库，并负责库 → (bank, program) 的路由。
 * 轻量场景下整个应用只创建一个 WorkletSynthesizer。
 */
export class SoundFontSynthHost {
  readonly synth: BasicSynthesizer;
  private readonly banks = new Map<string, LoadedSoundFont>();

  constructor(synth: BasicSynthesizer) {
    this.synth = synth;
  }

  /** 加载或确认一个库已就绪；返回该库是否可用。 */
  async ensureBank(libraryId: string, soundFontBuffer: ArrayBuffer): Promise<boolean> {
    const existing = this.banks.get(libraryId);
    if (existing) return existing.loaded;
    await this.synth.isReady;
    await this.synth.soundBankManager.addSoundBank(soundFontBuffer, libraryId, 0);
    this.banks.set(libraryId, { libraryId, loaded: true });
    return true;
  }

  hasBank(libraryId: string): boolean {
    return this.banks.get(libraryId)?.loaded ?? false;
  }

  /**
   * 在指定 channel 上切换音色并触发音符。
   * bank 值由 SoundFontPresetInfo.bank（bankMSB*128+bankLSB）编码。
   */
  noteOn(channel: number, note: number, velocity: number, bank: number, program: number): void {
    if (bank > 0) {
      this.synth.controllerChange(channel, 0, Math.floor(bank / 128));
      this.synth.controllerChange(channel, 32, bank % 128);
    }
    this.synth.programChange(channel, program);
    this.synth.noteOn(channel, note, velocity);
  }

  noteOff(channel: number, note: number): void {
    this.synth.noteOff(channel, note);
  }

  /** 发送控制器消息（CC，如 CC64 延音踏板）。 */
  controllerChange(channel: number, controller: number, value: number): void {
    this.synth.controllerChange(channel, controller as unknown as Parameters<typeof this.synth.controllerChange>[1], value);
  }

  stopAll(): void {
    this.synth.stopAll(true);
  }
}
