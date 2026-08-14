import { selectSfzRegions } from "../../core/audio/sfz-parser.js";
import type { SfzRegion } from "../../shared/instrument.js";

/**
 * SFZ 采样引擎：按 libraryId 缓存采样解码，按键区/力度区命中区域发声。
 * 与 SoundFontSynthHost 类似，作为 AudioEngine 的宿主组件存在；
 * 采样解码走 Chromium 内置 decodeAudioData（WAV/FLAC/OGG）。
 */
export class SfzEngine {
  private readonly libraries = new Map<string, LoadedSfzLibrary>();
  private readonly sources = new Set<AudioBufferSourceNode>();

  constructor(private readonly context: AudioContext) {}

  /** 注册一个 SFZ 库（幂等）。采样按需懒解码。 */
  load(libraryId: string, regions: SfzRegion[], fetchSample: (path: string) => Promise<ArrayBuffer>): void {
    if (this.libraries.has(libraryId)) return;
    this.libraries.set(libraryId, new LoadedSfzLibrary(regions, fetchSample));
  }

  has(libraryId: string): boolean {
    return this.libraries.has(libraryId);
  }

  /** 按音符与力度触发命中区域（支持力度分层）。无命中或采样缺失时静默。 */
  async play(libraryId: string, note: number, velocity: number, durationMs: number): Promise<void> {
    const library = this.libraries.get(libraryId);
    if (!library) return;
    const matched = selectSfzRegions(library.regions, note, velocity);
    if (matched.length === 0) return;
    const now = this.context.currentTime;
    for (const region of matched) {
      let buffer: AudioBuffer;
      try {
        buffer = await library.ensureSample(this.context, region.samplePath);
      } catch {
        continue;
      }
      this.triggerSource(region, buffer, note, velocity, durationMs, now);
    }
  }

  stopAll(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        // 已结束的节点忽略。
      }
    }
    this.sources.clear();
  }

  dispose(): void {
    this.stopAll();
    this.libraries.clear();
  }

  private triggerSource(
    region: SfzRegion,
    buffer: AudioBuffer,
    note: number,
    velocity: number,
    durationMs: number,
    now: number,
  ): void {
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = 2 ** ((note - region.keyCenter + region.tuning / 100) / 12);
    if ((region.loopMode === "continuous" || region.loopMode === "sustain")
      && region.loopStart !== undefined && region.loopEnd !== undefined && region.loopEnd > region.loopStart) {
      source.loop = true;
      source.loopStart = region.loopStart / buffer.sampleRate;
      source.loopEnd = region.loopEnd / buffer.sampleRate;
    }

    const gainNode = this.context.createGain();
    const level = Math.pow(10, region.volume / 20) * Math.max(0, Math.min(1, velocity / 127));
    const attack = region.attack ?? 0.005;
    const release = region.release ?? 0.1;
    gainNode.gain.setValueAtTime(0.0001, now);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(0.001, level), now + attack);

    let output: AudioNode = gainNode;
    if (region.pan !== 0) {
      const panner = this.context.createStereoPanner();
      panner.pan.value = region.pan / 100;
      gainNode.connect(panner);
      output = panner;
    }
    source.connect(gainNode);
    output.connect(this.context.destination);

    const stopAt = now + Math.max(0.02, durationMs / 1000);
    const releaseStart = Math.max(now + attack + 0.005, stopAt - release);
    if (releaseStart >= stopAt) {
      gainNode.gain.setValueAtTime(Math.max(0.001, level), stopAt);
    } else {
      gainNode.gain.setValueAtTime(Math.max(0.001, level), releaseStart);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, stopAt);
    }
    source.start(now);
    source.stop(stopAt + 0.05);

    this.sources.add(source);
    source.onended = () => this.sources.delete(source);
  }
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
