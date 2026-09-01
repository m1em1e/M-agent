import { buildProjectInstruments } from "../shared/instrument";
import type {
  AgentMode,
  AgentSession,
  ControllerEvent,
  MidiNote,
  MidiProject,
  MidiTrack as SharedMidiTrack,
  PitchBendEvent,
  ProposedChangeSet,
  Revision,
  TempoEvent,
  TickRange,
  TimeSignatureEvent,
} from "../shared/midi";
import type { RendererProjectPayload, ThinkingSegment } from "../shared/bridge";
import type { SkillTraceEntry } from "../shared/skills";
import type { InstrumentLibrarySummary, ProjectInstrument } from "../shared/instrument";
import type { SubscriptionSummary } from "../shared/subscriptions";

/** 渲染层轨道：在共享 MidiTrack 基础上增加仅 UI 使用的轨道颜色。 */
export interface MidiTrack extends SharedMidiTrack {
  color: string;
}

export interface Candidate {
  id: string;
  title: string;
  description: string;
  score: number;
  notesAdded: number;
  notesChanged: number;
  notesDeleted: number;
  loopScore: string;
  changeSet: ProposedChangeSet;
  supported: boolean;
  sourceMode: AgentMode;
  /** 生成该候选时的工程版本（用于应用前比对；undefined 表示离线/跳过校验）。 */
  projectVersion?: string;
  state?: "accepted" | "rejected";
}

export interface ChatMessage {
  id: string;
  author: "agent" | "user";
  text: string;
  thinking?: ThinkingSegment[];
  /** 正在流式写入的思考片段（未完成的段，展开显示）。 */
  streamingThinking?: string;
  /** 流式思考段开始时刻（毫秒时间戳），用于实时显示该段已用时长。 */
  streamingThinkingStartedAt?: number;
  skillTrace?: SkillTraceEntry[];
}

export interface ProjectMetadata {
  id: string;
  tempoMap: TempoEvent[];
  timeSignatures: TimeSignatureEvent[];
  loopRegion: TickRange | null;
  revisions: Revision[];
  agentSessions: AgentSession[];
}

/** 应用候选后需要回写编辑器的结果（仅包含发生变化的字段）。 */
export interface ApplyResult {
  tracks: MidiTrack[];
  tempo?: number;
  timeSigNumerator?: number;
  timeSigDenominator?: number;
  tempoMap?: TempoEvent[];
  timeSignatures?: TimeSignatureEvent[];
  loopRegion?: TickRange | null;
}

export const PPQ = 480;
export const BEATS_PER_BAR = 4;
export const MIN_PITCH = 36;
export const MAX_PITCH = 96;

export const WELCOME_MESSAGE = `欢迎使用 M Agent——面向独立游戏开发者的桌面 MIDI 创作 Agent。

可直接描述编曲想法（如"把这段改成 JRPG 战斗音乐"），我会分析工程并给出可预览、可撤销的修改方案；
在输入框按 @ 打开 Skill 选择（例如 @song-arranger 一键编排）。点击 + 添加轨道，双击钢琴卷帘添加音符。`;
export const ROW_HEIGHT = 18;

/** 拍号分母 → 合法分子集合（按乐理惯例） */
export const TIME_SIGNATURE_NUMERATORS: Readonly<Record<number, readonly number[]>> = {
  1: [1, 2, 3, 4],
  2: [2, 3, 4, 6],
  4: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  8: [3, 5, 6, 7, 9, 12],
  16: [3, 6, 12],
  32: [6, 12],
};
export const TIME_SIGNATURE_DENOMINATORS = [1, 2, 4, 8, 16, 32] as const;

export function normalizeTimeSignatureNumerator(numerator: number, denominator: number): number {
  const allowed = TIME_SIGNATURE_NUMERATORS[denominator] ?? TIME_SIGNATURE_NUMERATORS[4];
  if (allowed.includes(numerator)) return numerator;
  return allowed.reduce((best, value) => (Math.abs(value - numerator) < Math.abs(best - numerator) ? value : best));
}
export const KEY_WIDTH = 68;
export const RULER_HEIGHT = 30;
/** CC64 延音踏板 lane 高度（标尺下方、音符区顶部）。 */
/** 音符区起点（标尺之下；参数 lane 已移除，音符区直接从标尺下方开始）。 */
export const NOTES_TOP = RULER_HEIGHT;
export const CANVAS_HEIGHT = NOTES_TOP + (MAX_PITCH - MIN_PITCH + 1) * ROW_HEIGHT;
export const TRACK_COLORS = ["#ff9d78", "#b9e66c", "#73c8ff", "#c7a5ff", "#f4d66d", "#ff79a9"];

let nextId = 100;
export const uid = (prefix: string) => `${prefix}-${nextId++}`;
export const cloneTracks = (tracks: MidiTrack[]) =>
  tracks.map((track) => ({ ...track, notes: track.notes.map((note) => ({ ...note })) }));
export const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
export const isBlackKey = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12);
export const noteName = (pitch: number) => {
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  return `${names[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
};

/** 把候选里的轨级 CC 事件规范化为本地事件（忽略模型给的 id，应用层生成，按 tick 排序）。 */
export const normalizeCcEvents = (events: Array<{ id?: string; tick: number; controller: number; value: number }>): ControllerEvent[] =>
  events.map((event) => ({ id: uid("cc"), tick: event.tick, controller: event.controller, value: event.value }))
    .sort((a, b) => a.tick - b.tick || a.controller - b.controller);

/** MidiNote 可选字段 → 引擎音符级参数（未设置的键不出现）。 */
export const noteAudioParams = (note: MidiNote): { pan?: number; releaseSeconds?: number; cutoffHz?: number; resonanceQ?: number; finePitchCents?: number } => ({
  ...(note.pan !== undefined ? { pan: note.pan } : {}),
  ...(note.release !== undefined ? { releaseSeconds: note.release } : {}),
  ...(note.cutoffHz !== undefined ? { cutoffHz: note.cutoffHz } : {}),
  ...(note.resonanceQ !== undefined ? { resonanceQ: note.resonanceQ } : {}),
  ...(note.finePitchCents !== undefined ? { finePitchCents: note.finePitchCents } : {}),
});

/** 把候选里的轨级弯音事件规范化为本地事件（忽略模型给的 id，应用层生成，按 tick 排序）。 */
export const normalizePitchBends = (events: Array<{ id?: string; tick: number; value: number }>): PitchBendEvent[] =>
  events.map((event) => ({ id: uid("pb"), tick: event.tick, value: event.value }))
    .sort((a, b) => a.tick - b.tick);
export const errorMessage = (error: unknown, fallback: string) => error instanceof Error && error.message.trim()
  ? `${fallback}：${error.message}`
  : fallback;

/** 把 Agent 运行失败的错误整理成可读文本（去掉 IPC 封装与错误 JSON 噪音）。 */
export const cleanAgentError = (error: unknown): string => {
  let message = error instanceof Error ? error.message : String(error);
  const ipcIndex = message.indexOf("Error invoking remote method");
  if (ipcIndex >= 0) {
    const afterPrefix = message.slice(ipcIndex).split(":").slice(1).join(":").trim();
    const lastError = afterPrefix.lastIndexOf("Error: ");
    message = lastError >= 0 ? afterPrefix.slice(lastError + "Error: ".length).trim() : afterPrefix;
  }
  const jsonMatch = message.match(/\{[\s\S]*\}$/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { message?: unknown };
      if (typeof parsed.message === "string" && parsed.message.trim()) return parsed.message.trim();
    } catch {
      // 无法解析 JSON 时回退到原始信息。
    }
  }
  return message.trim() || "Agent 请求失败。";
};

/** 判定最近工程打开失败是否源于「工程缺失/不可访问」（主进程 PROJECT_MISSING 标记）。 */
export const isMissingProjectError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("PROJECT_MISSING");
};

/** 音符时长（tick → 毫秒），用于试听延音；钳制到合理范围避免过短/过长。 */
export const noteDurationMs = (note: { durationTicks: number }, ppq: number, tempo: number): number =>
  Math.max(80, Math.min(8000, (note.durationTicks / ppq) * (60000 / tempo)));

export const pattern = (
  pitches: number[],
  every: number,
  duration: number,
  bars = 4,
  velocity = 88,
): MidiNote[] =>
  Array.from({ length: bars * BEATS_PER_BAR }, (_, index) => ({
    id: uid("note"),
    pitch: pitches[index % pitches.length],
    startTick: Math.round(index * every),
    durationTicks: Math.max(1, Math.round(duration)),
    velocity: velocity + ((index % 3) - 1) * 5,
  }));

export const modeMeta: Record<AgentMode, { label: string; short: string; description: string }> = {
  research: { label: "调研", short: "只读", description: "只分析工程，不产生任何修改。" },
  plan: { label: "计划", short: "预览", description: "提出操作方案和差异，但不写入工程。" },
  goal: { label: "目标", short: "可编辑", description: "生成受约束的候选，确认后写入工程。" },
};

/** 依据工程音符的实际长度计算应显示的小节数：至少 16，末尾留 4 小节余量。 */
export const computeBarCount = (tracks: { notes: Array<{ startTick: number; durationTicks: number }> }[], ppq: number): number => {
  const maxTick = tracks.reduce(
    (maximum, track) => Math.max(maximum, track.notes.reduce(
      (trackMax, note) => Math.max(trackMax, note.startTick + note.durationTicks),
      0,
    )),
    0,
  );
  const bars = Math.ceil(maxTick / (BEATS_PER_BAR * ppq));
  return Math.max(16, bars + 4);
};

export const projectToTracks = (project: MidiProject): MidiTrack[] => project.tracks.map((track, index) => ({
  id: track.id,
  name: track.name,
  role: track.role,
  color: TRACK_COLORS[index % TRACK_COLORS.length],
  channel: track.channel,
  program: track.program,
  muted: track.muted,
  solo: track.solo,
  volume: track.volume ?? 1,
  instrument: track.instrument,
  loopRegion: track.loopRegion,
  controllerEvents: track.controllerEvents?.map((event) => ({ ...event })),
  pitchBends: track.pitchBends?.map((event) => ({ ...event })),
  notes: track.notes.map((note) => ({ ...note })),
}));

export const APPLICABLE_OPERATION_TYPES = new Set([
  "insert_notes", "update_notes", "delete_notes", "update_track",
  "create_track", "delete_track", "set_tempo", "set_time_signature", "set_loop", "clear_loop",
]);

export const candidateFromChangeSet = (changeSet: ProposedChangeSet, index: number, sourceMode: AgentMode, projectVersion?: string): Candidate => {
  let notesAdded = 0;
  let notesChanged = 0;
  let notesDeleted = 0;
  let supported = changeSet.operations.length > 0;
  changeSet.operations.forEach((operation) => {
    if (operation.type === "insert_notes") notesAdded += operation.notes.length;
    else if (operation.type === "update_notes") notesChanged += operation.changes.length;
    else if (operation.type === "delete_notes") notesDeleted += operation.noteIds.length;
    else if (!APPLICABLE_OPERATION_TYPES.has(operation.type)) supported = false;
  });
  const validationFailed = changeSet.validation?.some((result) => !result.valid) ?? false;
  return {
    id: changeSet.id,
    title: `${String.fromCharCode(65 + index)} · ${changeSet.summary}`,
    description: validationFailed
      ? "候选未通过校验，因此不可应用。"
      : supported
        ? `包含 ${changeSet.operations.length} 个原子编辑操作，等待确认后写入工程。`
        : "包含当前钢琴卷帘尚未支持的工程级操作，仅供审阅。",
    score: validationFailed ? 0 : Math.max(60, 96 - index * 6),
    notesAdded,
    notesChanged,
    notesDeleted,
    loopScore: validationFailed ? "未通过" : "已校验",
    changeSet,
    supported: supported && !validationFailed,
    sourceMode,
    projectVersion,
  };
};

export const toProjectPayload = (
  title: string,
  ppq: number,
  tempo: number,
  timeSigNumerator: number,
  timeSigDenominator: number,
  tracks: MidiTrack[],
  metadata: ProjectMetadata | null,
  instrumentLibrary: InstrumentLibrarySummary[],
  projectInstruments: ProjectInstrument[],
): RendererProjectPayload => ({
  ...(metadata ? {
    id: metadata.id,
    tempoMap: [
      { tick: 0, bpm: tempo },
      ...metadata.tempoMap.filter((event) => event.tick !== 0).map((event) => ({ ...event })),
    ],
    timeSignatures: [
      { tick: 0, numerator: timeSigNumerator, denominator: timeSigDenominator },
      ...metadata.timeSignatures.filter((event) => event.tick !== 0).map((event) => ({ ...event })),
    ],
    loopRegion: metadata.loopRegion ? { ...metadata.loopRegion } : null,
    revisions: metadata.revisions.map((revision) => ({ ...revision })),
    agentSessions: metadata.agentSessions.map((session) => ({
      ...session,
      acceptedChangeSetIds: [...session.acceptedChangeSetIds],
    })),
  } : {}),
  title,
  ppq,
  tempo,
  tracks: tracks.map(({ color: _color, ...track }) => ({
    ...track,
    notes: track.notes.map((note) => ({ ...note })),
  })),
  instruments: buildProjectInstruments(tracks, instrumentLibrary, projectInstruments),
});

export const validateNote = (note: MidiNote) =>
  typeof note.id === "string" && note.id.trim().length > 0
  && Number.isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127
  && Number.isInteger(note.startTick) && note.startTick >= 0
  && Number.isInteger(note.durationTicks) && note.durationTicks > 0
  && Number.isInteger(note.velocity) && note.velocity >= 1 && note.velocity <= 127;

export function applyNoteChangeSet(current: MidiTrack[], changeSet: ProposedChangeSet): ApplyResult {
  const work = cloneTracks(current);
  const result: ApplyResult = { tracks: work };
  const knownIds = new Set(work.flatMap((track) => track.notes.map((note) => note.id)));

  const findTrack = (trackId: string): MidiTrack => {
    const track = work.find((item) => item.id === trackId);
    if (!track) throw new Error(`候选引用了不存在的轨道 ${trackId}。`);
    return track;
  };

  for (const operation of changeSet.operations) {
    switch (operation.type) {
      case "insert_notes": {
        const track = findTrack(operation.trackId);
        const inserted = operation.notes.map((input) => {
          const id = input.id ?? uid("agent-note");
          const note: MidiNote = { ...input, id };
          if (knownIds.has(id)) throw new Error(`候选包含重复音符 ID ${id}。`);
          if (!validateNote(note)) throw new Error("候选包含越界或无效的音符数据。");
          knownIds.add(id);
          return note;
        });
        track.notes.push(...inserted);
        break;
      }
      case "update_notes": {
        const track = findTrack(operation.trackId);
        for (const change of operation.changes) {
          const noteIndex = track.notes.findIndex((note) => note.id === change.noteId);
          if (noteIndex < 0) throw new Error(`候选引用了不存在的音符 ${change.noteId}。`);
          const updated = { ...track.notes[noteIndex], ...change };
          delete (updated as MidiNote & { noteId?: string }).noteId;
          if (!validateNote(updated)) throw new Error("候选修改后产生了无效音符。");
          track.notes[noteIndex] = updated;
        }
        break;
      }
      case "delete_notes": {
        const track = findTrack(operation.trackId);
        const missing = operation.noteIds.find((noteId) => !track.notes.some((note) => note.id === noteId));
        if (missing) throw new Error(`候选引用了不存在的音符 ${missing}。`);
        const deleting = new Set(operation.noteIds);
        track.notes = track.notes.filter((note) => !deleting.has(note.id));
        operation.noteIds.forEach((noteId) => knownIds.delete(noteId));
        break;
      }
      case "update_track": {
        const track = findTrack(operation.trackId);
        const changes = { ...operation.changes };
        if (changes.instrument === null) {
          delete changes.instrument;
          track.instrument = undefined;
        }
        // controllerEvents / pitchBends：提供即替换整轨事件数组（null/[] = 清空），id 由应用层生成。
        if (changes.controllerEvents !== undefined) {
          track.controllerEvents = changes.controllerEvents === null ? [] : normalizeCcEvents(changes.controllerEvents);
          delete changes.controllerEvents;
        }
        if (changes.pitchBends !== undefined) {
          track.pitchBends = changes.pitchBends === null ? [] : normalizePitchBends(changes.pitchBends);
          delete changes.pitchBends;
        }
        Object.assign(track, changes);
        break;
      }
      case "create_track": {
        const input = operation.track;
        const id = input.id ?? uid("track");
        if (work.some((track) => track.id === id)) throw new Error(`候选包含重复轨道 ID ${id}。`);
        const usedChannels = new Set(work.map((track) => track.channel));
        const channel = input.channel
          ?? (input.role === "drums" ? 9 : Array.from({ length: 16 }, (_, index) => index).find((candidate) => candidate !== 9 && !usedChannels.has(candidate)) ?? 0);
        work.push({
          id,
          name: input.name.trim() || "Track",
          role: input.role ?? "other",
          color: TRACK_COLORS[work.length % TRACK_COLORS.length],
          channel,
          program: input.program ?? 0,
          muted: input.muted ?? false,
          solo: input.solo ?? false,
          volume: input.volume,
          instrument: input.instrument ?? undefined,
          loopRegion: input.loopRegion,
          controllerEvents: input.controllerEvents === undefined ? undefined : normalizeCcEvents(input.controllerEvents),
          pitchBends: input.pitchBends === undefined ? undefined : normalizePitchBends(input.pitchBends),
          notes: (input.notes ?? []).map((note) => ({
            ...note,
            id: note.id ?? uid("agent-note"),
          })),
        });
        break;
      }
      case "delete_track": {
        findTrack(operation.trackId);
        const kept = work.filter((track) => track.id !== operation.trackId);
        work.splice(0, work.length, ...kept);
        break;
      }
      case "set_tempo":
        if (operation.tick === 0) {
          result.tempo = operation.bpm;
        } else {
          result.tempoMap = upsertTempoEvent(result.tempoMap ?? [], operation.tick, operation.bpm);
        }
        break;
      case "set_time_signature":
        if (operation.tick === 0) {
          result.timeSigNumerator = operation.numerator;
          result.timeSigDenominator = operation.denominator;
        } else {
          result.timeSignatures = upsertTimeSignature(result.timeSignatures ?? [], operation);
        }
        break;
      case "set_loop":
        result.loopRegion = { startTick: operation.startTick, endTick: operation.endTick };
        break;
      case "clear_loop":
        result.loopRegion = null;
        break;
      default:
        throw new Error(`暂不支持 ${(operation as { type?: unknown }).type} 操作。`);
    }
  }

  return result;
}

export function upsertTempoEvent(map: TempoEvent[], tick: number, bpm: number): TempoEvent[] {
  return [...map.filter((event) => event.tick !== tick), { tick, bpm }].sort((a, b) => a.tick - b.tick);
}

export function upsertTimeSignature(
  signatures: TimeSignatureEvent[],
  sig: { tick: number; numerator: number; denominator: number },
): TimeSignatureEvent[] {
  return [...signatures.filter((event) => event.tick !== sig.tick), { ...sig }].sort((a, b) => a.tick - b.tick);
}

/** 按 tick 合并两批事件（后者覆盖前者），按 tick 升序。 */
export function mergeEventsByTick<T extends { tick: number }>(existing: T[], incoming: T[]): T[] {
  const byTick = new Map<number, T>();
  for (const event of existing) byTick.set(event.tick, event);
  for (const event of incoming) byTick.set(event.tick, event);
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}

export function subscriptionSourceLabel(source: SubscriptionSummary["source"]): string {
  if (source === "pi") return "Pi";
  if (source === "cc-switch") return "CC Switch";
  if (source === "preset") return "预设";
  return "手动";
}