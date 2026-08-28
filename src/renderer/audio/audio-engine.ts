import { WorkletSynthesizer } from "spessasynth_lib";
import { SoundFontSynthHost } from "./soundfont-engine.js";
import { SfzEngine, type SfzNoteParams } from "./sfz-engine.js";
import type { SfzRegion } from "../../shared/instrument.js";

/**
 * 统一轻量音频引擎：管理 AudioContext、每通道一个 SpessaSynth 合成器实例
 * （经 StereoPanner + BiquadFilter 节点链，使音符级声像/截止/共振在 SoundFont 轨也可听）、
 * SFZ 采样引擎，以及 track.instrument 路由。无 instrument 的轨道回退到 Web Audio 振荡器。
 */

interface SoundFontChannel {
  host: SoundFontSynthHost;
  pan: StereoPannerNode;
  filter: BiquadFilterNode;
  /** 已加载的库（libraryId）。 */
  banks: Set<string>;
}

export class AudioEngine {
  private context: AudioContext | null = null;
  /** 每（真实 MIDI 通道）一个合成器实例 + 参数链（内部统一用 channel 0）。 */
  private sfChannels = new Map<number, SoundFontChannel>();
  private sfzEngine: SfzEngine | null = null;
  private buffers = new Map<string, ArrayBuffer>();
  /** 已确认可用（bank 已加载到某个实例）的库集合。 */
  private bankReady = new Set<string>();
  /** 活动振荡器：`channel:note` → 当前发声节点。 */
  private activeOscillators = new Map<string, { source: OscillatorNode; gain: GainNode; pan?: StereoPannerNode }>();

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
    this.sfzEngine = new SfzEngine(context);
    this.context = context;
    return context;
  }

  async resume(): Promise<void> {
    const context = await this.ensureContext();
    if (context.state === "suspended") await context.resume();
  }

  private async ensureSoundFontChannel(channel: number): Promise<SoundFontChannel> {
    const context = await this.ensureContext();
    const existing = this.sfChannels.get(channel);
    if (existing) return existing;
    const synth = new WorkletSynthesizer(context);
    const host = new SoundFontSynthHost(synth);
    const gain = context.createGain();
    const pan = context.createStereoPanner();
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 24_000; // 常态透明（≈不过滤）
    filter.Q.value = 0.5;
    synth.connect(gain);
    gain.connect(pan);
    pan.connect(filter);
    filter.connect(context.destination);
    const entry: SoundFontChannel = { host, pan, filter, banks: new Set() };
    this.sfChannels.set(channel, entry);
    return entry;
  }

  /** 确保指定实例已加载该库（每实例各自解析，内存随通道数线性增长）。 */
  private async ensureBank(entry: SoundFontChannel, libraryId: string, buffer: ArrayBuffer): Promise<void> {
    if (entry.banks.has(libraryId)) return;
    await entry.host.ensureBank(libraryId, buffer);
    entry.banks.add(libraryId);
    this.bankReady.add(libraryId);
  }

  /** 注册/加载一个 SoundFont 库（字节缓存；bank 实际在首个音符时按通道实例加载）。 */
  async loadSoundFont(libraryId: string, path: string, fetchBytes: (path: string) => Promise<ArrayBuffer>): Promise<boolean> {
    const context = await this.ensureContext();
    await context.resume();
    if (!this.buffers.has(libraryId)) {
      const buffer = await fetchBytes(path);
      this.buffers.set(libraryId, buffer);
    }
    return true;
  }

  hasSoundFontBank(libraryId: string): boolean {
    return this.buffers.has(libraryId);
  }

  /** 注册一个 SFZ 库（幂等）。采样按需通过 fetchBytes 懒解码。 */
  async loadSfz(libraryId: string, regions: SfzRegion[], fetchBytes: (path: string) => Promise<ArrayBuffer>): Promise<void> {
    const context = await this.ensureContext();
    await context.resume();
    this.sfzEngine?.load(libraryId, regions, fetchBytes);
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
    /** 音符级 MIDI 属性（SFZ 全覆盖；SoundFont 取 pan/cutoff/resonance，微调/释放受库限制）。 */
    params?: SfzNoteParams;
  }): Promise<void> {
    const context = await this.ensureContext();
    await context.resume();
    if (options.soundFont) {
      const entry = await this.ensureSoundFontChannel(options.channel);
      const buffer = this.buffers.get(options.soundFont.libraryId);
      if (buffer) {
        try {
          await this.ensureBank(entry, options.soundFont.libraryId, buffer);
        } catch {
          // bank 解析失败则静默跳过。
        }
      }
      if (entry.banks.has(options.soundFont.libraryId)) {
        entry.host.noteOn(0, options.note, options.velocity, options.soundFont.bank, options.soundFont.program);
        this.applyChannelParams(entry, options.params);
      }
      return;
    }
    if (options.sfz && this.sfzEngine) {
      await this.sfzEngine.noteOn(options.channel, options.note, options.velocity, options.sfz.libraryId, options.params);
      return;
    }
    if (options.oscillator === false) return;
    this.noteOnOscillator(context, options.channel, options.note, options.velocity, options.volume, options.params);
  }

  /** 把音符级属性写入该通道合成器输出链（重叠音符后音覆盖；释放/微调受库限制）。 */
  private applyChannelParams(entry: SoundFontChannel, params?: SfzNoteParams): void {
    entry.pan.pan.value = Math.max(-1, Math.min(1, (params?.pan ?? 0) / 100));
    const cutoff = params?.cutoffHz && params.cutoffHz > 0 ? params.cutoffHz : undefined;
    entry.filter.type = "lowpass";
    entry.filter.frequency.value = cutoff ?? 24_000;
    entry.filter.Q.value = cutoff !== undefined ? (params?.resonanceQ ?? 0.5) : 0.5;
  }

  /** 释放音符（统一路由：SoundFont / SFZ / 振荡器各自释放，未活动时 no-op）。 */
  noteOff(channel: number, note: number): void {
    this.sfChannels.get(channel)?.host.noteOff(0, note);
    this.sfzEngine?.noteOff(channel, note);
    const key = `${channel}:${note}`;
    const entry = this.activeOscillators.get(key);
    if (entry) {
      this.releaseOscillator(entry);
      this.activeOscillators.delete(key);
    }
  }

  stopAll(): void {
    for (const entry of this.sfChannels.values()) entry.host.stopAll();
    this.sfzEngine?.stopAll();
    for (const entry of this.activeOscillators.values()) this.releaseOscillator(entry, 0.01);
    this.activeOscillators.clear();
  }

  /** 设置控制器值（CC）：SFZ 维护 CC 状态；SoundFont 通道实例转发 CC64（延音）并把 CC10/71/74 写入参数链。 */
  setCC(channel: number, controller: number, value: number): void {
    const entry = this.sfChannels.get(channel);
    if (entry) {
      entry.host.controllerChange(0, controller, value);
      if (controller === 10) entry.pan.pan.value = Math.max(-1, Math.min(1, (value - 64) / 64));
      else if (controller === 74) entry.filter.frequency.value = 200 * Math.pow(100, value / 127);
      else if (controller === 71) entry.filter.Q.value = 0.5 + (value / 127) * 16;
    }
    this.sfzEngine?.setCC(channel, controller, value);
  }

  /** 设置弯音值（-8192..8191）：SFZ 引擎生效；SoundFont 合成器库无弯音 API（0xE0 仅保留事件）。 */
  setPitchBend(channel: number, value: number): void {
    this.sfzEngine?.setPitchBend(channel, value);
  }

  private noteOnOscillator(
    context: AudioContext,
    channel: number,
    note: number,
    velocity: number,
    volume: number,
    params?: SfzNoteParams,
  ): void {
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
    const semitones = (params?.finePitchCents ?? 0) / 100;
    source.frequency.value = 440 * 2 ** ((note - 69 + semitones) / 12);
    const now = context.currentTime;
    const level = (velocity / 127) * Math.max(0, Math.min(1, volume)) * 0.05;
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.001, level), now + 0.006);
    let output: AudioNode = gainNode;
    let panNode: StereoPannerNode | undefined;
    if (params?.pan) {
      panNode = context.createStereoPanner();
      panNode.pan.value = Math.max(-1, Math.min(1, params.pan / 100));
      gainNode.connect(panNode);
      output = panNode;
    }
    source.connect(gainNode);
    output.connect(context.destination);
    source.start(now);
    this.activeOscillators.set(key, { source, gain: gainNode, pan: panNode });
  }

  private releaseOscillator(entry: { source: OscillatorNode; gain: GainNode; pan?: StereoPannerNode }, releaseSeconds = 0.06): void {
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
    for (const entry of this.sfChannels.values()) entry.host.stopAll();
    this.sfChannels.clear();
    this.sfzEngine?.dispose();
    for (const entry of this.activeOscillators.values()) this.releaseOscillator(entry, 0.01);
    this.activeOscillators.clear();
    this.context?.close().catch(() => undefined);
    this.context = null;
    this.sfzEngine = null;
    this.buffers.clear();
    this.bankReady.clear();
  }
}

export { WorkletSynthesizer };