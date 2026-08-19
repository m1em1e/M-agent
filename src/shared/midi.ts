import type { InstrumentReference, ProjectInstrument } from "./instrument.js";

export type TrackRole = "melody" | "harmony" | "bass" | "drums" | "other";

export interface TickRange {
  startTick: number;
  endTick: number;
}

export interface TempoEvent {
  tick: number;
  bpm: number;
}

export interface TimeSignatureEvent {
  tick: number;
  numerator: number;
  denominator: number;
}

export interface MidiNote {
  id: string;
  pitch: number;
  startTick: number;
  durationTicks: number;
  velocity: number;
}

export interface MidiTrack {
  id: string;
  name: string;
  role: TrackRole;
  channel: number;
  program: number;
  muted: boolean;
  solo: boolean;
  notes: MidiNote[];
  /** 轨道音量（0–1），默认 1。 */
  volume?: number;
  /** 轨道音源引用（可序列化），缺省表示使用默认试听。 */
  instrument?: InstrumentReference;
  /** 轨道级循环区（分层循环播放用）；缺省或 null 表示该轨不循环、播完整曲。 */
  loopRegion?: TickRange | null;
}

export interface Revision {
  id: string;
  label: string;
  createdAt: string;
  source: "user" | "agent" | "import";
  changeSetId?: string;
}

export type AgentMode = "research" | "plan" | "goal";

export interface AgentSession {
  id: string;
  mode: AgentMode;
  createdAt: string;
  prompt: string;
  acceptedChangeSetIds: string[];
}

export interface MidiProject {
  id: string;
  title: string;
  ppq: number;
  tempoMap: TempoEvent[];
  timeSignatures: TimeSignatureEvent[];
  loopRegion: TickRange | null;
  tracks: MidiTrack[];
  revisions: Revision[];
  agentSessions: AgentSession[];
  /** 项目级音源清单（绝对路径 + 完整快照），随工程保存。 */
  instruments?: ProjectInstrument[];
}

export interface NoteInput {
  id?: string;
  pitch: number;
  startTick: number;
  durationTicks: number;
  velocity: number;
}

export interface NoteChange {
  noteId: string;
  pitch?: number;
  startTick?: number;
  durationTicks?: number;
  velocity?: number;
}

export interface TrackInput {
  id?: string;
  name: string;
  role?: TrackRole;
  channel?: number;
  program?: number;
  muted?: boolean;
  solo?: boolean;
  volume?: number;
  instrument?: InstrumentReference;
  loopRegion?: TickRange | null;
  notes?: NoteInput[];
}

export type MidiEditOperation =
  | { type: "insert_notes"; trackId: string; notes: NoteInput[] }
  | { type: "delete_notes"; trackId: string; noteIds: string[] }
  | { type: "update_notes"; trackId: string; changes: NoteChange[] }
  | { type: "create_track"; track: TrackInput }
  | { type: "delete_track"; trackId: string }
  | {
      type: "update_track";
      trackId: string;
      changes: Partial<Pick<MidiTrack, "name" | "role" | "channel" | "program" | "muted" | "solo">> & {
        /** 更换轨道音色引用；null 表示清除音色。 */
        instrument?: InstrumentReference | null;
      };
    }
  | { type: "set_tempo"; tick: number; bpm: number }
  | {
      type: "set_time_signature";
      tick: number;
      numerator: number;
      denominator: number;
    }
  | { type: "set_loop"; startTick: number; endTick: number }
  | { type: "clear_loop" }
  | {
      /** 定义一个可复用的 pattern（音符相对 pattern 起点），供 arrange_pattern 引用。 */
      type: "define_pattern";
      patternId: string;
      trackId: string;
      /** pattern 时长（tick），用于 arrange 的重复间距。 */
      lengthTicks: number;
      notes: NoteInput[];
    }
  | {
      /** 按序把多个 pattern 铺到目标轨道，可带变奏（转调/力度/密度递进）。 */
      type: "arrange_pattern";
      trackId: string;
      parts: Array<{
        patternId: string;
        startTick: number;
        repeats?: number;
        transpose?: number;
        velocityOffset?: number;
        densityGrow?: boolean;
      }>;
    };

export type ValidationSeverity = "error" | "warning";

export interface ValidationIssue {
  code: string;
  message: string;
  severity: ValidationSeverity;
  operationIndex?: number;
  path?: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  affectedNotes: number;
}

export interface ProposedChangeSet {
  id: string;
  summary: string;
  operations: MidiEditOperation[];
  validation?: ValidationResult[];
  estimatedAffectedNotes?: number;
}

export interface MidiImportWarning {
  code: string;
  message: string;
  trackIndex?: number;
  tick?: number;
}

export interface MidiImportResult {
  project: MidiProject;
  format: 0 | 1;
  warnings: MidiImportWarning[];
}

export interface MidiExportOptions {
  format?: 0 | 1;
}
