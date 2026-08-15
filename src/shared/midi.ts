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
  | { type: "clear_loop" };

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
