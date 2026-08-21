import { selectSfzRegions } from "../../core/audio/sfz-parser.js";
import type { SfzRegion } from "../../shared/instrument.js";

/**
 * SFZ 采样引擎：按 libraryId 缓存采样解码，按键区/力度区命中区域发声。
 * 支持真正的 noteOn / noteOff 延音：noteOn 进入 ADSR 的 attack→decay→sustain 保持，
 * noteOff 时才进入 release；暂停/停止用 stopAll 立即切断。
 */
export class SfzEngine {
  private readonly libraries = new Map<string, LoadedSfzLibrary>();
  /** 活动音符：`channel:note` → 该键上仍按住的发声（支持重叠，noteOff 释放最近一次）。 */
  private readonly active = new Map<string, ActiveNote[]>();

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
    const matched = selectSfzRegions(library.regions, note, velocity);
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

  /** 释放指定键最近一次按住的音符（进入 release）。无活动音符时 no-op。 */
  noteOff(channel: number, note: number): void {
    const key = `${channel}:${note}`;
    const list = this.active.get(key);
    if (!list || list.length === 0) return;
    const entry = list.pop()!;
    if (list.length === 0) this.active.delete(key);
    this.release(entry);
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
    source.playbackRate.value = 2 ** ((note - region.keyCenter + region.tuning / 100) / 12);
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

    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), now + attack);
    if (decay > 0) {
      gainNode.gain.exponentialRampToValueAtTime(sustainGain, now + attack + decay);
    }

    let output: AudioNode = gainNode;
    if (region.pan !== 0) {
      const panner = this.context.createStereoPanner();
      panner.pan.value = region.pan / 100;
      gainNode.connect(panner);
      output = panner;
    }
    source.connect(gainNode);
    output.connect(this.context.destination);

    source.start(now, offsetSec, playDuration);
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