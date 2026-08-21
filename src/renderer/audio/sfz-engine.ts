import { pickSfzRegions, selectSfzRegions } from "../../core/audio/sfz-parser.js";
import type { SfzRegion } from "../../shared/instrument.js";

/** 将 SFZ 滤波器类型映射到 Web Audio BiquadFilterType（bandreject → notch）。 */
function toBiquadType(type: SfzRegion["filterType"]): BiquadFilterType {
  return type === "bandreject" ? "notch" : (type ?? "lowpass");
}

/**
 * SFZ 采样引擎：按 libraryId 缓存采样解码，按键区/力度区命中区域发声。
 * 支持真正的 noteOn / noteOff 延音：noteOn 进入 ADSR 的 attack→decay→sustain 保持，
 * noteOff 时才进入 release；暂停/停止用 stopAll 立即切断。
 * 支持 A（delay/keytrack/pitchOffset）、B（滤波器）、C（seq 轮换/random/trigger 选择）。
 */
export class SfzEngine {
  private readonly libraries = new Map<string, LoadedSfzLibrary>();
  /** 活动音符：`channel:note` → 该键上仍按住的发声（支持重叠，noteOff 释放最近一次）。 */
  private readonly active = new Map<string, ActiveNote[]>();
  /** 分组轮换触发计数（按 note，供 seq_length/seq_position 选择）。 */
  private readonly seqCounts = new Map<number, number>();

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
    const matched = pickSfzRegions(library.regions, note, velocity, "attack", { seqCounts: this.seqCounts }, Math.random);
    if (matched.length === 0) return;
    const now = this.context.currentTime;
    const items: ActiveSource[] = [];
    let releaseSeconds = 0.1;
    for (const region of matched) {
      let buffer: AudioBuffer;
      try {
        buffer = await library.ensureSample(this.context, region.samplePath);
      } catch {
        continue;
      }
      const item = this.startSustainedSource(region, buffer, note, velocity, now);
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
      this.release(entry);
    }
    this.playReleaseTrigger(note);
  }

  /** release 触发采样（trigger=release 区域）：noteOff 时短促播放，不登记延音。 */
  private playReleaseTrigger(note: number): void {
    const now = this.context.currentTime;
    for (const library of this.libraries.values()) {
      const matched = pickSfzRegions(library.regions, note, 100, "release", { seqCounts: this.seqCounts }, Math.random);
      for (const region of matched) {
        void (async () => {
          try {
            const buffer = await library.ensureSample(this.context, region.samplePath);
            this.startShortSource(region, buffer, note, 100, now);
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
          try {
            item.source.stop();
          } catch {
            // 已结束的节点忽略。
          }
        }
      }
    }
    this.active.clear();
    this.seqCounts.clear();
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
  ): ActiveSource | null {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    // A：keytrack（键跟随）/ pitchOffset（半音）与 tuning 一同修正音高。
    const keytrack = region.keytrack ?? 100;
    const semitones = (note - region.keyCenter) * (keytrack / 100) + region.tuning / 100 + (region.pitchOffset ?? 0);
    source.playbackRate.value = 2 ** (semitones / 12);
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
    // A：触发延迟。
    const startAt = now + (region.delay ?? 0);

    const gainNode = this.context.createGain();

    // 力度 → 音量（amp_veltrack，默认 100=力度完全决定；0=力度不影响）。
    const vel = Math.max(0, Math.min(1, velocity / 127));
    let velocityFactor = vel;
    const veltrack = region.ampVelTrack;
    if (veltrack !== undefined && veltrack !== 100) {
      const t = Math.max(0, Math.min(100, veltrack)) / 100;
      velocityFactor = t * vel + (1 - t);
    }
    const peak = Math.pow(10, region.volume / 20) * velocityFactor;

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

    // B：滤波器（source → BiquadFilter → gain）。
    let chain: AudioNode = source;
    if (region.filterType && region.cutoffHz) {
      const filter = this.context.createBiquadFilter();
      filter.type = toBiquadType(region.filterType);
      filter.frequency.value = region.cutoffHz;
      if (region.resonanceQ) filter.Q.value = region.resonanceQ;
      source.connect(filter);
      chain = filter;
    }

    let output: AudioNode = gainNode;
    if (region.pan !== 0) {
      const panner = this.context.createStereoPanner();
      panner.pan.value = region.pan / 100;
      gainNode.connect(panner);
      output = panner;
    }
    chain.connect(gainNode);
    output.connect(this.context.destination);

    source.start(startAt, offsetSec, playDuration);
    return { source, gain: gainNode };
  }

  /** 让一组 source 进入 release（从当前 sustain 电平指数衰减到静音）。 */
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
      try {
        item.source.stop(end + 0.05);
      } catch {
        // 已结束。
      }
    }
  }
}

interface ActiveSource {
  source: AudioBufferSourceNode;
  gain: GainNode;
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