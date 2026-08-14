import { WorkletSynthesizer } from "spessasynth_lib";
import { SoundFontSynthHost } from "./soundfont-engine.js";
import { SfzEngine } from "./sfz-engine.js";
import type { SfzRegion } from "../../shared/instrument.js";

/**
 * 统一轻量音频引擎：管理 AudioContext、共享 SpessaSynth 合成器、
 * SFZ 采样引擎，以及 track.instrument 路由。无 instrument 的轨道回退到 Web Audio 振荡器。
 */
export class AudioEngine {
  private context: AudioContext | null = null;
  private synthHost: SoundFontSynthHost | null = null;
  private sfzEngine: SfzEngine | null = null;
  private buffers = new Map<string, ArrayBuffer>();

  /** 获取（懒创建）AudioContext。 */
  private async ensureContext(): Promise<AudioContext> {
    if (this.context) return this.context;
    const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtor) throw new Error("当前环境不支持 Web Audio。");
    const context = new AudioCtor();
    // worklet 处理器被拷贝到构建/开发根目录。基于页面地址推导根路径：
    // - dev：http://127.0.0.1:5173/ → /spessasynth_processor.min.js
    // - prod：file:///.../dist/index.html → 同目录 spessasynth_processor.min.js
    const pageUrl = new URL(window.location.href);
    const rootUrl = pageUrl.protocol === "file:"
      ? new URL("spessasynth_processor.min.js", `${pageUrl.href.slice(0, pageUrl.href.lastIndexOf("/") + 1)}`)
      : new URL("/spessasynth_processor.min.js", pageUrl);
    await context.audioWorklet.addModule(rootUrl);
    const synth = new WorkletSynthesizer(context);
    this.synthHost = new SoundFontSynthHost(synth);
    this.sfzEngine = new SfzEngine(context);
    synth.connect(context.destination);
    this.context = context;
    return context;
  }

  async resume(): Promise<void> {
    const context = await this.ensureContext();
    if (context.state === "suspended") await context.resume();
  }

  /** 注册/加载一个 SoundFont 库（幂等）。 */
  async loadSoundFont(libraryId: string, path: string, fetchBytes: (path: string) => Promise<ArrayBuffer>): Promise<boolean> {
    const context = await this.ensureContext();
    await context.resume();
    if (!this.synthHost) return false;
    if (this.synthHost.hasBank(libraryId)) return true;
    let buffer = this.buffers.get(libraryId);
    if (!buffer) {
      buffer = await fetchBytes(path);
      this.buffers.set(libraryId, buffer);
    }
    return this.synthHost.ensureBank(libraryId, buffer);
  }

  /** 注册一个 SFZ 库（幂等）。采样按需通过 fetchBytes 懒解码。 */
  async loadSfz(libraryId: string, regions: SfzRegion[], fetchBytes: (path: string) => Promise<ArrayBuffer>): Promise<void> {
    const context = await this.ensureContext();
    await context.resume();
    if (!this.sfzEngine) return;
    this.sfzEngine.load(libraryId, regions, fetchBytes);
  }

  /** 播放一个音符。trackInstrument 提供 soundfont/sfz 引用时走对应引擎，否则振荡器。 */
  async noteOn(options: {
    channel: number;
    note: number;
    velocity: number;
    durationMs?: number;
    volume: number;
    soundFont?: { libraryId: string; bank: number; program: number };
    sfz?: { libraryId: string };
    oscillator?: boolean;
  }): Promise<void> {
    const context = await this.ensureContext();
    await context.resume();
    const gain = (options.velocity / 127) * Math.max(0, Math.min(1, options.volume)) * 0.9;
    if (options.soundFont && this.synthHost?.hasBank(options.soundFont.libraryId)) {
      this.synthHost.noteOn(options.channel, options.note, options.velocity, options.soundFont.bank, options.soundFont.program);
      return;
    }
    if (options.sfz && this.sfzEngine) {
      await this.sfzEngine.play(options.sfz.libraryId, options.note, options.velocity, options.durationMs ?? 200);
      return;
    }
    if (options.oscillator === false) return;
    this.playOscillator(context, options.note, gain, options.durationMs ?? 120);
  }

  noteOff(channel: number, note: number): void {
    this.synthHost?.noteOff(channel, note);
  }

  stopAll(): void {
    this.synthHost?.stopAll();
  }

  private playOscillator(context: AudioContext, note: number, gain: number, durationMs: number): void {
    const oscillator = context.createOscillator();
    const gainNode = context.createGain();
    oscillator.type = "triangle";
    oscillator.frequency.value = 440 * 2 ** ((note - 69) / 12);
    const now = context.currentTime;
    const volume = gain * 0.05;
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), now + 0.006);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
    oscillator.connect(gainNode).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + durationMs / 1000 + 0.02);
  }

  dispose(): void {
    this.synthHost?.stopAll();
    this.sfzEngine?.dispose();
    this.context?.close().catch(() => undefined);
    this.context = null;
    this.synthHost = null;
    this.sfzEngine = null;
    this.buffers.clear();
  }
}

export { WorkletSynthesizer };
