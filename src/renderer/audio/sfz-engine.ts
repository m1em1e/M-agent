import { nextKeyswitchState, pickSfzRegions, pickSfzRegionsWithGain, sampleVelCurve, selectSfzRegions } from "../../core/audio/sfz-parser.js";
import type { SfzRegion } from "../../shared/instrument.js";

/** 将 SFZ 滤波器类型映射到 Web Audio BiquadFilterType（bandreject → notch）。 */
function toBiquadType(type: SfzRegion["filterType"]): BiquadFilterType {
  return type === "bandreject" ? "notch" : (type ?? "lowpass");
}

/** 配置 LFO 振荡器：非 sine 用 type；sine 且指定 phase 用 PeriodicWave 从该相位起振。 */
function configureLfo(context: AudioContext, osc: OscillatorNode, shape: OscillatorType | undefined, phaseDeg: number | undefined): void {
  if (shape && shape !== "sine") {
    osc.type = shape;
    return;
  }
  if (phaseDeg === undefined) {
    osc.type = "sine";
    return;
  }
  const rad = (phaseDeg * Math.PI) / 180;
  const real = new Float32Array([0, Math.sin(rad)]);
  const imag = new Float32Array([0, Math.cos(rad)]);
  osc.setPeriodicWave(context.createPeriodicWave(real, imag));
}

/**
 * SFZ 采样引擎：按 libraryId 缓存采样解码，按键区/力度区命中区域发声。
 * 支持真正的 noteOn / noteOff 延音：noteOn 进入 ADSR 的 attack→decay→sustain 保持，
 * noteOff 时才进入 release；暂停/停止用 stopAll 立即切断。
 * 支持 A（delay/keytrack/pitchOffset）、B（滤波器）、C（seq 轮换/random/trigger 选择）、
 * D（keyswitch）、F（LFO 调制 / pitch 包络）。
 */
export class SfzEngine {
  private readonly libraries = new Map<string, LoadedSfzLibrary>();
  /** 活动音符：`channel:note` → 该键上仍按住的发声（支持重叠，noteOff 释放最近一次）。 */
  private readonly active = new Map<string, ActiveNote[]>();
  /** 分组轮换触发计数（按 note，供 seq_length/seq_position 选择）。 */
  private readonly seqCounts = new Map<number, number>();
  /** keyswitch 状态机（按 libraryId）。 */
  private readonly keyswitchStates = new Map<string, { activeKey?: number; previousKey?: number; last?: boolean }>();
  /** CC 状态：channel → controller → value。 */
  private readonly ccState = new Map<number, Map<number, number>>();
  /** CC64 踏板延音中（尚未松踏板）的音符：channel → ActiveNote[]。 */
  private readonly heldNotes = new Map<number, ActiveNote[]>();

  constructor(private readonly context: AudioContext) {}

  /** 注册一个 SFZ 库（幂等）。采样按需懒解码。 */
  load(libraryId: string, regions: SfzRegion[], fetchSample: (path: string) => Promise<ArrayBuffer>): void {
    if (this.libraries.has(libraryId)) return;
    this.libraries.set(libraryId, new LoadedSfzLibrary(regions, fetchSample));
  }

  has(libraryId: string): boolean {
    return this.libraries.has(libraryId);
  }

  /** 触发音符并保持（sustain），直到 noteOff 才释放。无命中或采样缺失时静默。 */
  async noteOn(channel: number, note: number, velocity: number, libraryId: string): Promise<void> {
    const library = this.libraries.get(libraryId);
    if (!library) return;
    // D：keyswitch —— 若该 note 命中某区域 sw 区间，则更新该库的 keyswitch 状态机。
    const ksState = nextKeyswitchState(this.keyswitchStates.get(libraryId), note, library.regions);
    if (ksState) this.keyswitchStates.set(libraryId, ksState);
    const keyswitch = this.keyswitchStates.get(libraryId)?.activeKey;
    // trigger 补全：同 channel 已有活动音符 → legato。
    const legato = this.hasActiveNoteOnChannel(channel);
    const getCC = (controller: number) => this.getCC(channel, controller);
    const matched = pickSfzRegionsWithGain(library.regions, note, velocity, "attack", { seqCounts: this.seqCounts }, Math.random, keyswitch, legato, getCC);
    if (matched.length === 0) return;
    const now = this.context.currentTime;
    const items: ActiveSource[] = [];
    let releaseSeconds = 0.1;
    for (const { region, gain } of matched) {
      let buffer: AudioBuffer;
      try {
        buffer = await library.ensureSample(this.context, region.samplePath);
      } catch {
        continue;
      }
      const item = this.startSustainedSource(region, buffer, note, velocity, now, gain);
      if (item) {
        items.push(item);
        releaseSeconds = Math.max(releaseSeconds, region.release ?? 0.1);
      }
    }
    if (items.length === 0) return;
    const key = `${channel}:${note}`;
    const list = this.active.get(key) ?? [];
    list.push({ items, releaseSeconds, startedAt: now });
    this.active.set(key, list);
  }

  /** 释放指定键最近一次按住的音符（进入 release），并触发 release 采样的短促播放。无活动音符时仅播 release 层。 */
  noteOff(channel: number, note: number): void {
    const key = `${channel}:${note}`;
    const list = this.active.get(key);
    if (list && list.length > 0) {
      const entry = list.pop()!;
      if (list.length === 0) this.active.delete(key);
      // CC64 踏板按住时延音：进入 held，松踏板时统一 release。
      if (this.getCC(channel, 64) > 63) {
        const held = this.heldNotes.get(channel) ?? [];
        held.push(entry);
        this.heldNotes.set(channel, held);
      } else {
        this.release(entry);
      }
    }
    // keyswitch：若释放的是某库当前激活键且该库 sw_last=0 → 回退默认。
    for (const [libraryId, state] of this.keyswitchStates) {
      if (state.activeKey === note && state.last === false) {
        this.keyswitchStates.set(libraryId, { ...state, activeKey: undefined });
      }
    }
    this.playReleaseTrigger(note);
  }

  /** 读取当前 CC 值（未设置默认 64）。 */
  getCC(channel: number, controller: number): number {
    return this.ccState.get(channel)?.get(controller) ?? 64;
  }

  /** 设置控制器值：CC64 从按住变松开时释放延音中的音符。 */
  setCC(channel: number, controller: number, value: number): void {
    let map = this.ccState.get(channel);
    if (!map) {
      map = new Map();
      this.ccState.set(channel, map);
    }
    const wasDown = (map.get(64) ?? 0) > 63;
    map.set(controller, value);
    if (controller === 64 && wasDown && value <= 63) {
      const held = this.heldNotes.get(channel);
      if (held) {
        this.heldNotes.delete(channel);
        for (const entry of held) this.release(entry);
      }
    }
  }

  /** 指定 channel 是否已有活动音符（用于 legato 触发判断）。 */
  private hasActiveNoteOnChannel(channel: number): boolean {
    const prefix = `${channel}:`;
    for (const key of this.active.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }

  /** release 触发采样（trigger=release 区域）：noteOff 时短促播放（按 release_time 延迟），不登记延音。 */
  private playReleaseTrigger(note: number): void {
    const now = this.context.currentTime;
    for (const library of this.libraries.values()) {
      const matched = pickSfzRegions(library.regions, note, 100, "release", { seqCounts: this.seqCounts }, Math.random, undefined, false, (c) => this.getCC(0, c));
      for (const region of matched) {
        void (async () => {
          try {
            const buffer = await library.ensureSample(this.context, region.samplePath);
            this.startShortSource(region, buffer, note, 100, now + (region.releaseTime ?? 0));
          } catch {
            // 采样缺失忽略。
          }
        })();
      }
    }
  }

  /** 短促一次性播放（release 采样用）：按采样长度自然衰减，不进入延音登记。 */
  private startShortSource(region: SfzRegion, buffer: AudioBuffer, note: number, velocity: number, now: number): void {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    const keytrack = region.keytrack ?? 100;
    const semitones = (note - region.keyCenter) * (keytrack / 100) + region.tuning / 100 + (region.pitchOffset ?? 0);
    source.playbackRate.value = 2 ** (semitones / 12);
    const offsetSec = region.offset !== undefined ? region.offset / buffer.sampleRate : 0;
    const endSec = region.end !== undefined ? region.end / buffer.sampleRate : buffer.duration;
    const playDuration = Math.max(0.001, endSec - offsetSec);
    const gainNode = this.context.createGain();
    const peak = Math.pow(10, region.volume / 20) * Math.max(0, Math.min(1, velocity / 127));
    const attack = region.attack ?? 0.005;
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), now + attack);
    let chain: AudioNode = source;
    if (region.filterType && region.cutoffHz) {
      const filter = this.context.createBiquadFilter();
      filter.type = toBiquadType(region.filterType);
      filter.frequency.value = region.cutoffHz;
      if (region.resonanceQ) filter.Q.value = region.resonanceQ;
      source.connect(filter);
      chain = filter;
    }
    chain.connect(gainNode).connect(this.context.destination);
    source.start(now + (region.delay ?? 0), offsetSec, playDuration);
    source.stop(now + (region.delay ?? 0) + playDuration + 0.05);
  }

  stopAll(): void {
    for (const list of this.active.values()) {
      for (const entry of list) {
        for (const item of entry.items) {
          stopItem(item);
        }
      }
    }
    this.active.clear();
    this.seqCounts.clear();
    this.keyswitchStates.clear();
    this.ccState.clear();
    this.heldNotes.clear();
  }

  dispose(): void {
    this.stopAll();
    this.libraries.clear();
  }

  /** 创建持续发声的 source：ADSR attack→decay→sustain 保持（不自动 release）。 */
  private startSustainedSource(
    region: SfzRegion,
    buffer: AudioBuffer,
    note: number,
    velocity: number,
    now: number,
    crossfadeGain = 1,
  ): ActiveSource | null {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    // A：触发延迟（供所有调度共用）。
    const startAt = now + (region.delay ?? 0);
    // A：keytrack（键跟随）/ pitchOffset（半音）与 tuning 一同修正音高。
    const keytrack = region.keytrack ?? 100;
    const velocityOffset = (velocity - 64) / 63;
    const semitones = (note - region.keyCenter) * (keytrack / 100) + region.tuning / 100 + (region.pitchOffset ?? 0)
      + (region.pitchVelTrack ?? 0) * velocityOffset;
    const baseRate = 2 ** (semitones / 12);
    source.playbackRate.setValueAtTime(baseRate, startAt);
    if ((region.loopMode === "continuous" || region.loopMode === "sustain")
      && region.loopStart !== undefined && region.loopEnd !== undefined && region.loopEnd > region.loopStart) {
      source.loop = true;
      source.loopStart = region.loopStart / buffer.sampleRate;
      source.loopEnd = region.loopEnd / buffer.sampleRate;
    }

    // 采样 offset/end 截取（sample 帧 → 秒）。
    const offsetSec = region.offset !== undefined ? region.offset / buffer.sampleRate : 0;
    const endSec = region.end !== undefined ? region.end / buffer.sampleRate : buffer.duration;
    const playDuration = Math.max(0.001, endSec - offsetSec);

    const gainNode = this.context.createGain();

    // 力度 → 音量：优先用 amp_velcurve 曲线插值，否则 amp_veltrack（默认 100=力度完全决定；0=力度不影响）。
    const vel = Math.max(0, Math.min(1, velocity / 127));
    let velocityFactor = sampleVelCurve(region.velCurve, velocity) ?? vel;
    const veltrack = region.ampVelTrack;
    if (veltrack !== undefined && veltrack !== 100) {
      const t = Math.max(0, Math.min(100, veltrack)) / 100;
      velocityFactor = t * velocityFactor + (1 - t);
    }
    const peak = Math.pow(10, region.volume / 20) * velocityFactor * Math.max(0, Math.min(1, crossfadeGain));

    // ADSR：attack→decay→sustain 保持（release 由 noteOff 触发）。
    const attack = region.attack ?? 0.005;
    const decay = region.decay ?? 0;
    const sustainLevel = region.sustain !== undefined ? Math.max(0, region.sustain) / 100 : 1;
    const sustainGain = Math.max(0.0005, peak * sustainLevel);

    gainNode.gain.setValueAtTime(0.0001, startAt);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), startAt + attack);
    if (decay > 0) {
      gainNode.gain.exponentialRampToValueAtTime(sustainGain, startAt + attack + decay);
    }

    // F：调制 —— pitch LFO（颤音）叠加到 playbackRate。
    let lfos: Array<{ osc: OscillatorNode; gain: GainNode }> = [];
    if (region.pitchLfoFreq && region.pitchLfoDepth) {
      const osc = this.context.createOscillator();
      configureLfo(this.context, osc, region.pitchLfoShape, region.pitchLfoPhase);
      osc.frequency.value = region.pitchLfoFreq;
      const depth = this.context.createGain();
      depth.gain.value = baseRate * (2 ** (region.pitchLfoDepth / 1200) - 1);
      osc.connect(depth).connect(source.playbackRate);
      osc.start(startAt + (region.pitchLfoDelay ?? 0));
      lfos.push({ osc, gain: depth });
    }
    // F：pitch 包络 —— 对 playbackRate 调度 attack→decay→sustain 电平。
    if (region.pitchEnvDepth !== undefined && region.pitchEnvDepth !== 0) {
      const envRate = baseRate * (2 ** (region.pitchEnvDepth / 1200) - 1);
      const envAttack = region.pitchEnvAttack ?? 0.005;
      const envDecay = region.pitchEnvDecay ?? 0;
      const envSustain = region.pitchEnvSustain !== undefined ? Math.max(0, region.pitchEnvSustain) / 100 : 0;
      const rate = source.playbackRate;
      rate.cancelScheduledValues(startAt);
      rate.setValueAtTime(baseRate, startAt);
      rate.linearRampToValueAtTime(baseRate + envRate, startAt + envAttack);
      if (envDecay > 0) {
        rate.linearRampToValueAtTime(baseRate + envRate * envSustain, startAt + envAttack + envDecay);
      }
    }

    // B：滤波器（source → BiquadFilter → gain）+ 滤波包络（fil_env 对 frequency 调度）。
    let chain: AudioNode = source;
    let filterEnvelope: { filter: BiquadFilterNode; baseFreq: number } | undefined;
    if (region.filterType && region.cutoffHz) {
      const filter = this.context.createBiquadFilter();
      filter.type = toBiquadType(region.filterType);
      // cutoff_veltrack：力度调制截止频率。
      const cutoffOffset = (region.cutoffVelTrack ?? 0) * ((velocity - 64) / 63);
      filter.frequency.value = region.cutoffHz + cutoffOffset;
      if (region.resonanceQ) filter.Q.value = region.resonanceQ;
      if (region.filEnvDepth !== undefined && region.filEnvDepth !== 0) {
        const baseFreq = region.cutoffHz + cutoffOffset;
        const peakFreq = baseFreq * 2 ** (region.filEnvDepth / 1200);
        const envAttack = region.filEnvAttack ?? 0.005;
        const envDecay = region.filEnvDecay ?? 0;
        const envSustain = region.filEnvSustain !== undefined ? Math.max(0, region.filEnvSustain) / 100 : 0;
        filter.frequency.cancelScheduledValues(startAt);
        filter.frequency.setValueAtTime(baseFreq, startAt);
        filter.frequency.exponentialRampToValueAtTime(Math.max(1, peakFreq), startAt + envAttack);
        if (envDecay > 0) {
          filter.frequency.exponentialRampToValueAtTime(Math.max(1, baseFreq + (peakFreq - baseFreq) * envSustain), startAt + envAttack + envDecay);
        }
        filterEnvelope = { filter, baseFreq };
      }
      source.connect(filter);
      chain = filter;
    }

    let output: AudioNode = gainNode;
    if (region.pan !== 0 || (region.panLfoFreq && region.panLfoDepth) || (region.panVelTrack && region.panVelTrack !== 0)) {
      const panner = this.context.createStereoPanner();
      // pan_veltrack：力度调制声像。
      panner.pan.value = region.pan / 100 + ((region.panVelTrack ?? 0) / 100) * ((velocity - 64) / 63);
      // F：pan LFO 叠加到 panner.pan。
      if (region.panLfoFreq && region.panLfoDepth) {
        const osc = this.context.createOscillator();
        configureLfo(this.context, osc, region.panLfoShape, region.panLfoPhase);
        osc.frequency.value = region.panLfoFreq;
        const depth = this.context.createGain();
        depth.gain.value = region.panLfoDepth / 100;
        osc.connect(depth).connect(panner.pan);
        osc.start(startAt + (region.panLfoDelay ?? 0));
        lfos.push({ osc, gain: depth });
      }
      gainNode.connect(panner);
      output = panner;
    }
    // F：amp LFO 叠加到 gainNode.gain。
    if (region.ampLfoFreq && region.ampLfoDepth) {
      const osc = this.context.createOscillator();
      configureLfo(this.context, osc, region.ampLfoShape, region.ampLfoPhase);
      osc.frequency.value = region.ampLfoFreq;
      const depth = this.context.createGain();
      depth.gain.value = region.ampLfoDepth / 100;
      osc.connect(depth).connect(gainNode.gain);
      osc.start(startAt + (region.ampLfoDelay ?? 0));
      lfos.push({ osc, gain: depth });
    }
    chain.connect(gainNode);
    output.connect(this.context.destination);

    source.start(startAt, offsetSec, playDuration);
    return { source, gain: gainNode, lfos, filterEnvelope };
  }

  /** 让一组 source 进入 release（从当前 sustain 电平指数衰减到静音，滤波截止回落到 base）。 */
  private release(entry: ActiveNote): void {
    const now = this.context.currentTime;
    const end = now + Math.max(0.01, entry.releaseSeconds);
    for (const item of entry.items) {
      item.gain.gain.cancelScheduledValues(now);
      try {
        item.gain.gain.setValueAtTime(item.gain.gain.value, now);
        item.gain.gain.exponentialRampToValueAtTime(0.0001, end);
      } catch {
        // 忽略调度异常（增益已为 0 等）。
      }
      if (item.filterEnvelope) {
        try {
          item.filterEnvelope.filter.frequency.cancelScheduledValues(now);
          item.filterEnvelope.filter.frequency.setValueAtTime(item.filterEnvelope.baseFreq, now);
        } catch {
          // 忽略。
        }
      }
      for (const lfo of item.lfos ?? []) {
        try {
          lfo.osc.stop(end + 0.05);
        } catch {
          // 已结束。
        }
      }
      try {
        item.source.stop(end + 0.05);
      } catch {
        // 已结束。
      }
    }
  }
}

/** 立即停止单个发声及其调制 LFO。 */
function stopItem(item: ActiveSource): void {
  for (const lfo of item.lfos ?? []) {
    try {
      lfo.osc.stop();
    } catch {
      // 已结束。
    }
  }
  try {
    item.source.stop();
  } catch {
    // 已结束。
  }
}

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
  /** 调制 LFO（stop 时需一并停止）。 */
  lfos?: Array<{ osc: OscillatorNode; gain: GainNode }>;
  /** 滤波包络（noteOff 时把截止频率回落到 baseFreq）。 */
  filterEnvelope?: { filter: BiquadFilterNode; baseFreq: number };
}

interface ActiveNote {
  items: ActiveSource[];
  releaseSeconds: number;
  startedAt: number;
}

class LoadedSfzLibrary {
  private readonly samples = new Map<string, Promise<AudioBuffer>>();

  constructor(
    readonly regions: SfzRegion[],
    private readonly fetchSample: (path: string) => Promise<ArrayBuffer>,
  ) {}

  ensureSample(context: AudioContext, path: string): Promise<AudioBuffer> {
    const cached = this.samples.get(path);
    if (cached) return cached;
    const promise = (async () => {
      const bytes = await this.fetchSample(path);
      return context.decodeAudioData(bytes);
    })().catch((error) => {
      this.samples.delete(path);
      throw error;
    });
    this.samples.set(path, promise);
    return promise;
  }
}