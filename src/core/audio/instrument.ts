import type { InstrumentReference } from "../../shared/instrument.js";

/**
 * 统一 Instrument 抽象。MIDI 层只与这个接口交互，不依赖具体音频引擎
 * （SpessaSynth / SFZ sampler / 未来 VST3 worker）。
 */
export interface Instrument {
  readonly id: string;
  readonly type: InstrumentReference["type"];

  load(): Promise<void>;
  unload(): Promise<void>;

  noteOn(channel: number, note: number, velocity: number): void;
  noteOff(channel: number, note: number, velocity?: number): void;
  controlChange(channel: number, controller: number, value: number): void;
  programChange(channel: number, program: number): void;

  dispose(): void;
}

/** 轻量播放时的单次发声参数。 */
export interface NoteTrigger {
  channel: number;
  note: number;
  velocity: number;
  /** 音符时长（毫秒），用于在无 noteOff 情况下的自动释放。 */
  durationMs?: number;
}

export interface InstrumentRegistryQuery {
  type?: InstrumentReference["type"];
  /** 按名称/路径关键词搜索。 */
  query?: string;
}
