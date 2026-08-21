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
  /** 活动振荡器：`channel:note` → 当前发声节点。 */
  private activeOscillators = new Map<string, { source: OscillatorNode; gain: GainNode }>();

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

  /** 播放一个音符（保持延音，由 noteOff 释放）。trackInstrument 提供 soundfont/sfz 引用时走对应引擎，否则振荡器。 */
  async noteOn(options: {
    channel: number;
    note: number;
    velocity: number;
    volume: number;
    soundFont?: { libraryId: string; bank: number; program: number };
    sfz?: { libraryId: string };
    oscillator?: boolean;
  }): Promise<void> {
    const context = await this.ensureContext();
    await context.resume();
    if (options.soundFont && this.synthHost?.hasBank(options.soundFont.libraryId)) {
      this.synthHost.noteOn(options.channel, options.note, options.velocity, options.soundFont.bank, options.soundFont.program);
      return;
    }
    if (options.sfz && this.sfzEngine) {
      await this.sfzEngine.noteOn(options.channel, options.note, options.velocity, options.sfz.libraryId);
      return;
    }
    if (options.oscillator === false) return;
    this.noteOnOscillator(context, options.channel, options.note, options.velocity, options.volume);
  }

  /** 释放音符（统一路由：SoundFont / SFZ / 振荡器各自释放，未活动时 no-op）。 */
  noteOff(channel: number, note: number): void {
    this.synthHost?.noteOff(channel, note);
    this.sfzEngine?.noteOff(channel, note);
    const key = `${channel}:${note}`;
    const entry = this.activeOscillators.get(key);
    if (entry) {
      this.releaseOscillator(entry);
      this.activeOscillators.delete(key);
    }
  }

  stopAll(): void {
    this.synthHost?.stopAll();
    this.sfzEngine?.stopAll();
    for (const entry of this.activeOscillators.values()) {
      this.releaseOscillator(entry, 0.01);
    }
    this.activeOscillators.clear();
  }

  private noteOnOscillator(context: AudioContext, channel: number, note: number, velocity: number, volume: number): void {
    const key = `${channel}:${note}`;
    // 同键重复触发：先停旧的再起新的。
    const existing = this.activeOscillators.get(key);
    if (existing) {
      this.releaseOscillator(existing);
      this.activeOscillators.delete(key);
    }
    const source = context.createOscillator();
    const gainNode = context.createGain();
    source.type = "triangle";
    source.frequency.value = 440 * 2 ** ((note - 69) / 12);
    const now = context.currentTime;
    const level = (velocity / 127) * Math.max(0, Math.min(1, volume)) * 0.05;
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.001, level), now + 0.006);
    source.connect(gainNode).connect(context.destination);
    source.start(now);
    this.activeOscillators.set(key, { source, gain: gainNode });
  }

  private releaseOscillator(entry: { source: OscillatorNode; gain: GainNode }, releaseSeconds = 0.06): void {
    const now = this.context?.currentTime ?? 0;
    const end = now + Math.max(0.01, releaseSeconds);
    try {
      entry.gain.gain.cancelScheduledValues(now);
      entry.gain.gain.setValueAtTime(entry.gain.gain.value, now);
      entry.gain.gain.exponentialRampToValueAtTime(0.0001, end);
    } catch {
      // 忽略调度异常。
    }
    try {
      entry.source.stop(end + 0.02);
    } catch {
      // 已结束。
    }
  }

  dispose(): void {
    this.synthHost?.stopAll();
    this.sfzEngine?.dispose();
    for (const entry of this.activeOscillators.values()) {
      this.releaseOscillator(entry, 0.01);
    }
    this.activeOscillators.clear();
    this.context?.close().catch(() => undefined);
    this.context = null;
    this.synthHost = null;
    this.sfzEngine = null;
    this.buffers.clear();
  }
}

export { WorkletSynthesizer };
