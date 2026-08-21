import { WorkletSynthesizer, audioBufferToWav } from "spessasynth_lib";
import { BasicMIDI } from "spessasynth_core";
import { createOggEncoder } from "wasm-media-encoders";
import { exportMidi } from "../../core/midi/index.js";
import { selectSfzRegions } from "../../core/audio/sfz-parser.js";
import type { MidiNote, MidiProject, MidiTrack } from "../../shared/midi.js";
import type { SfzRegion } from "../../shared/instrument.js";

/** 导出音频格式。 */
export type ExportAudioFormat = "wav" | "ogg";

export interface RenderProjectOptions {
  /** 工程标题，用于 MIDI 子序列的元数据。 */
  title: string;
  tracks: MidiTrack[];
  ppq: number;
  /** 单一速度（与播放一致的 tick→秒换算）。 */
  tempo: number;
  sampleRate: number;
  /** 渲染时长上限（秒），超限抛 ExportTooLongError。 */
  maxSeconds: number;
  /** 按各轨循环区导出：有循环区的轨道从头播放、进入循环区后循环至曲末；无循环区轨道整轨导出。 */
  clipByTrackLoop?: boolean;
  /** 解析音源引用到可读取的条目（渲染进程内 findInstrumentEntry 逻辑）。 */
  resolveInstrument: (libraryId: string) => { path: string; enabled: boolean; sfzRegions?: SfzRegion[] } | undefined;
  /** 读取音源文件字节（SoundFont / SFZ 采样）。 */
  fetchBytes: (path: string) => Promise<ArrayBuffer>;
}

/** 渲染时长超过 maxSeconds 时抛出。 */
export class ExportTooLongError extends Error {
  constructor(seconds: number, maximumSeconds: number) {
    super(`导出时长 ${seconds.toFixed(1)} 秒超过上限 ${Math.round(maximumSeconds)} 秒。请缩短工程或在设置中提高渲染上限。`);
    this.name = "ExportTooLongError";
  }
}

/** 渲染/编码过程失败。 */
export class ExportRenderError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "ExportRenderError";
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** 最后一个音符结束后附加的释放/混响尾长（秒）。 */
export const RELEASE_TAIL_SECONDS = 2;

export function tickToSeconds(tick: number, ppq: number, tempo: number): number {
  return tick / ppq * 60 / tempo;
}

/**
 * 计算可听轨道（尊重 mute/solo）的最大音符末尾 tick；无音符为 0。
 */
export function computeAudibleEndTick(tracks: MidiTrack[]): number {
  const soloActive = tracks.some((track) => track.solo);
  let maxTick = 0;
  for (const track of tracks) {
    if (track.muted || (soloActive && !track.solo)) continue;
    for (const note of track.notes) {
      maxTick = Math.max(maxTick, note.startTick + note.durationTicks);
    }
  }
  return maxTick;
}

/** 由末尾 tick 推算导出总时长（秒），至少 1 秒。 */
export function exportDurationSeconds(endTick: number, ppq: number, tempo: number, tailSeconds = RELEASE_TAIL_SECONDS): number {
  return Math.max(1, tickToSeconds(endTick, ppq, tempo) + tailSeconds);
}

/**
 * 计算按各轨循环区导出时的末尾 tick：max(有循环区轨的循环区 endTick, 无循环区轨的笔记末尾)，
 * mute/solo 规则与 computeAudibleEndTick 一致。
 */
export function computeLoopEndTick(tracks: MidiTrack[]): number {
  const soloActive = tracks.some((track) => track.solo);
  let maxTick = 0;
  for (const track of tracks) {
    if (track.muted || (soloActive && !track.solo)) continue;
    if (track.loopRegion) {
      maxTick = Math.max(maxTick, track.loopRegion.endTick);
      continue;
    }
    for (const note of track.notes) {
      maxTick = Math.max(maxTick, note.startTick + note.durationTicks);
    }
  }
  return maxTick;
}

/**
 * 按播放语义展开轨道：丢弃循环区外的音符，循环区内的音符从循环区起点开始
 * 以周期（区间长度）重复，直到工程末尾 endTickTotal；循环区起点前保持静音。
 * 无循环区的轨道原样保留（整轨导出）。
 */
export function expandTracksByLoop(tracks: MidiTrack[], endTickTotal: number): MidiTrack[] {
  return tracks.map((track) => {
    const loop = track.loopRegion;
    if (!loop || loop.endTick <= loop.startTick) return track;
    const period = loop.endTick - loop.startTick;
    const inner = track.notes.flatMap((note) => {
      const start = Math.max(note.startTick, loop.startTick);
      const end = Math.min(note.startTick + note.durationTicks, loop.endTick);
      if (end <= start) return [];
      return [{ ...note, startTick: start, durationTicks: end - start }];
    });
    if (inner.length === 0) return { ...track, notes: [] };
    const notes: MidiNote[] = [];
    for (let offset = 0; loop.startTick + offset < endTickTotal; offset += period) {
      for (const note of inner) {
        notes.push({ ...note, id: `${note.id}-${offset}`, startTick: note.startTick + offset });
      }
    }
    return { ...track, notes };
  });
}

/**
 * 离线渲染工程为 AudioBuffer。SoundFont 轨道经 SpessaSynth 离线序列（startOfflineRender）
 * 按时间精确渲染；SFZ 采样与振荡器轨道用标准 Web Audio 节点按绝对时间排程；各层最后混音。
 */
export async function renderProjectToBuffer(options: RenderProjectOptions): Promise<AudioBuffer> {
  const { tracks, ppq, tempo, sampleRate, maxSeconds } = options;
  const loopEndTick = options.clipByTrackLoop ? computeLoopEndTick(tracks) : null;
  const renderTracks = loopEndTick !== null ? expandTracksByLoop(tracks, loopEndTick) : tracks;
  const endTick = loopEndTick ?? computeAudibleEndTick(tracks);
  const durationSeconds = exportDurationSeconds(endTick, ppq, tempo);
  if (durationSeconds > maxSeconds) throw new ExportTooLongError(durationSeconds, maxSeconds);
  const frames = Math.ceil(durationSeconds * sampleRate);

  const soundFontGroups = new Map<string, MidiTrack[]>();
  const sfzGroups = new Map<string, { tracks: MidiTrack[]; regions: SfzRegion[] }>();
  const plainTracks: MidiTrack[] = [];
  for (const track of renderTracks) {
    const instrument = track.instrument;
    if (instrument?.type === "soundfont") {
      const entry = options.resolveInstrument(instrument.libraryId);
      if (entry && entry.enabled) {
        const group = soundFontGroups.get(instrument.libraryId) ?? [];
        group.push(track);
        soundFontGroups.set(instrument.libraryId, group);
        continue;
      }
    }
    if (instrument?.type === "sfz") {
      const entry = options.resolveInstrument(instrument.libraryId);
      if (entry && entry.enabled && entry.sfzRegions && entry.sfzRegions.length > 0) {
        const group = sfzGroups.get(instrument.libraryId) ?? { tracks: [], regions: entry.sfzRegions };
        group.tracks.push(track);
        sfzGroups.set(instrument.libraryId, group);
        continue;
      }
    }
    plainTracks.push(track);
  }

  const layers: AudioBuffer[] = [];
  for (const [libraryId, groupTracks] of soundFontGroups) {
    const entry = options.resolveInstrument(libraryId);
    if (!entry) continue;
    const sfBytes = await options.fetchBytes(entry.path);
    const midiBytes = buildSoundFontSubsetMidi(groupTracks, options);
    layers.push(await renderSoundFontLayer(midiBytes, sfBytes, frames, sampleRate));
  }
  if (sfzGroups.size > 0 || plainTracks.length > 0) {
    layers.push(await renderPlainLayer(sfzGroups, plainTracks, frames, sampleRate, options));
  }
  if (layers.length === 0) return renderSilence(frames, sampleRate);
  if (layers.length === 1) return layers[0];
  return mixLayers(layers, frames, sampleRate);
}

/** 导出为 WAV / OGG 的字节（ArrayBuffer），供主进程落盘。 */
export async function encodeAudioBuffer(buffer: AudioBuffer, format: ExportAudioFormat): Promise<ArrayBuffer> {
  if (format === "wav") {
    const blob = audioBufferToWav(buffer, { normalizeAudio: false });
    return (await blob.arrayBuffer()) as ArrayBuffer;
  }
  try {
    const encoder = await createOggEncoder();
    encoder.configure({ sampleRate: buffer.sampleRate, channels: 2, vbrQuality: 3 });
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    const chunkSize = 32768;
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < left.length; offset += chunkSize) {
      const output = encoder.encode([left.subarray(offset, offset + chunkSize), right.subarray(offset, offset + chunkSize)]);
      if (output.length > 0) parts.push(new Uint8Array(output));
    }
    const tail = encoder.finalize();
    if (tail.length > 0) parts.push(new Uint8Array(tail));
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result.buffer as ArrayBuffer;
  } catch (error) {
    throw new ExportRenderError(`OGG 编码失败：${error instanceof Error ? error.message : String(error)}`, error);
  }
}

function buildSoundFontSubsetMidi(tracks: MidiTrack[], options: RenderProjectOptions): Uint8Array {
  const project: MidiProject = {
    id: "audio-export",
    title: options.title,
    ppq: options.ppq,
    tempoMap: [{ tick: 0, bpm: options.tempo }],
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    loopRegion: null,
    tracks: tracks.map((track) => ({
      ...track,
      notes: track.notes.map((note) => ({ ...note })),
    })),
    revisions: [],
    agentSessions: [],
  };
  return exportMidi(project, { format: 1 });
}

function workletProcessorUrl(): string {
  const pageUrl = new URL(window.location.href);
  if (pageUrl.protocol === "file:") {
    return new URL("spessasynth_processor.min.js", `${pageUrl.href.slice(0, pageUrl.href.lastIndexOf("/") + 1)}`).href;
  }
  return new URL("/spessasynth_processor.min.js", pageUrl).href;
}

async function renderSoundFontLayer(
  midiBytes: Uint8Array,
  soundFontBytes: ArrayBuffer,
  frames: number,
  sampleRate: number,
): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(2, frames, sampleRate);
  await context.audioWorklet.addModule(workletProcessorUrl());
  const synth = new WorkletSynthesizer(context);
  synth.connect(context.destination);
  await synth.isReady;
  const midi = BasicMIDI.fromArrayBuffer(
    midiBytes.buffer.slice(midiBytes.byteOffset, midiBytes.byteOffset + midiBytes.byteLength) as ArrayBuffer,
    "audio-export",
  );
  await synth.startOfflineRender({
    midiSequence: midi,
    soundBankList: [{ bankOffset: 0, soundBankBuffer: soundFontBytes }],
    loopCount: 0,
  });
  return context.startRendering();
}

interface SfzLayerGroup {
  tracks: MidiTrack[];
  regions: SfzRegion[];
}

async function renderPlainLayer(
  sfzGroups: Map<string, SfzLayerGroup>,
  plainTracks: MidiTrack[],
  frames: number,
  sampleRate: number,
  options: RenderProjectOptions,
): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(2, frames, sampleRate);
  for (const group of sfzGroups.values()) {
    const samples = new Map<string, Promise<AudioBuffer>>();
    const ensureSample = (path: string): Promise<AudioBuffer> => {
      const cached = samples.get(path);
      if (cached) return cached;
      const promise = (async () => {
        const bytes = await options.fetchBytes(path);
        return context.decodeAudioData(bytes);
      })().catch((error) => {
        samples.delete(path);
        throw error;
      });
      samples.set(path, promise);
      return promise;
    };
    for (const track of group.tracks) {
      for (const note of track.notes) {
        const startSec = tickToSeconds(note.startTick, options.ppq, options.tempo);
        const stopSec = startSec + tickToSeconds(note.durationTicks, options.ppq, options.tempo);
        for (const region of selectSfzRegions(group.regions, note.pitch, note.velocity)) {
          let buffer: AudioBuffer;
          try {
            buffer = await ensureSample(region.samplePath);
          } catch {
            continue;
          }
          scheduleSfzSource(context, region, buffer, note, startSec, stopSec, track.volume ?? 1);
        }
      }
    }
  }
  for (const track of plainTracks) {
    for (const note of track.notes) {
      const startSec = tickToSeconds(note.startTick, options.ppq, options.tempo);
      const stopSec = startSec + tickToSeconds(note.durationTicks, options.ppq, options.tempo);
      scheduleOscillator(context, note.pitch, note.velocity, track.volume ?? 1, startSec, stopSec);
    }
  }
  return context.startRendering();
}

function scheduleSfzSource(
  context: OfflineAudioContext,
  region: SfzRegion,
  buffer: AudioBuffer,
  note: { pitch: number; velocity: number },
  startSec: number,
  stopSec: number,
  volume: number,
): void {
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = 2 ** ((note.pitch - region.keyCenter + region.tuning / 100) / 12);
  if ((region.loopMode === "continuous" || region.loopMode === "sustain")
    && region.loopStart !== undefined && region.loopEnd !== undefined && region.loopEnd > region.loopStart) {
    source.loop = true;
    source.loopStart = region.loopStart / buffer.sampleRate;
    source.loopEnd = region.loopEnd / buffer.sampleRate;
  }
  const gainNode = context.createGain();
  // 力度 → 音量（amp_veltrack，默认 100=力度完全决定；0=力度不影响）。
  const vel = Math.max(0, Math.min(1, note.velocity / 127));
  let velocityFactor = vel;
  const veltrack = region.ampVelTrack;
  if (veltrack !== undefined && veltrack !== 100) {
    const t = Math.max(0, Math.min(100, veltrack)) / 100;
    velocityFactor = t * vel + (1 - t);
  }
  const peak = Math.pow(10, region.volume / 20) * velocityFactor * Math.max(0, Math.min(1, volume));
  // 完整 ADSR 包络。
  const attack = region.attack ?? 0.005;
  const decay = region.decay ?? 0;
  const sustainLevel = region.sustain !== undefined ? Math.max(0, region.sustain) / 100 : 1;
  const release = region.release ?? 0.1;
  const tAttack = startSec + attack;
  const tDecayEnd = tAttack + decay;
  const sustainGain = Math.max(0.0005, peak * sustainLevel);
  const releaseStart = Math.max(tDecayEnd + 0.001, stopSec - release);
  gainNode.gain.setValueAtTime(0.0001, startSec);
  gainNode.gain.exponentialRampToValueAtTime(Math.max(0.001, peak), tAttack);
  if (decay > 0) {
    gainNode.gain.exponentialRampToValueAtTime(sustainGain, tDecayEnd);
  }
  if (releaseStart >= stopSec) {
    gainNode.gain.setValueAtTime(sustainGain, stopSec);
  } else {
    gainNode.gain.setValueAtTime(sustainGain, releaseStart);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, stopSec);
  }
  let output: AudioNode = gainNode;
  if (region.pan !== 0) {
    const panner = context.createStereoPanner();
    panner.pan.value = region.pan / 100;
    gainNode.connect(panner);
    output = panner;
  }
  source.connect(gainNode);
  output.connect(context.destination);
  // 采样 offset/end 截取。
  const offsetSec = region.offset !== undefined ? region.offset / buffer.sampleRate : 0;
  const endSec = region.end !== undefined ? region.end / buffer.sampleRate : buffer.duration;
  const playDuration = Math.max(0.001, endSec - offsetSec);
  source.start(startSec, offsetSec, playDuration);
  source.stop(Math.min(stopSec + 0.05, startSec + playDuration + 0.05));
}

function scheduleOscillator(
  context: OfflineAudioContext,
  pitch: number,
  velocity: number,
  volume: number,
  startSec: number,
  stopSec: number,
): void {
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.value = 440 * 2 ** ((pitch - 69) / 12);
  const level = (velocity / 127) * Math.max(0, Math.min(1, volume)) * 0.05;
  gainNode.gain.setValueAtTime(0.0001, startSec);
  gainNode.gain.exponentialRampToValueAtTime(Math.max(0.001, level), startSec + 0.006);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, stopSec);
  oscillator.connect(gainNode).connect(context.destination);
  oscillator.start(startSec);
  oscillator.stop(stopSec + 0.02);
}

async function mixLayers(layers: AudioBuffer[], frames: number, sampleRate: number): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(2, frames, sampleRate);
  for (const layer of layers) {
    const source = context.createBufferSource();
    source.buffer = layer;
    source.connect(context.destination);
    source.start(0);
  }
  return context.startRendering();
}

async function renderSilence(frames: number, sampleRate: number): Promise<AudioBuffer> {
  const context = new OfflineAudioContext(2, frames, sampleRate);
  return context.startRendering();
}
