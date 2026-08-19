import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import type {
  MagentBridge,
  OpenMidiResult,
  ProjectOpenIntent,
  RecentProject,
  RendererProjectPayload,
  SaveResult,
  StartupEnvironmentReport,
  ThinkingSegment,
  UsagePage,
  UsageSummary,
} from "../shared/bridge";
import type { AgentSession, MidiProject, ProposedChangeSet, Revision, TempoEvent, TickRange, TimeSignatureEvent } from "../shared/midi";
import { projectVersionOf } from "../shared/project-version";
import type { ShellCheckResult } from "../shared/shell";
import type { InstrumentLibrarySummary, InstrumentReference, ProjectInstrument } from "../shared/instrument";
import { buildProjectInstruments } from "../shared/instrument";
import type { SkillTraceEntry } from "../core/agent/skills/types";
import { APP_MENU_GROUPS, recentProjectLabel, type AppMenuItem } from "../shared/menu";
import { hitLoopBand, LOOP_HANDLE_HEIGHT, loopRangeFromDrag, resizedLoopEnd, resizedLoopStart, shiftedLoopRange } from "./loop-ruler";
import { AudioEngine } from "./audio/audio-engine";
import { MarkdownContent } from "./markdown";
import {
  SUBSCRIPTION_API_TYPES,
  subscriptionApiTypeLabel,
  type FetchModelsRequest,
  type SubscriptionInput,
  type SubscriptionModel,
  type SubscriptionSummary,
} from "../shared/subscriptions";
import {
  findProviderPreset,
  PROVIDER_PRESETS,
  type ProviderPreset,
} from "../shared/provider-presets";
import {
  GOAL_MAX_TOKENS_RANGE,
  GOAL_MAX_TURNS_RANGE,
  loadConversationSettings,
  PI_THINKING_LEVELS,
  PROJECT_INJECTION_MODES,
  RESEARCH_MAX_TURNS_RANGE,
  SKILL_TIMEOUT_RANGE,
  saveConversationSettings,
  type ConversationSettings,
} from "../shared/conversation-settings";
import {
  DEFAULT_EXPORT_SAMPLE_RATE,
  EXPORT_MAX_MINUTES_RANGE,
  EXPORT_SAMPLE_RATES,
  loadExportSettings,
  saveExportSettings,
  type ExportSampleRate,
  type ExportSettings,
} from "../shared/export-settings";
import {
  encodeAudioBuffer,
  ExportTooLongError,
  renderProjectToBuffer,
  type ExportAudioFormat,
} from "./audio/render-project";
import {
  APPEARANCE_MODES,
  applyAppearancePreferences,
  saveAppearancePreferences,
  type AppearanceMode,
  type AppearancePreferences,
  type ThemeId,
  type ThemePreset,
} from "./theme";
import {
  constrainWorkspaceLayout,
  loadWorkspaceLayoutPreferences,
  resizeWorkspacePane,
  saveWorkspaceLayoutPreferences,
  WORKSPACE_LAYOUT_LIMITS,
  type WorkspacePane,
} from "./workspace-layout";
import { clearLegacyShellSettings, DEFAULT_SHELL_SETTINGS } from "./shell-settings";

type AgentMode = "research" | "plan" | "goal";
type EditorTool = "pointer" | "pencil";
type TrackRole = "melody" | "harmony" | "bass" | "drums" | "other";
type SettingsSection = "general" | "providers" | "usage" | "sound" | "plugins";

const settingsSections: Array<{ id: SettingsSection; label: string; icon: string }> = [
  { id: "general", label: "通用", icon: "settings" },
  { id: "providers", label: "供应商", icon: "cloud" },
  { id: "usage", label: "用量", icon: "chart" },
  { id: "sound", label: "音源", icon: "music" },
  { id: "plugins", label: "插件", icon: "plugin" },
];

interface MidiNote {
  id: string;
  pitch: number;
  startTick: number;
  durationTicks: number;
  velocity: number;
}

interface MidiTrack {
  id: string;
  name: string;
  role: TrackRole;
  color: string;
  channel: number;
  program: number;
  muted: boolean;
  solo: boolean;
  volume?: number;
  instrument?: InstrumentReference;
  loopRegion?: TickRange | null;
  notes: MidiNote[];
}

interface Candidate {
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

interface ChatMessage {
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

interface NoteDragState {
  kind: "move" | "resize";
  noteId: string;
  startX: number;
  startY: number;
  original: MidiNote;
  base: MidiTrack[];
}

interface LoopDragState {
  kind: "loop-create" | "loop-move" | "loop-resize-start" | "loop-resize-end";
  /** 拖拽开始时指针所在 tick（网格吸附）。 */
  startTick: number;
  /** 拖拽前该轨道的循环区（create 时可能是 null，用于取消时还原）。 */
  original: TickRange | null;
  /** 拖拽目标轨道（创建必须有选中轨道，编辑为被命中的轨道）。 */
  trackId: string;
  base: MidiTrack[];
}

type DragState = NoteDragState | LoopDragState;

interface WorkspaceResizeState {
  pane: WorkspacePane;
  pointerId: number;
  startX: number;
  startWidth: number;
}

interface ProjectMetadata {
  id: string;
  tempoMap: TempoEvent[];
  timeSignatures: TimeSignatureEvent[];
  loopRegion: TickRange | null;
  revisions: Revision[];
  agentSessions: AgentSession[];
}

/** 撤销/重做栈里的完整编辑快照（轨道 + 速度/拍号/循环区）。 */
interface EditorSnapshot {
  tracks: MidiTrack[];
  tempo: number;
  timeSigNumerator: number;
  timeSigDenominator: number;
  tempoMap: TempoEvent[];
  timeSignatures: TimeSignatureEvent[];
  loopRegion: TickRange | null;
}

/** 应用候选后需要回写编辑器的结果（仅包含发生变化的字段）。 */
interface ApplyResult {
  tracks: MidiTrack[];
  tempo?: number;
  timeSigNumerator?: number;
  timeSigDenominator?: number;
  tempoMap?: TempoEvent[];
  timeSignatures?: TimeSignatureEvent[];
  loopRegion?: TickRange | null;
}

const PPQ = 480;
const BEATS_PER_BAR = 4;
const MIN_PITCH = 36;
const MAX_PITCH = 96;

const WELCOME_MESSAGE = `欢迎使用 M Agent——面向独立游戏开发者的桌面 MIDI 创作 Agent。

可直接描述编曲想法（如"把这段改成 JRPG 战斗音乐"），我会分析工程并给出可预览、可撤销的修改方案；
在输入框按 @ 打开 Skill 选择（例如 @song-arranger 一键编排）。点击 + 添加轨道，双击钢琴卷帘添加音符。`;
const ROW_HEIGHT = 18;

/** 拍号分母 → 合法分子集合（按乐理惯例） */
const TIME_SIGNATURE_NUMERATORS: Readonly<Record<number, readonly number[]>> = {
  1: [1, 2, 3, 4],
  2: [2, 3, 4, 6],
  4: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  8: [3, 5, 6, 7, 9, 12],
  16: [3, 6, 12],
  32: [6, 12],
};
const TIME_SIGNATURE_DENOMINATORS = [1, 2, 4, 8, 16, 32] as const;

function normalizeTimeSignatureNumerator(numerator: number, denominator: number): number {
  const allowed = TIME_SIGNATURE_NUMERATORS[denominator] ?? TIME_SIGNATURE_NUMERATORS[4];
  if (allowed.includes(numerator)) return numerator;
  return allowed.reduce((best, value) => (Math.abs(value - numerator) < Math.abs(best - numerator) ? value : best));
}
const KEY_WIDTH = 68;
const RULER_HEIGHT = 30;
const CANVAS_HEIGHT = RULER_HEIGHT + (MAX_PITCH - MIN_PITCH + 1) * ROW_HEIGHT;
const TRACK_COLORS = ["#ff9d78", "#b9e66c", "#73c8ff", "#c7a5ff", "#f4d66d", "#ff79a9"];

let nextId = 100;
const uid = (prefix: string) => `${prefix}-${nextId++}`;
const cloneTracks = (tracks: MidiTrack[]) =>
  tracks.map((track) => ({ ...track, notes: track.notes.map((note) => ({ ...note })) }));
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
const isBlackKey = (pitch: number) => [1, 3, 6, 8, 10].includes(pitch % 12);
const noteName = (pitch: number) => {
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  return `${names[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
};
const errorMessage = (error: unknown, fallback: string) => error instanceof Error && error.message.trim()
  ? `${fallback}：${error.message}`
  : fallback;

/** 把 Agent 运行失败的错误整理成可读文本（去掉 IPC 封装与错误 JSON 噪音）。 */
const cleanAgentError = (error: unknown): string => {
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

const pattern = (
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

const initialTracks: MidiTrack[] = [
  {
    id: "track-melody",
    name: "Glass Thread",
    role: "melody",
    color: TRACK_COLORS[0],
    channel: 0,
    program: 11,
    muted: false,
    solo: false,
    notes: pattern([72, 76, 79, 81, 79, 76, 74, 71], PPQ, PPQ * 0.76, 4, 92),
  },
  {
    id: "track-harmony",
    name: "Soft Chords",
    role: "harmony",
    color: TRACK_COLORS[1],
    channel: 1,
    program: 89,
    muted: false,
    solo: false,
    notes: [48, 52, 55, 45, 48, 52, 41, 45, 48, 43, 47, 50].map((pitch, index) => ({
      id: uid("note"),
      pitch,
      startTick: Math.floor(index / 3) * PPQ * 4,
      durationTicks: Math.round(PPQ * 3.7),
      velocity: 58 + (index % 3) * 4,
    })),
  },
  {
    id: "track-bass",
    name: "Night Bass",
    role: "bass",
    color: TRACK_COLORS[2],
    channel: 2,
    program: 38,
    muted: false,
    solo: false,
    notes: pattern([48, 48, 45, 45, 41, 41, 43, 43], PPQ * 2, PPQ * 1.55, 8, 76),
  },
  {
    id: "track-drums",
    name: "Dust Kit",
    role: "drums",
    color: TRACK_COLORS[3],
    channel: 9,
    program: 0,
    muted: false,
    solo: false,
    notes: pattern([36, 42, 38, 42], PPQ / 2, PPQ * 0.16, 2, 72),
  },
];

const seedCandidates: Candidate[] = [
  {
    id: "candidate-a",
    title: "A · 更克制的结尾",
    description: "收窄旋律音域，在第 8 小节留出呼吸，并用上行二度衔接循环起点。",
    score: 92,
    notesAdded: 7,
    notesChanged: 4,
    notesDeleted: 0,
    loopScore: "无缝",
    supported: true,
    sourceMode: "goal",
    changeSet: {
      id: "candidate-a",
      summary: "更克制的结尾",
      operations: [{ type: "insert_notes", trackId: "track-melody", notes: [
        { pitch: 71, startTick: PPQ * 28, durationTicks: Math.round(PPQ * 0.75), velocity: 78 },
        { pitch: 72, startTick: PPQ * 29, durationTicks: Math.round(PPQ * 0.75), velocity: 82 },
        { pitch: 74, startTick: PPQ * 30, durationTicks: Math.round(PPQ * 0.75), velocity: 74 },
        { pitch: 71, startTick: PPQ * 31, durationTicks: Math.round(PPQ * 0.7), velocity: 68 },
      ] }],
      estimatedAffectedNotes: 4,
    },
  },
  {
    id: "candidate-b",
    title: "B · 增加探索感",
    description: "低音改为切分节奏，旋律保留长音，让场景更空旷但不失推进感。",
    score: 86,
    notesAdded: 12,
    notesChanged: 8,
    notesDeleted: 0,
    loopScore: "良好",
    supported: true,
    sourceMode: "goal",
    changeSet: {
      id: "candidate-b",
      summary: "增加探索感",
      operations: [{ type: "insert_notes", trackId: "track-bass", notes: [
        { pitch: 43, startTick: Math.round(PPQ * 24.5), durationTicks: PPQ, velocity: 72 },
        { pitch: 47, startTick: PPQ * 26, durationTicks: Math.round(PPQ * 0.8), velocity: 68 },
        { pitch: 48, startTick: Math.round(PPQ * 27.5), durationTicks: Math.round(PPQ * 1.2), velocity: 75 },
      ] }],
      estimatedAffectedNotes: 3,
    },
  },
];

const modeMeta: Record<AgentMode, { label: string; short: string; description: string }> = {
  research: { label: "调研", short: "只读", description: "只分析工程，不产生任何修改。" },
  plan: { label: "计划", short: "预览", description: "提出操作方案和差异，但不写入工程。" },
  goal: { label: "目标", short: "可编辑", description: "生成受约束的候选，确认后写入工程。" },
};

/** 依据工程音符的实际长度计算应显示的小节数：至少 16，末尾留 4 小节余量。 */
const computeBarCount = (tracks: { notes: Array<{ startTick: number; durationTicks: number }> }[], ppq: number): number => {
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

const projectToTracks = (project: MidiProject): MidiTrack[] => project.tracks.map((track, index) => ({
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
  notes: track.notes.map((note) => ({ ...note })),
}));

const APPLICABLE_OPERATION_TYPES = new Set([
  "insert_notes", "update_notes", "delete_notes", "update_track",
  "create_track", "delete_track", "set_tempo", "set_time_signature", "set_loop", "clear_loop",
]);

const candidateFromChangeSet = (changeSet: ProposedChangeSet, index: number, sourceMode: AgentMode, projectVersion?: string): Candidate => {
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

const toProjectPayload = (
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

const validateNote = (note: MidiNote) =>
  typeof note.id === "string" && note.id.trim().length > 0
  && Number.isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127
  && Number.isInteger(note.startTick) && note.startTick >= 0
  && Number.isInteger(note.durationTicks) && note.durationTicks > 0
  && Number.isInteger(note.velocity) && note.velocity >= 1 && note.velocity <= 127;

function applyNoteChangeSet(current: MidiTrack[], changeSet: ProposedChangeSet): ApplyResult {
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
          notes: (input.notes ?? []).map((note) => ({
            id: note.id ?? uid("agent-note"),
            pitch: note.pitch,
            startTick: note.startTick,
            durationTicks: note.durationTicks,
            velocity: note.velocity,
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

function upsertTempoEvent(map: TempoEvent[], tick: number, bpm: number): TempoEvent[] {
  return [...map.filter((event) => event.tick !== tick), { tick, bpm }].sort((a, b) => a.tick - b.tick);
}

function upsertTimeSignature(
  signatures: TimeSignatureEvent[],
  sig: { tick: number; numerator: number; denominator: number },
): TimeSignatureEvent[] {
  return [...signatures.filter((event) => event.tick !== sig.tick), { ...sig }].sort((a, b) => a.tick - b.tick);
}

/** 按 tick 合并两批事件（后者覆盖前者），按 tick 升序。 */
function mergeEventsByTick<T extends { tick: number }>(existing: T[], incoming: T[]): T[] {
  const byTick = new Map<number, T>();
  for (const event of existing) byTick.set(event.tick, event);
  for (const event of incoming) byTick.set(event.tick, event);
  return [...byTick.values()].sort((a, b) => a.tick - b.tick);
}

function subscriptionSourceLabel(source: SubscriptionSummary["source"]): string {
  if (source === "pi") return "Pi";
  if (source === "cc-switch") return "CC Switch";
  if (source === "preset") return "预设";
  return "手动";
}

function Icon({ name, size = 16 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    play: "M7 5v14l11-7z",
    pause: "M7 5h4v14H7zm7 0h4v14h-4z",
    stop: "M6 6h12v12H6z",
    undo: "M9 7 4 12l5 5v-3h5a5 5 0 0 0 5-5 7 7 0 0 0-.3-2A7 7 0 0 1 14 11H9z",
    redo: "m15 7 5 5-5 5v-3h-5a5 5 0 0 1-5-5 7 7 0 0 1 .3-2A7 7 0 0 0 10 11h5z",
    pointer: "m7 3 10 9-5 1 3 6-2 1-3-6-3 4z",
    pencil: "m5 16-1 4 4-1L19 8l-3-3zM14 7l3 3",
    plus: "M12 5v14M5 12h14",
    settings: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8m8 4 2-1-2-4-2 1-2-1-1-3H9l-1 3-2 1-2-1-2 4 2 1v2l-2 1 2 4 2-1 2 1 1 3h6l1-3 2-1 2 1 2-4-2-1v-2z",
    download: "M12 3v12m-5-5 5 5 5-5M5 20h14",
    folder: "M3 6h7l2 2h9v11H3z",
    spark: "m12 2 1.8 6.2L20 10l-6.2 1.8L12 18l-1.8-6.2L4 10l6.2-1.8z",
    send: "m4 4 17 8-17 8 3-7 8-1-8-1z",
    close: "m6 6 12 12m0-12L6 18",
    trash: "M5 7h14M9 7V4h6v3m-8 0 1 13h8l1-13",
    lock: "M7 11h10v9H7zm2 0V8a3 3 0 0 1 6 0v3",
    check: "m5 12 4 4L19 6",
    warning: "M12 3 2.5 20h19zM12 9v5m0 3h.01",
    cloud: "M7 18h10a4 4 0 0 0 .5-8A6 6 0 0 0 6 9a4.5 4.5 0 0 0 1 9z",
    chart: "M5 19V9m7 10V5m7 14v-7",
    music: "M9 18V6l10-2v12M9 9l10-2M6 20a3 2 0 1 0 0-4 3 2 0 0 0 0 4m10-2a3 2 0 1 0 0-4 3 2 0 0 0 0 4",
    plugin: "M9 3v4H5v4H2v4h3v4h4v3h4v-3h4v-4h3v-4h-3V7h-4V3z",
    panel: "M4 5h16v14H4zM15 5v14m2-10h1m-1 3h1m-1 3h1",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={paths[name] ?? paths.spark} />
    </svg>
  );
}

/** 应用内菜单项列表（递归渲染子菜单；「最近打开项目」由运行时 recentProjects 填充）。 */
function MenuItemList({
  items,
  recentProjects,
  onAction,
}: {
  items: AppMenuItem[];
  recentProjects: RecentProject[];
  onAction: (action: string, payload?: string) => void;
}) {
  const resolved = items.flatMap((item) => {
    if (!item.recentProjects) return [item];
    // 最近项目渲染为 hover 展开的子菜单项（保留「最近打开项目」父项结构）。
    if (recentProjects.length === 0) {
      return [{
        label: "最近打开项目",
        submenu: [{ label: "暂无最近项目", disabled: true } as AppMenuItem],
      } as AppMenuItem];
    }
    return [{
      label: "最近打开项目",
      submenu: recentProjects.slice(0, 10).map((entry) => ({
        label: recentProjectLabel(entry),
        action: "open-recent-project",
        payload: entry.path,
      } as AppMenuItem)),
    } as AppMenuItem];
  });
  return (
    <>
      {resolved.map((item, index) => (
        item.submenu && item.submenu.length > 0 ? (
          <div key={`${item.label}-${index}`} className="menu-item menu-submenu-item" role="menuitem">
            <span>{item.label}</span>
            <span className="menu-submenu-caret">▸</span>
            <div className="menu-submenu" role="menu">
              <MenuItemList items={item.submenu} recentProjects={recentProjects} onAction={onAction} />
            </div>
          </div>
        ) : (
          <button
            key={`${item.label}-${index}`}
            type="button"
            className="menu-item"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => item.action && onAction(item.action, item.payload)}
          >
            <span>{item.label}</span>
            {item.shortcut && <kbd>{item.shortcut}</kbd>}
          </button>
        )
      ))}
    </>
  );
}

interface AppProps {
  initialAppearance: AppearancePreferences;
  themePresets: readonly ThemePreset[];
}

export default function App({ initialAppearance, themePresets }: AppProps) {
  const [projectTitle, setProjectTitle] = useState("Ruins After Rain");
  useEffect(() => { document.title = `${projectTitle} · M Agent`; }, [projectTitle]);
  const [projectPpq, setProjectPpq] = useState(PPQ);
  const [projectMetadata, setProjectMetadata] = useState<ProjectMetadata | null>(null);
  const [projectFilePath, setProjectFilePath] = useState("");
  const [recentProjects, setRecentProjects] = useState<RecentProject[]>([]);
  const [windowChoice, setWindowChoice] = useState<ProjectOpenIntent | null>(null);
  const [tracks, setTracks] = useState<MidiTrack[]>(() => cloneTracks(initialTracks));
  const [selectedTrackId, setSelectedTrackId] = useState(initialTracks[0].id);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [tool, setTool] = useState<EditorTool>("pointer");
  const [zoom, setZoom] = useState(1);
  /** 钢琴卷帘/播放显示的小节数：至少 16，随工程实际长度动态扩展（max(16, 实际小节+4)）。 */
  const [barCount, setBarCount] = useState(16);
  const [gridTicks, setGridTicks] = useState(PPQ / 4);
  const [tempo, setTempo] = useState(104);
  const [timeSigNumerator, setTimeSigNumerator] = useState(4);
  const [timeSigDenominator, setTimeSigDenominator] = useState(4);
  const [timeSigOpen, setTimeSigOpen] = useState<null | "numerator" | "denominator">(null);
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [mode, setMode] = useState<AgentMode>("goal");
  const [past, setPast] = useState<EditorSnapshot[]>([]);
  const [future, setFuture] = useState<EditorSnapshot[]>([]);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>(seedCandidates);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "hello", author: "agent", text: WELCOME_MESSAGE },
  ]);
  const [prompt, setPrompt] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [agentLive, setAgentLive] = useState<{
    turns: number;
    currentTool: string | null;
    toolCalls: Record<string, number>;
    skills: Array<{ skill: string; status: string; depth: number; durationMs: number }>;
  }>({ turns: 0, currentTool: null, toolCalls: {}, skills: [] });
  const [agentSkills, setAgentSkills] = useState<Array<{ name: string; description: string }>>([]);
  const [agentSkillsLoaded, setAgentSkillsLoaded] = useState(false);
  const [skillMention, setSkillMention] = useState<{ open: boolean; query: string; caret: number; atIndex: number }>({ open: false, query: "", caret: 0, atIndex: 0 });
  const [skillMentionIndex, setSkillMentionIndex] = useState(0);
  const promptWrapRef = useRef<HTMLDivElement>(null);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);
  const timeSigRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [appearance, setAppearance] = useState<AppearancePreferences>(initialAppearance);
  const [conversationSettings, setConversationSettings] = useState<ConversationSettings>(loadConversationSettings);
  const [exportSettings, setExportSettings] = useState<ExportSettings>(loadExportSettings);
  const [exportDialog, setExportDialog] = useState<null | ExportAudioFormat>(null);
  const [exportSampleRate, setExportSampleRate] = useState<ExportSampleRate>(DEFAULT_EXPORT_SAMPLE_RATE);
  const [exportLoopOnly, setExportLoopOnly] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [shellPath, setShellPath] = useState(DEFAULT_SHELL_SETTINGS.path);
  const [shellCheck, setShellCheck] = useState<ShellCheckResult | null>(null);
  const [shellBusy, setShellBusy] = useState(false);
  const [themeListExpanded, setThemeListExpanded] = useState(false);
  const [workspaceLayout, setWorkspaceLayout] = useState(loadWorkspaceLayoutPreferences);
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth);
  const [dpr, setDpr] = useState(() => window.devicePixelRatio || 1);
  const [resizingPane, setResizingPane] = useState<WorkspacePane | null>(null);
  const [instrumentLibrary, setInstrumentLibrary] = useState<InstrumentLibrarySummary[]>([]);
  const [instrumentLibraryLoaded, setInstrumentLibraryLoaded] = useState(false);
  const [instrumentDropActive, setInstrumentDropActive] = useState(false);
  const [recommendedDownloadBusy, setRecommendedDownloadBusy] = useState(false);
  const [instrumentWarningDismissed, setInstrumentWarningDismissed] = useState(() => {
    try { return localStorage.getItem("magent.instrument-warning-dismissed") === "1"; } catch { return false; }
  });
  const [soundView, setSoundView] = useState<"list" | "add">("list");
  const [projectInstruments, setProjectInstruments] = useState<ProjectInstrument[]>([]);
  const [systemPath, setSystemPath] = useState("");
  const [systemPathDraft, setSystemPathDraft] = useState("");
  const [migratePrompt, setMigratePrompt] = useState<{ from: string; to: string } | null>(null);
  const audioEngineRef = useRef<AudioEngine | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [environment, setEnvironment] = useState<StartupEnvironmentReport | null>(null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [environmentBusy, setEnvironmentBusy] = useState(false);
  const [subscriptions, setSubscriptions] = useState<SubscriptionSummary[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const modelSelectRef = useRef<HTMLDivElement>(null);
  const [subscriptionBusy, setSubscriptionBusy] = useState(false);
  const [providersView, setProvidersView] = useState<"list" | "edit">("list");
  const [editingSubscriptionId, setEditingSubscriptionId] = useState<string | null>(null);
  const [subscriptionDraft, setSubscriptionDraft] = useState<SubscriptionInput | null>(null);
  const [presetPickerOpen, setPresetPickerOpen] = useState(false);
  const [presetSearch, setPresetSearch] = useState("");
  const [usageSummary, setUsageSummary] = useState<UsageSummary | null>(null);
  const [usageView, setUsageView] = useState<"day" | "model">("day");
  const [usagePage, setUsagePage] = useState(1);
  const [usageData, setUsageData] = useState<UsagePage | null>(null);
  const [usageBusy, setUsageBusy] = useState(false);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const workspaceResizeRef = useRef<WorkspaceResizeState | null>(null);
  const agentPanelToggleRef = useRef<HTMLButtonElement>(null);
  const shellInputRef = useRef<HTMLInputElement>(null);
  const startedAtRef = useRef(0);
  const startTickRef = useRef(0);
  const lastTickRef = useRef(0);
  const currentPlayheadRef = useRef(0);
  /** 标尺空白处按下后等待移动判定的「创建循环」候选（移动超阈值才生效）。 */
  const pendingLoopCreateRef = useRef<{ tick: number; x: number; trackId: string; base: MidiTrack[] } | null>(null);
  // 实时思考流相关
  const runMessageIdRef = useRef<string>("");
  const liveThinkingRef = useRef("");
  const liveThinkingStartedAtRef = useRef(0);
  const liveThinkingUiTimerRef = useRef<number | null>(null);
  const liveThinkingFlushTimerRef = useRef<number | null>(null);

  const beatWidth = 54 * zoom;
  const canvasWidth = KEY_WIDTH + barCount * BEATS_PER_BAR * beatWidth;
  const selectedTrack = tracks.find((track) => track.id === selectedTrackId) ?? tracks[0];
  const selectedNote = selectedTrack?.notes.find((note) => note.id === selectedNoteId) ?? null;
  const magent = (window as unknown as { magent?: MagentBridge }).magent;
  const isMac = magent?.platform === "darwin";

  const projectPayload = useCallback(
    (): RendererProjectPayload => toProjectPayload(projectTitle, projectPpq, tempo, timeSigNumerator, timeSigDenominator, tracks, projectMetadata, instrumentLibrary, projectInstruments),
    [instrumentLibrary, projectInstruments, projectMetadata, projectPpq, projectTitle, tempo, timeSigDenominator, timeSigNumerator, tracks],
  );

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2400);
  }, []);

  const filteredSkills = agentSkills.filter((skill) => {
    const query = skillMention.query.toLowerCase();
    return !query || skill.name.toLowerCase().includes(query) || skill.description.toLowerCase().includes(query);
  });

  useLayoutEffect(() => {
    applyAppearancePreferences(appearance, themePresets);
    saveAppearancePreferences(appearance);
  }, [appearance, themePresets]);

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    if (!workspace) return;
    const updateWidth = () => {
      const width = Math.round(workspace.getBoundingClientRect().width);
      if (width <= 0) return;
      setWorkspaceWidth(width);
      setWorkspaceLayout((current) => {
        const next = constrainWorkspaceLayout(current, width);
        return next.tracksWidth === current.tracksWidth
          && next.agentWidth === current.agentWidth
          && next.agentHidden === current.agentHidden
          ? current
          : next;
      });
    };
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(workspace);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const updateDpr = () => setDpr(window.devicePixelRatio || 1);
    window.addEventListener("resize", updateDpr);
    return () => window.removeEventListener("resize", updateDpr);
  }, []);

  useEffect(() => {
    saveWorkspaceLayoutPreferences(workspaceLayout);
  }, [workspaceLayout]);

  useEffect(() => {
    saveConversationSettings(conversationSettings);
  }, [conversationSettings]);

  useEffect(() => {
    saveExportSettings(exportSettings);
  }, [exportSettings]);

  useEffect(() => () => {
    document.body.classList.remove("workspace-resizing");
  }, []);

  const setAgentPanelHidden = useCallback((hidden: boolean, restoreFocus = false) => {
    setWorkspaceLayout((current) => constrainWorkspaceLayout({ ...current, agentHidden: hidden }, workspaceWidth));
    if (hidden && restoreFocus) window.requestAnimationFrame(() => agentPanelToggleRef.current?.focus());
  }, [workspaceWidth]);

  const beginWorkspaceResize = useCallback((pane: WorkspacePane, event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !event.isPrimary) return;
    event.preventDefault();
    const startWidth = pane === "tracks" ? workspaceLayout.tracksWidth : workspaceLayout.agentWidth;
    workspaceResizeRef.current = { pane, pointerId: event.pointerId, startX: event.clientX, startWidth };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.body.classList.add("workspace-resizing");
    setResizingPane(pane);
  }, [workspaceLayout.agentWidth, workspaceLayout.tracksWidth]);

  const moveWorkspaceResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = workspaceResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    const delta = event.clientX - resize.startX;
    const desiredWidth = resize.startWidth + (resize.pane === "tracks" ? delta : -delta);
    setWorkspaceLayout((current) => resizeWorkspacePane(current, resize.pane, desiredWidth, workspaceWidth));
  }, [workspaceWidth]);

  const endWorkspaceResize = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const resize = workspaceResizeRef.current;
    if (!resize || resize.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    workspaceResizeRef.current = null;
    document.body.classList.remove("workspace-resizing");
    setResizingPane(null);
  }, []);

  const resizeWorkspaceWithKeyboard = useCallback((pane: WorkspacePane, event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentWidth = pane === "tracks" ? workspaceLayout.tracksWidth : workspaceLayout.agentWidth;
    const step = event.shiftKey ? 24 : 8;
    let desiredWidth: number | null = null;
    if (event.key === "Home") desiredWidth = 0;
    if (event.key === "End") desiredWidth = Number.MAX_SAFE_INTEGER;
    if (event.key === "ArrowLeft") desiredWidth = currentWidth + (pane === "agent" ? step : -step);
    if (event.key === "ArrowRight") desiredWidth = currentWidth + (pane === "tracks" ? step : -step);
    if (desiredWidth === null) return;
    event.preventDefault();
    setWorkspaceLayout((current) => resizeWorkspacePane(current, pane, desiredWidth, workspaceWidth));
  }, [workspaceLayout.agentWidth, workspaceLayout.tracksWidth, workspaceWidth]);

  const selectTheme = useCallback((theme: ThemeId) => {
    setAppearance((current) => ({ ...current, theme }));
  }, []);

  const selectAppearanceMode = useCallback((mode: AppearanceMode) => {
    setAppearance((current) => ({ ...current, mode }));
  }, []);

  const refreshEnvironment = useCallback(async () => {
    if (!magent?.getStartupEnvironment) {
      setEnvironmentError("无法读取启动环境：桌面桥未连接。");
      return null;
    }
    setEnvironmentBusy(true);
    try {
      const report = await magent.getStartupEnvironment();
      setEnvironment(report);
      setEnvironmentError(null);
      return report;
    } catch (error) {
      setEnvironmentError(errorMessage(error, "启动环境检测失败"));
      return null;
    } finally {
      setEnvironmentBusy(false);
    }
  }, [magent]);

  const loadConfiguredShell = useCallback(async () => {
    if (!magent?.getShellSettings) return;
    try {
      const settings = await magent.getShellSettings();
      setShellPath(settings.path);
    } catch (error) {
      setShellCheck({
        path: "",
        status: "unusable",
        usable: false,
        message: errorMessage(error, "无法读取 Shell 配置"),
        checkedAt: new Date().toISOString(),
      });
    }
  }, [magent]);

  const browseShell = useCallback(async () => {
    if (!magent?.browseShell) {
      showToast("无法浏览 Shell：桌面桥未连接。");
      return;
    }
    setShellBusy(true);
    try {
      const result = await magent.browseShell();
      if (!result.canceled && result.filePath) {
        setShellPath(result.filePath);
        setShellCheck(null);
      }
    } catch (error) {
      showToast(errorMessage(error, "浏览 Shell 失败"));
    } finally {
      setShellBusy(false);
    }
  }, [magent, showToast]);

  const detectShell = useCallback(async () => {
    if (!magent?.checkShell) {
      showToast("无法检测 Shell：桌面桥未连接。");
      return;
    }
    setShellBusy(true);
    setShellCheck(null);
    try {
      const result = await magent.checkShell(shellPath);
      setShellCheck(result);
      if (result.usable) setShellPath(result.path);
      await refreshEnvironment();
    } catch (error) {
      setShellCheck({
        path: shellPath,
        status: "unusable",
        usable: false,
        message: errorMessage(error, "Shell 检测失败"),
        checkedAt: new Date().toISOString(),
      });
    } finally {
      setShellBusy(false);
    }
  }, [magent, refreshEnvironment, shellPath, showToast]);

  const openShellSettings = useCallback(() => {
    setSettingsSection("general");
    setSettingsOpen(true);
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
      shellInputRef.current?.scrollIntoView({ block: "center", behavior: "smooth" });
      shellInputRef.current?.focus();
    }));
  }, []);

  useEffect(() => { void refreshEnvironment(); }, [refreshEnvironment]);
  useEffect(() => {
    clearLegacyShellSettings();
    void loadConfiguredShell();
  }, [loadConfiguredShell]);

  useEffect(() => {
    if (!settingsOpen) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !environmentBusy) setSettingsOpen(false);
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [environmentBusy, settingsOpen]);

  // 每次渲染记录完整编辑状态，供提交/撤销/重做生成一致快照。
  const editorStateRef = useRef<EditorSnapshot>({
    tracks: [], tempo: 120, timeSigNumerator: 4, timeSigDenominator: 4,
    tempoMap: [], timeSignatures: [], loopRegion: null,
  });
  editorStateRef.current = {
    tracks,
    tempo,
    timeSigNumerator,
    timeSigDenominator,
    tempoMap: projectMetadata?.tempoMap ?? [],
    timeSignatures: projectMetadata?.timeSignatures ?? [],
    loopRegion: projectMetadata?.loopRegion ?? null,
  };

  const cloneSnapshot = (snap: EditorSnapshot): EditorSnapshot => ({
    tracks: cloneTracks(snap.tracks),
    tempo: snap.tempo,
    timeSigNumerator: snap.timeSigNumerator,
    timeSigDenominator: snap.timeSigDenominator,
    tempoMap: snap.tempoMap.map((event) => ({ ...event })),
    timeSignatures: snap.timeSignatures.map((event) => ({ ...event })),
    loopRegion: snap.loopRegion ? { ...snap.loopRegion } : null,
  });

  const restoreSnapshot = useCallback((snap: EditorSnapshot) => {
    const restored = cloneTracks(snap.tracks);
    setTracks(restored);
    setBarCount(computeBarCount(restored, projectPpq));
    setTempo(snap.tempo);
    setTimeSigNumerator(snap.timeSigNumerator);
    setTimeSigDenominator(snap.timeSigDenominator);
    setProjectMetadata((current) => current
      ? {
          ...current,
          tempoMap: snap.tempoMap.map((event) => ({ ...event })),
          timeSignatures: snap.timeSignatures.map((event) => ({ ...event })),
          loopRegion: snap.loopRegion ? { ...snap.loopRegion } : null,
        }
      : {
          id: "",
          title: "Untitled",
          tempoMap: snap.tempoMap.map((event) => ({ ...event })),
          timeSignatures: snap.timeSignatures.map((event) => ({ ...event })),
          loopRegion: snap.loopRegion ? { ...snap.loopRegion } : null,
          revisions: [],
          agentSessions: [],
        });
  }, [projectPpq]);

  const commitTracks = useCallback((next: MidiTrack[], preserveCandidates = false) => {
    setPast((history) => [...history.slice(-39), cloneSnapshot(editorStateRef.current)]);
    setFuture([]);
    setTracks(next);
    setBarCount(computeBarCount(next, projectPpq));
    if (!preserveCandidates) setCandidates([]);
  }, [projectPpq]);

  const undo = useCallback(() => {
    setCandidates([]);
    setPast((history) => {
      if (!history.length) return history;
      const previous = history[history.length - 1];
      setFuture((items) => [...items.slice(0, 39), cloneSnapshot(editorStateRef.current)]);
      restoreSnapshot(previous);
      return history.slice(0, -1);
    });
  }, [restoreSnapshot]);

  const redo = useCallback(() => {
    setCandidates([]);
    setFuture((items) => {
      if (!items.length) return items;
      const next = items[0];
      setPast((history) => [...history.slice(-39), cloneSnapshot(editorStateRef.current)]);
      restoreSnapshot(next);
      return items.slice(1);
    });
  }, [restoreSnapshot]);

  const deleteSelectedNote = useCallback(() => {
    if (!selectedNoteId) return;
    commitTracks(tracks.map((track) => ({
      ...track,
      notes: track.notes.filter((note) => note.id !== selectedNoteId),
    })));
    setSelectedNoteId(null);
  }, [commitTracks, selectedNoteId, tracks]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      // macOS 的原生菜单处理 Cmd+Z / Cmd+Shift+Z / Cmd+Y，避免重复触发。
      if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === "z" || event.key.toLowerCase() === "y")) {
        if (isMac) return;
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        event.preventDefault();
        deleteSelectedNote();
      } else if (event.code === "Space") {
        event.preventDefault();
        setIsPlaying((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [deleteSelectedNote, isMac, redo, undo]);

  useEffect(() => {
    if (!timeSigOpen) return;
    const closeOnClickOutside = (event: MouseEvent) => {
      if (timeSigRef.current && !timeSigRef.current.contains(event.target as Node)) setTimeSigOpen(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTimeSigOpen(null);
    };
    window.addEventListener("mousedown", closeOnClickOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnClickOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [timeSigOpen]);

  useEffect(() => {
    if (!activeMenu) return;
    const closeOnClickOutside = (event: MouseEvent) => {
      if (menuBarRef.current && !menuBarRef.current.contains(event.target as Node)) setActiveMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setActiveMenu(null);
    };
    window.addEventListener("mousedown", closeOnClickOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnClickOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [activeMenu]);

  useEffect(() => {
    if (!modelMenuOpen) return;
    const closeOnClickOutside = (event: MouseEvent) => {
      if (modelSelectRef.current && !modelSelectRef.current.contains(event.target as Node)) setModelMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setModelMenuOpen(false);
    };
    window.addEventListener("mousedown", closeOnClickOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("mousedown", closeOnClickOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [modelMenuOpen]);

  useLayoutEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = RULER_HEIGHT + (MAX_PITCH - 84) * ROW_HEIGHT;
    }
  }, []);

  useEffect(() => {
    currentPlayheadRef.current = playhead;
  }, [playhead]);

  const drawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = Math.floor(canvasWidth * dpr);
    canvas.height = Math.floor(CANVAS_HEIGHT * dpr);
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${CANVAS_HEIGHT}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, canvasWidth, CANVAS_HEIGHT);

    const rootStyle = getComputedStyle(document.documentElement);
    const themeColor = (name: string, fallback: string) => rootStyle.getPropertyValue(name).trim() || fallback;

    context.fillStyle = themeColor("--canvas-bg", "#111315");
    context.fillRect(0, 0, canvasWidth, CANVAS_HEIGHT);
    context.fillStyle = themeColor("--canvas-ruler", "#171a1d");
    context.fillRect(0, 0, canvasWidth, RULER_HEIGHT);
    context.fillStyle = themeColor("--canvas-key-bed", "#101214");
    context.fillRect(0, RULER_HEIGHT, KEY_WIDTH, CANVAS_HEIGHT - RULER_HEIGHT);

    // 标尺循环带：各轨循环区（轨道色，选中轨道描边）；工程级循环区仅虚线框（Agent 专属，不可拖拽编辑）。
    for (const track of tracks) {
      if (!track.loopRegion) continue;
      const startX = KEY_WIDTH + (track.loopRegion.startTick / projectPpq) * beatWidth;
      const endX = KEY_WIDTH + (track.loopRegion.endTick / projectPpq) * beatWidth;
      const isActive = track.id === selectedTrackId;
      context.globalAlpha = isActive ? 0.85 : 0.45;
      context.fillStyle = track.color;
      context.fillRect(startX, 0, endX - startX, RULER_HEIGHT);
      context.globalAlpha = isActive ? 1 : 0.75;
      context.fillRect(startX, 0, endX - startX, LOOP_HANDLE_HEIGHT);
      context.globalAlpha = 1;
      if (isActive) {
        context.strokeStyle = "rgba(255,255,255,.75)";
        context.lineWidth = 1;
        context.strokeRect(startX + 0.5, 0.5, endX - startX - 1, RULER_HEIGHT - 1);
      }
    }
    if (projectMetadata?.loopRegion) {
      const startX = KEY_WIDTH + (projectMetadata.loopRegion.startTick / projectPpq) * beatWidth;
      const endX = KEY_WIDTH + (projectMetadata.loopRegion.endTick / projectPpq) * beatWidth;
      context.strokeStyle = "rgba(200,204,208,.55)";
      context.setLineDash([4, 3]);
      context.lineWidth = 1;
      context.strokeRect(startX + 0.5, 0.5, endX - startX - 1, RULER_HEIGHT - 1);
      context.setLineDash([]);
    }

    for (let pitch = MAX_PITCH; pitch >= MIN_PITCH; pitch -= 1) {
      const y = RULER_HEIGHT + (MAX_PITCH - pitch) * ROW_HEIGHT;
      context.fillStyle = isBlackKey(pitch)
        ? themeColor("--canvas-black-row", "#0c0e10")
        : pitch % 12 === 0
          ? themeColor("--canvas-c-row", "#181c1e")
          : themeColor("--canvas-row", "#141719");
      context.fillRect(KEY_WIDTH, y, canvasWidth - KEY_WIDTH, ROW_HEIGHT);
      context.strokeStyle = themeColor("--canvas-row-line", "rgba(255,255,255,.035)");
      context.beginPath();
      context.moveTo(KEY_WIDTH, y + ROW_HEIGHT - 0.5);
      context.lineTo(canvasWidth, y + ROW_HEIGHT - 0.5);
      context.stroke();

      context.fillStyle = isBlackKey(pitch)
        ? themeColor("--canvas-black-key", "#171a1d")
        : themeColor("--canvas-white-key", "#d8d4c9");
      const keyW = isBlackKey(pitch) ? KEY_WIDTH * 0.63 : KEY_WIDTH - 1;
      context.fillRect(0, y + 1, keyW, ROW_HEIGHT - 2);
      if (pitch % 12 === 0) {
        context.fillStyle = themeColor("--canvas-key-label", "#55595a");
        context.font = "9px ui-monospace, monospace";
        context.textBaseline = "middle";
        context.fillText(noteName(pitch), 39, y + ROW_HEIGHT / 2 + 0.5);
      }
    }

    for (let beat = 0; beat <= barCount * BEATS_PER_BAR; beat += 1) {
      const x = KEY_WIDTH + beat * beatWidth;
      const isBar = beat % BEATS_PER_BAR === 0;
      context.strokeStyle = isBar
        ? themeColor("--canvas-bar-line", "rgba(235,235,220,.18)")
        : themeColor("--canvas-beat-line", "rgba(235,235,220,.07)");
      context.lineWidth = isBar ? 1 : 0.7;
      context.beginPath();
      context.moveTo(x + 0.5, RULER_HEIGHT);
      context.lineTo(x + 0.5, CANVAS_HEIGHT);
      context.stroke();
      if (isBar && beat < barCount * BEATS_PER_BAR) {
        context.fillStyle = themeColor("--canvas-ruler-text", "#8d9290");
        context.font = "10px ui-monospace, monospace";
        context.textBaseline = "middle";
        context.fillText(String(beat / BEATS_PER_BAR + 1).padStart(2, "0"), x + 7, 15);
      }
    }

    const soloActive = tracks.some((track) => track.solo);
    // 选中轨道的循环区在音符区以淡色列提示。
    const selectedLoop = tracks.find((track) => track.id === selectedTrackId)?.loopRegion;
    if (selectedLoop) {
      const bgX = KEY_WIDTH + (selectedLoop.startTick / projectPpq) * beatWidth;
      const bgW = Math.max(0, ((selectedLoop.endTick - selectedLoop.startTick) / projectPpq) * beatWidth);
      context.fillStyle = "rgba(255,255,255,.03)";
      context.fillRect(bgX, RULER_HEIGHT, bgW, CANVAS_HEIGHT - RULER_HEIGHT);
    }
    for (const track of tracks) {
      const active = track.id === selectedTrackId;
      const audible = !track.muted && (!soloActive || track.solo);
      for (const note of track.notes) {
        const x = KEY_WIDTH + (note.startTick / projectPpq) * beatWidth;
        const y = RULER_HEIGHT + (MAX_PITCH - note.pitch) * ROW_HEIGHT + 2;
        const width = Math.max(4, (note.durationTicks / projectPpq) * beatWidth - 2);
        const height = ROW_HEIGHT - 4;
        context.globalAlpha = audible ? (active ? 0.96 : 0.28) : 0.08;
        context.fillStyle = track.color;
        context.beginPath();
        context.roundRect(x + 1, y, width, height, 3);
        context.fill();
        if (note.id === selectedNoteId) {
          context.globalAlpha = 1;
          context.strokeStyle = themeColor("--canvas-selection", "#ffffff");
          context.lineWidth = 1.5;
          context.stroke();
          context.fillStyle = themeColor("--canvas-selection-handle", "rgba(255,255,255,.65)");
          context.fillRect(x + width - 4, y + 3, 2, height - 6);
        }
      }
    }
    context.globalAlpha = 1;

    const playheadX = KEY_WIDTH + (playhead / projectPpq) * beatWidth;
    context.strokeStyle = themeColor("--canvas-playhead", "#ff755d");
    context.lineWidth = 1.25;
    context.beginPath();
    context.moveTo(playheadX, 0);
    context.lineTo(playheadX, CANVAS_HEIGHT);
    context.stroke();
    context.fillStyle = themeColor("--canvas-playhead", "#ff755d");
    context.beginPath();
    context.moveTo(playheadX - 5, 0);
    context.lineTo(playheadX + 5, 0);
    context.lineTo(playheadX, 7);
    context.closePath();
    context.fill();
  }, [appearance, beatWidth, canvasWidth, dpr, playhead, projectMetadata, projectPpq, selectedNoteId, selectedTrackId, tracks]);

  useEffect(drawCanvas, [drawCanvas]);

  const getAudioEngine = useCallback((): AudioEngine | null => {
    if (!audioEngineRef.current) audioEngineRef.current = new AudioEngine();
    return audioEngineRef.current;
  }, []);

  const loadInstrumentLibrary = useCallback(async () => {
    if (!magent?.listInstruments) return;
    try {
      setInstrumentLibrary(await magent.listInstruments());
    } catch (error) {
      showToast(errorMessage(error, "读取音源库失败"));
    } finally {
      setInstrumentLibraryLoaded(true);
    }
    if (magent?.getInstrumentSystemPath) {
      try {
        const path = await magent.getInstrumentSystemPath();
        setSystemPath(path);
        setSystemPathDraft(path);
      } catch (error) {
        showToast(errorMessage(error, "读取系统音源目录失败"));
      }
    }
  }, [magent, showToast]);

  useEffect(() => { void loadInstrumentLibrary(); }, [loadInstrumentLibrary]);

  /** 音源库非空时重置「已忽略」标记，避免移除全部音源后不再提示。 */
  useEffect(() => {
    if (instrumentLibrary.length === 0 && projectInstruments.length === 0) return;
    setInstrumentWarningDismissed(false);
    try { localStorage.removeItem("magent.instrument-warning-dismissed"); } catch { /* 忽略存储异常 */ }
  }, [instrumentLibrary, projectInstruments]);

  const dismissInstrumentWarning = () => {
    setInstrumentWarningDismissed(true);
    try { localStorage.setItem("magent.instrument-warning-dismissed", "1"); } catch { /* 忽略存储异常 */ }
  };

  /** 解析音源条目：工程级优先，回退系统级。 */
  const findInstrumentEntry = useCallback((id: string): { path: string; enabled: boolean; presets?: InstrumentLibrarySummary["presets"]; sfzRegions?: InstrumentLibrarySummary["sfzRegions"] } | undefined => {
    const projectEntry = projectInstruments.find((entry) => entry.id === id);
    if (projectEntry) {
      return { path: projectEntry.path, enabled: true, presets: projectEntry.presets, sfzRegions: projectEntry.sfzRegions };
    }
    const systemEntry = instrumentLibrary.find((entry) => entry.id === id);
    if (systemEntry) {
      return { path: systemEntry.path, enabled: systemEntry.enabled, presets: systemEntry.presets, sfzRegions: systemEntry.sfzRegions };
    }
    return undefined;
  }, [instrumentLibrary, projectInstruments]);

  const bindProjectInstrumentPaths = async (paths: string[], label: string) => {
    if (!magent?.bindInstrumentToProject) return showToast("桌面音源桥尚未连接");
    try {
      const added: ProjectInstrument[] = [];
      for (const path of paths) {
        if (projectInstruments.some((entry) => entry.path === path)) continue;
        const snapshot = await magent.bindInstrumentToProject(path);
        added.push({ id: uid("pinst"), ...snapshot });
      }
      if (added.length > 0) {
        setProjectInstruments((current) => [...current, ...added]);
        showToast(`已绑定 ${added.length} 个项目音源${added.length === 1 ? `：${added[0].name ?? added[0].path}` : ""}`);
      } else {
        showToast("所选文件均已在当前工程音源中");
      }
    } catch (error) {
      showToast(errorMessage(error, `${label}失败`));
    }
  };

  const addProjectInstrumentsFromDialog = async () => {
    if (!magent?.pickInstrumentFiles) return showToast("桌面音源桥尚未连接");
    try {
      const paths = await magent.pickInstrumentFiles();
      if (paths.length > 0) await bindProjectInstrumentPaths(paths, "绑定工程音源");
    } catch (error) {
      showToast(errorMessage(error, "绑定工程音源失败"));
    }
  };

  const addProjectInstrumentsFromDrop = (event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (event.dataTransfer.files.length === 0) return;
    const paths = Array.from(event.dataTransfer.files)
      .map((file) => (magent?.getPathForFile ? magent.getPathForFile(file) : ""))
      .filter(Boolean);
    void bindProjectInstrumentPaths(paths, "绑定工程音源");
  };

  const unbindProjectInstrument = (id: string) => {
    setProjectInstruments((current) => current.filter((entry) => entry.id !== id));
    showToast("已从当前工程移除该音源绑定");
  };

  const setSystemInstrumentEnabled = async (entry: InstrumentLibrarySummary) => {
    if (!magent?.setInstrumentEnabled) return;
    try {
      setInstrumentLibrary(await magent.setInstrumentEnabled(entry.path, !entry.enabled));
    } catch (error) {
      showToast(errorMessage(error, "更新音源状态失败"));
    }
  };

  /** 下载推荐音源（GeneralUser GS）到系统音源库。 */
  const downloadRecommendedSoundfont = async () => {
    if (!magent?.downloadRecommendedInstrument) return showToast("桌面音源桥尚未连接");
    setRecommendedDownloadBusy(true);
    try {
      const result = await magent.downloadRecommendedInstrument();
      if (result.ok) {
        await loadInstrumentLibrary();
        showToast(result.downloaded ? "已下载推荐音源到系统音源库" : "推荐音源已在系统音源库中");
      } else {
        showToast(`推荐音源下载失败：${result.error ?? "未知错误"}`);
      }
    } catch (error) {
      showToast(errorMessage(error, "推荐音源下载失败"));
    } finally {
      setRecommendedDownloadBusy(false);
    }
  };

  const openSystemInstrumentFolder = async () => {
    if (!magent?.openInstrumentFolder) return showToast("桌面音源桥尚未连接");
    try {
      const result = await magent.openInstrumentFolder();
      if (!result.ok) showToast(result.error ?? "打开音源目录失败");
    } catch (error) {
      showToast(errorMessage(error, "打开音源目录失败"));
    }
  };

  const applySystemPath = () => {
    const to = systemPathDraft.trim();
    if (!to || to === systemPath) { setSystemPathDraft(systemPath); return; }
    setMigratePrompt({ from: systemPath, to });
  };

  const confirmSystemPathChange = async (migrate: boolean) => {
    if (!migratePrompt || !magent?.setInstrumentSystemPath) return;
    const { to } = migratePrompt;
    setMigratePrompt(null);
    try {
      const result = await magent.setInstrumentSystemPath(to, migrate);
      setSystemPath(result.path);
      setSystemPathDraft(result.path);
      await loadInstrumentLibrary();
      showToast(result.migrated ? "已迁移音源到新目录" : "已更改系统音源目录");
    } catch (error) {
      showToast(errorMessage(error, "修改系统音源目录失败"));
    }
  };

  /** 按 track 的音源引用播放一个音符；无引用或音源不可用时回退振荡器。 */
  const playTrackNote = useCallback(async (track: MidiTrack, note: MidiNote, durationMs: number) => {
    const engine = getAudioEngine();
    if (!engine) return;
    try {
      const entry = track.instrument ? findInstrumentEntry(track.instrument.libraryId) : undefined;
      const usable = Boolean(entry && entry.enabled);
      if (track.instrument?.type === "soundfont" && usable && entry) {
        await engine.loadSoundFont(track.instrument.libraryId, entry.path, async (path) => {
          if (!magent?.readInstrumentFile) throw new Error("桌面音源桥尚未连接");
          return magent.readInstrumentFile(path);
        });
      }
      if (track.instrument?.type === "sfz" && usable && entry) {
        await engine.loadSfz(track.instrument.libraryId, entry.sfzRegions ?? [], async (path) => {
          if (!magent?.readInstrumentFile) throw new Error("桌面音源桥尚未连接");
          return magent.readInstrumentFile(path);
        });
      }
      await engine.noteOn({
        channel: track.channel,
        note: note.pitch,
        velocity: note.velocity,
        durationMs,
        volume: track.volume ?? 1,
        soundFont: track.instrument?.type === "soundfont" && usable
          ? {
              libraryId: track.instrument.libraryId,
              bank: track.instrument.bank,
              program: track.instrument.program,
            }
          : undefined,
        sfz: track.instrument?.type === "sfz" && usable ? { libraryId: track.instrument.libraryId } : undefined,
      });
    } catch {
      // Audition is optional; editing remains available when audio is unavailable.
    }
  }, [findInstrumentEntry, getAudioEngine, magent]);

  useEffect(() => {
    if (!isPlaying) return;
    startedAtRef.current = performance.now();
    startTickRef.current = currentPlayheadRef.current;
    lastTickRef.current = currentPlayheadRef.current;
    const maxTick = barCount * BEATS_PER_BAR * projectPpq;
    let frame = 0;
    const update = (now: number) => {
      const elapsed = now - startedAtRef.current;
      const tick = startTickRef.current + elapsed * ((tempo * projectPpq) / 60000);
      const previous = lastTickRef.current;
      const soloActive = tracks.some((track) => track.solo);
      tracks.forEach((track) => {
        if (track.muted || (soloActive && !track.solo)) return;
        const loop = track.loopRegion ?? null;
        // 分层循环：有循环区的轨道按自身周期重复区间内音符，其余轨道以整曲为周期。
        const period = loop ? loop.endTick - loop.startTick : maxTick;
        for (const note of track.notes) {
          if (loop && (note.startTick < loop.startTick || note.startTick >= loop.endTick)) continue;
          const triggerTick = previous < note.startTick
            ? note.startTick
            : note.startTick + (Math.floor((previous - note.startTick) / period) + 1) * period;
          if (triggerTick > previous && triggerTick <= tick) {
            void playTrackNote(track, note, Math.min(8000, (note.durationTicks / projectPpq) * (60000 / tempo)));
          }
        }
      });
      lastTickRef.current = tick;
      setPlayhead(tick % maxTick);
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, playTrackNote, projectPpq, tempo, tracks]);

  // 暂停/停止时立即切断所有发声，避免 SoundFont 延音残留。
  useEffect(() => {
    if (!isPlaying) getAudioEngine()?.stopAll();
  }, [isPlaying]);

  const canvasPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const noteAtPoint = (x: number, y: number) => {
    if (!selectedTrack) return null;
    return [...selectedTrack.notes].reverse().find((note) => {
      const noteX = KEY_WIDTH + (note.startTick / projectPpq) * beatWidth;
      const noteY = RULER_HEIGHT + (MAX_PITCH - note.pitch) * ROW_HEIGHT + 2;
      const noteW = Math.max(4, (note.durationTicks / projectPpq) * beatWidth - 2);
      return x >= noteX && x <= noteX + noteW && y >= noteY && y <= noteY + ROW_HEIGHT - 4;
    }) ?? null;
  };

  const tickAtX = (x: number) => Math.round(((x - KEY_WIDTH) / beatWidth) * projectPpq / gridTicks) * gridTicks;
  const pitchAtY = (y: number) => clamp(MAX_PITCH - Math.floor((y - RULER_HEIGHT) / ROW_HEIGHT), MIN_PITCH, MAX_PITCH);

  /** 命中 x 处最上层的轨道循环带（选中轨道优先，其余按绘制顺序倒序）。 */
  const loopBandAt = (x: number): { track: MidiTrack; range: TickRange; hit: "resize-start" | "resize-end" | "move" } | null => {
    const selected = tracks.find((track) => track.id === selectedTrackId);
    const others = tracks.filter((track) => track.id !== selectedTrackId).reverse();
    for (const track of [...(selected ? [selected] : []), ...others]) {
      if (!track.loopRegion) continue;
      const startPx = KEY_WIDTH + (track.loopRegion.startTick / projectPpq) * beatWidth;
      const endPx = KEY_WIDTH + (track.loopRegion.endTick / projectPpq) * beatWidth;
      const hit = hitLoopBand(startPx, endPx, x);
      if (hit) return { track, range: track.loopRegion, hit };
    }
    return null;
  };

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = canvasPoint(event);
    if (y < RULER_HEIGHT && x > KEY_WIDTH) {
      if (event.button === 0) {
        const band = loopBandAt(x);
        if (band) {
          const kind = band.hit === "resize-start" ? "loop-resize-start"
            : band.hit === "resize-end" ? "loop-resize-end" : "loop-move";
          setDrag({
            kind,
            startTick: tickAtX(x),
            original: { ...band.range },
            trackId: band.track.id,
            base: cloneTracks(tracks),
          });
          event.currentTarget.setPointerCapture(event.pointerId);
          return;
        }
        setPlayhead(clamp((x - KEY_WIDTH) / beatWidth * projectPpq, 0, barCount * BEATS_PER_BAR * projectPpq));
        if (selectedTrackId) {
          pendingLoopCreateRef.current = { tick: tickAtX(x), x, trackId: selectedTrackId, base: cloneTracks(tracks) };
          event.currentTarget.setPointerCapture(event.pointerId);
        }
      }
      return;
    }
    if (x <= KEY_WIDTH || y <= RULER_HEIGHT || !selectedTrack) return;
    const hit = noteAtPoint(x, y);
    if (hit) {
      setSelectedNoteId(hit.id);
      void playTrackNote(selectedTrack, hit, 160);
      const noteX = KEY_WIDTH + (hit.startTick / projectPpq) * beatWidth;
      const noteW = Math.max(4, (hit.durationTicks / projectPpq) * beatWidth - 2);
      setDrag({
        kind: x >= noteX + noteW - 8 ? "resize" : "move",
        noteId: hit.id,
        startX: x,
        startY: y,
        original: { ...hit },
        base: cloneTracks(tracks),
      });
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (tool === "pencil") {
      const note: MidiNote = {
        id: uid("note"),
        pitch: pitchAtY(y),
        startTick: Math.max(0, tickAtX(x)),
        durationTicks: projectPpq,
        velocity: 88,
      };
      commitTracks(tracks.map((track) => track.id === selectedTrackId ? { ...track, notes: [...track.notes, note] } : track));
      setSelectedNoteId(note.id);
      void playTrackNote(selectedTrack, note, 160);
    } else {
      setSelectedNoteId(null);
    }
  };

  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = canvasPoint(event);
    if (!drag && pendingLoopCreateRef.current) {
      const pending = pendingLoopCreateRef.current;
      if (Math.abs(x - pending.x) > 3) {
        pendingLoopCreateRef.current = null;
        setDrag({
          kind: "loop-create",
          startTick: pending.tick,
          original: pending.base.find((track) => track.id === pending.trackId)?.loopRegion ?? null,
          trackId: pending.trackId,
          base: pending.base,
        });
      } else {
        return;
      }
    }
    if (!drag) return;
    const activeDrag = drag;
    switch (activeDrag.kind) {
      case "loop-create":
      case "loop-move":
      case "loop-resize-start":
      case "loop-resize-end": {
        const currentTick = tickAtX(x);
        const range = activeDrag.kind === "loop-create"
          ? loopRangeFromDrag(activeDrag.startTick, currentTick) ?? activeDrag.original
          : activeDrag.kind === "loop-move"
            ? shiftedLoopRange(activeDrag.original as TickRange, currentTick - activeDrag.startTick)
            : activeDrag.kind === "loop-resize-start"
              ? resizedLoopStart(activeDrag.original as TickRange, currentTick)
              : resizedLoopEnd(activeDrag.original as TickRange, currentTick);
        setTracks(activeDrag.base.map((track) => track.id === activeDrag.trackId ? { ...track, loopRegion: range } : track));
        return;
      }
    }
    const deltaTicks = Math.round((((x - activeDrag.startX) / beatWidth) * projectPpq) / gridTicks) * gridTicks;
    const deltaPitch = -Math.round((y - activeDrag.startY) / ROW_HEIGHT);
    setTracks(activeDrag.base.map((track) => ({
      ...track,
      notes: track.notes.map((note) => {
        if (note.id !== activeDrag.noteId) return note;
        if (activeDrag.kind === "resize") {
          return { ...note, durationTicks: Math.max(gridTicks, activeDrag.original.durationTicks + deltaTicks) };
        }
        return {
          ...note,
          startTick: Math.max(0, activeDrag.original.startTick + deltaTicks),
          pitch: clamp(activeDrag.original.pitch + deltaPitch, MIN_PITCH, MAX_PITCH),
        };
      }),
    })));
  };

  const onCanvasPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (pendingLoopCreateRef.current) {
      pendingLoopCreateRef.current = null;
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      return;
    }
    if (!drag) return;
    setPast((history) => [...history.slice(-39), {
      ...editorStateRef.current,
      tracks: drag.base.map((track) => ({ ...track, notes: track.notes.map((note) => ({ ...note })) })),
    }]);
    setFuture([]);
    setCandidates([]);
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onCanvasContextMenu = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (y >= RULER_HEIGHT || x <= KEY_WIDTH) return;
    const band = loopBandAt(x);
    if (!band) return;
    event.preventDefault();
    if (band.track.loopRegion) {
      setPast((history) => [...history.slice(-39), {
        ...editorStateRef.current,
        tracks: cloneTracks(tracks).map((track) => track.id === band.track.id ? { ...track, loopRegion: null } : track),
      }]);
      setTracks(tracks.map((track) => track.id === band.track.id ? { ...track, loopRegion: null } : track));
      setFuture([]);
      setCandidates([]);
    }
  };

  const onCanvasDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x <= KEY_WIDTH || y <= RULER_HEIGHT || noteAtPoint(x, y) || !selectedTrack) return;
    const note: MidiNote = { id: uid("note"), pitch: pitchAtY(y), startTick: Math.max(0, tickAtX(x)), durationTicks: projectPpq, velocity: 88 };
    commitTracks(tracks.map((track) => track.id === selectedTrackId ? { ...track, notes: [...track.notes, note] } : track));
    setSelectedNoteId(note.id);
    void playTrackNote(selectedTrack, note, 160);
  };

  const addTrack = () => {
    const number = tracks.length + 1;
    const usedChannels = new Set(tracks.map((track) => track.channel));
    const channel = Array.from({ length: 16 }, (_, index) => index).find((candidate) => candidate !== 9 && !usedChannels.has(candidate)) ?? 0;
    const track: MidiTrack = {
      id: uid("track"),
      name: `New Layer ${number}`,
      role: "other",
      color: TRACK_COLORS[tracks.length % TRACK_COLORS.length],
      channel,
      program: 0,
      muted: false,
      solo: false,
      notes: [],
    };
    commitTracks([...tracks, track]);
    setSelectedTrackId(track.id);
  };

  const deleteSelectedTrack = () => {
    if (!selectedTrackId) return;
    const next = tracks.filter((track) => track.id !== selectedTrackId);
    commitTracks(next);
    setSelectedTrackId(next[0]?.id ?? "");
    setSelectedNoteId(null);
  };

  const updateTrack = (id: string, change: Partial<MidiTrack>) => {
    commitTracks(tracks.map((track) => track.id === id ? { ...track, ...change } : track));
  };

  const updateSelectedNote = (change: Partial<MidiNote>) => {
    if (!selectedNoteId) return;
    commitTracks(tracks.map((track) => ({
      ...track,
      notes: track.notes.map((note) => note.id === selectedNoteId ? { ...note, ...change } : note),
    })));
  };

  const skillsLoadingRef = useRef(false);
  const loadAgentSkills = useCallback(async () => {
    if (skillsLoadingRef.current) return;
    if (!magent?.listAgentSkills) {
      setAgentSkillsLoaded(true);
      return;
    }
    skillsLoadingRef.current = true;
    try {
      setAgentSkills(await magent.listAgentSkills());
    } catch {
      // Skill 列表加载失败不影响主流程。
    } finally {
      skillsLoadingRef.current = false;
      setAgentSkillsLoaded(true);
    }
  }, [magent]);

  /** 根据文本与光标位置更新 @提及弹窗状态。 */
  const updateSkillMention = (value: string, caret: number) => {
    const before = value.slice(0, caret);
    const atIndex = before.lastIndexOf("@");
    if (atIndex < 0) {
      setSkillMention((current) => (current.open ? { ...current, open: false } : current));
      return;
    }
    const token = before.slice(atIndex + 1);
    if (!/^[A-Za-z0-9_-]*$/.test(token)) {
      setSkillMention((current) => (current.open ? { ...current, open: false } : current));
      return;
    }
    if (atIndex > 0 && !/\s/.test(before[atIndex - 1])) {
      setSkillMention((current) => (current.open ? { ...current, open: false } : current));
      return;
    }
    if (agentSkills.length === 0) void loadAgentSkills();
    setSkillMention({ open: true, query: token, caret, atIndex });
    setSkillMentionIndex(0);
  };

  const acceptSkillMention = (skillName: string) => {
    const { atIndex, caret } = skillMention;
    setPrompt((current) => `${current.slice(0, atIndex)}@${skillName} ${current.slice(caret)}`);
    setSkillMention((current) => ({ ...current, open: false }));
  };

  const closeSkillMention = () => {
    setSkillMention((current) => (current.open ? { ...current, open: false } : current));
  };

  const handlePromptKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (skillMention.open) {
      const filtered = filteredSkills;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSkillMentionIndex((index) => (filtered.length ? (index + 1) % filtered.length : 0));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSkillMentionIndex((index) => (filtered.length ? (index - 1 + filtered.length) % filtered.length : 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        const selected = filtered[skillMentionIndex];
        if (selected) acceptSkillMention(selected.name);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeSkillMention();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void sendPrompt();
    }
  };

  const cancelAgentRun = async () => {
    if (!magent?.cancelAgent) return;
    try {
      await magent.cancelAgent();
    } catch (error) {
      showToast(errorMessage(error, "取消失败"));
    }
  };

  const sendPrompt = async () => {
    const clean = prompt.trim();
    if (!clean || agentBusy) return;
    const requestMode = mode;
    setMessages((items) => [...items, { id: uid("message"), author: "user", text: clean }]);
    const runMessageId = uid("message");
    runMessageIdRef.current = runMessageId;
    setMessages((items) => [...items, { id: runMessageId, author: "agent", text: "", thinking: [], streamingThinking: "" }]);
    setPrompt("");
    setAgentBusy(true);
    setAgentLive({ turns: 0, currentTool: null, toolCalls: {}, skills: [] });
    const finalizeRunMessage = (patch: Partial<ChatMessage>) => {
      setMessages((items) => items.map((message) => message.id === runMessageId ? { ...message, ...patch } : message));
    };
    try {
      if (!magent?.runAgent) {
        const fallback = requestMode === "research"
          ? "演示只读分析：当前工程的旋律与低音在结尾密度偏高。工程未发生修改。"
          : requestMode === "plan"
            ? "演示计划：降低结尾力度并清理循环接缝；当前仅展示预览。"
            : "桌面桥尚未连接，已保留演示候选供交互测试。";
        finalizeRunMessage({ text: fallback, thinking: [], streamingThinking: undefined });
        setCandidates(requestMode === "goal" ? seedCandidates.map((candidate) => ({ ...candidate, id: uid("candidate") })) : []);
        return;
      }
      const projectVersion = projectVersionOf(projectPayload());
      const response = await magent.runAgent({
        mode: requestMode,
        objective: clean,
        project: projectPayload(),
        conversation: conversationSettings,
        focusTrackId: selectedTrack?.id,
        projectVersion,
      });
      finalizeRunMessage({
        text: `${response.analysis}${response.provider === "pi-offline" ? "（离线分析）" : ""}`,
        thinking: response.thinking,
        streamingThinking: undefined,
        skillTrace: response.skillTrace,
      });
      setCandidates(requestMode === "research"
        ? []
        : response.candidates.map((changeSet, index) => candidateFromChangeSet(changeSet, index, requestMode, response.projectVersion ?? projectVersion)));
    } catch (error) {
      const message = cleanAgentError(error);
      if (/已取消/.test(message)) {
        finalizeRunMessage({ text: "Agent 已取消。工程未发生修改。", thinking: [], streamingThinking: undefined });
      } else {
        finalizeRunMessage({ text: `请求失败：${message}。工程未发生修改。`, thinking: [], streamingThinking: undefined });
      }
      setCandidates([]);
    } finally {
      liveThinkingRef.current = "";
      liveThinkingStartedAtRef.current = 0;
      if (liveThinkingUiTimerRef.current != null) window.clearTimeout(liveThinkingUiTimerRef.current);
      if (liveThinkingFlushTimerRef.current != null) window.clearTimeout(liveThinkingFlushTimerRef.current);
      liveThinkingUiTimerRef.current = null;
      liveThinkingFlushTimerRef.current = null;
      setAgentBusy(false);
    }
  };

  const acceptCandidate = (candidate: Candidate) => {
    if (mode !== "goal" || candidate.sourceMode !== "goal" || !candidate.supported || candidate.state) return;
    if (candidate.projectVersion !== undefined) {
      const currentVersion = projectVersionOf(projectPayload());
      if (currentVersion !== candidate.projectVersion) {
        showToast("工程已发生变化，该候选可能已过期，请重新生成。");
        return;
      }
    }
    try {
      const applied = applyNoteChangeSet(tracks, candidate.changeSet);
      commitTracks(applied.tracks, true);
      if (applied.tempo !== undefined) setTempo(applied.tempo);
      if (applied.timeSigNumerator !== undefined) setTimeSigNumerator(applied.timeSigNumerator);
      if (applied.timeSigDenominator !== undefined) setTimeSigDenominator(applied.timeSigDenominator);
      if (applied.loopRegion !== undefined) {
        setProjectMetadata((current) => current
          ? { ...current, loopRegion: applied.loopRegion ? { ...applied.loopRegion } : null }
          : current);
      }
      if (applied.tempoMap) {
        setProjectMetadata((current) => current
          ? { ...current, tempoMap: mergeEventsByTick(current.tempoMap, applied.tempoMap!) }
          : current);
      }
      if (applied.timeSignatures) {
        setProjectMetadata((current) => current
          ? { ...current, timeSignatures: mergeEventsByTick(current.timeSignatures, applied.timeSignatures!) }
          : current);
      }
      setCandidates((items) => items.map((item) => item.id === candidate.id ? { ...item, state: "accepted" } : item));
      setMessages((items) => [...items, { id: uid("message"), author: "agent", text: `已原子应用“${candidate.title}”。全部操作可用 Ctrl+Z 一次撤销。` }]);
      showToast("候选已应用，可一次撤销");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "候选应用失败");
    }
  };

  const loadProjectResult = (result: OpenMidiResult, source: "MIDI" | "工程"): boolean => {
    if (result.canceled) return false;
    if (!result.project) {
      showToast(`${source}未返回可用的工程数据`);
      return false;
    }
    getAudioEngine()?.stopAll();
    setIsPlaying(false);
    const loadedTracks = projectToTracks(result.project);
    setTracks(loadedTracks);
    setBarCount(computeBarCount(loadedTracks, result.project.ppq));
    setProjectFilePath(source === "工程" ? (result.filePath ?? "") : "");
    setProjectInstruments(result.project.instruments?.map((instrument) => ({ ...instrument })) ?? []);
    setProjectTitle(result.project.title || "Untitled");
    setProjectPpq(result.project.ppq);
    setProjectMetadata({
      id: result.project.id,
      tempoMap: result.project.tempoMap.map((event) => ({ ...event })),
      timeSignatures: result.project.timeSignatures.map((event) => ({ ...event })),
      loopRegion: result.project.loopRegion ? { ...result.project.loopRegion } : null,
      revisions: result.project.revisions.map((revision) => ({ ...revision })),
      agentSessions: result.project.agentSessions.map((session) => ({
        ...session,
        acceptedChangeSetIds: [...session.acceptedChangeSetIds],
      })),
    });
    setGridTicks(Math.max(1, Math.round(result.project.ppq / 4)));
    setTempo(result.project.tempoMap[0]?.bpm ?? 120);
    const signature = result.project.timeSignatures[0];
    setTimeSigDenominator(signature?.denominator ?? 4);
    setTimeSigNumerator(normalizeTimeSignatureNumerator(signature?.numerator ?? 4, signature?.denominator ?? 4));
    setSelectedTrackId(loadedTracks[0]?.id ?? "");
    setSelectedNoteId(null);
    setPlayhead(0);
    setPast([]);
    setFuture([]);
    setCandidates([]);
    setMessages((items) => [...items, { id: uid("message"), author: "agent", text: `${source}已载入：${loadedTracks.length} 条轨道。${result.warnings?.length ? `另有 ${result.warnings.length} 条导入提示。` : ""}` }]);
    showToast(`${source}已载入`);
    return true;
  };

  const handleOpen = async () => {
    if (!magent?.openMidi) return showToast("桌面文件桥尚未连接，当前为演示工程");
    try { loadProjectResult(await magent.openMidi(), "MIDI"); } catch (error) { showToast(errorMessage(error, "未能打开 MIDI 文件")); }
  };

  const handleOpenProject = async () => {
    if (!magent?.openProject) return showToast("桌面文件桥尚未连接");
    try {
      loadProjectResult(await magent.openProject(), "工程");
      void loadRecentProjects();
    } catch (error) { showToast(errorMessage(error, "未能打开工程文件")); }
  };

  /** 新建项目：把编辑器重置为完全空的工程（0 轨道，在当前窗口）。 */
  const newProject = () => {
    getAudioEngine()?.stopAll();
    setProjectFilePath("");
    setProjectInstruments([]);
    setProjectTitle("Untitled");
    setProjectPpq(PPQ);
    setProjectMetadata(null);
    setTracks([]);
    setBarCount(16);
    setSelectedTrackId("");
    setSelectedNoteId(null);
    setPlayhead(0);
    setPast([]);
    setFuture([]);
    setCandidates([]);
    setTempo(120);
    setTimeSigNumerator(4);
    setTimeSigDenominator(4);
    setGridTicks(Math.max(1, Math.round(PPQ / 4)));
    setMessages([{ id: uid("message"), author: "agent", text: WELCOME_MESSAGE }]);
    showToast("已新建空工程");
  };

  const persistProject = async (path: string | null) => {
    if (!magent?.saveProject) return showToast("桌面文件桥尚未连接");
    try {
      let result: SaveResult;
      if (path && magent.saveProjectTo) {
        result = await magent.saveProjectTo(projectPayload(), path);
      } else {
        result = await magent.saveProject(projectPayload());
      }
      if (!result.canceled) {
        setProjectFilePath(result.filePath ?? "");
        showToast("工程已保存");
        void loadRecentProjects();
      }
    } catch (error) { showToast(errorMessage(error, "工程保存失败")); }
  };

  /** 保存项目：有当前路径则免对话框直写，否则弹另存为对话框。 */
  const handleSaveProject = () => void persistProject(projectFilePath || null);
  /** 项目另存为：总是弹出对话框选择新路径。 */
  const saveProjectAs = () => void persistProject(null);

  const openRecentProject = async (path: string): Promise<boolean> => {
    if (!magent?.openProjectAt) { showToast("桌面文件桥尚未连接"); return false; }
    try {
      const loaded = loadProjectResult(await magent.openProjectAt(path), "工程");
      if (loaded) void loadRecentProjects();
      return loaded;
    } catch (error) { showToast(errorMessage(error, "打开最近工程失败")); return false; }
  };

  const loadRecentProjects = useCallback(async () => {
    if (!magent?.listRecentProjects) return;
    try { setRecentProjects(await magent.listRecentProjects()); } catch { /* 忽略 */ }
  }, [magent]);

  /** 新建/打开/导入统一先询问：在当前窗口还是新窗口。 */
  const requestWindowChoice = (intent: ProjectOpenIntent) => setWindowChoice(intent);
  const confirmWindowChoice = (intent: ProjectOpenIntent, target: "current" | "new") => {
    setWindowChoice(null);
    if (target === "new") {
      void magent?.createProjectWindow(intent);
      return;
    }
    if (intent === "new-project") newProject();
    else if (intent === "open-project") void handleOpenProject();
    else void handleOpen();
  };

  const handleExport = async () => {
    if (!magent?.exportMidi) return showToast("桌面文件桥尚未连接，导出将在集成后可用");
    try {
      const result = await magent.exportMidi(projectPayload());
      if (!result.canceled) showToast("MIDI 已导出");
    } catch (error) { showToast(errorMessage(error, "导出失败")); }
  };

  /** 离线渲染 + 编码 + 保存 WAV/OGG。 */
  const handleExportAudio = async (format: ExportAudioFormat, sampleRate: ExportSampleRate) => {
    if (exportBusy) return;
    if (!magent?.exportAudio) {
      setExportDialog(null);
      return showToast("桌面文件桥尚未连接，音频导出不可用");
    }
    setExportBusy(true);
    try {
      const buffer = await renderProjectToBuffer({
        title: projectTitle,
        tracks,
        ppq: projectPpq,
        tempo,
        sampleRate,
        maxSeconds: exportSettings.maxMinutes * 60,
        loopRegion: exportLoopOnly ? (projectMetadata?.loopRegion ?? null) : null,
        resolveInstrument: (libraryId) => {
          const entry = findInstrumentEntry(libraryId);
          return entry ? { path: entry.path, enabled: entry.enabled, sfzRegions: entry.sfzRegions } : undefined;
        },
        fetchBytes: async (path) => {
          if (!magent?.readInstrumentFile) throw new Error("桌面音源桥尚未连接");
          return magent.readInstrumentFile(path);
        },
      });
      const bytes = await encodeAudioBuffer(buffer, format);
      const result = await magent.exportAudio({ format, bytes, defaultName: `${projectTitle || "audio"}` });
      if (!result.canceled) showToast(format === "ogg" ? "OGG 音频已导出" : "WAV 音频已导出");
    } catch (error) {
      showToast(errorMessage(error, "音频导出失败"));
    } finally {
      setExportBusy(false);
      setExportDialog(null);
    }
  };

  const runMenuAction = useCallback((action: string, payload?: string) => {
    setActiveMenu(null);
    if (action === "file-new-project") requestWindowChoice("new-project");
    else if (action === "file-open-midi") requestWindowChoice("import-midi");
    else if (action === "file-open-project") requestWindowChoice("open-project");
    else if (action === "open-recent-project" && payload) openRecentProject(payload);
    else if (action === "file-save-project") handleSaveProject();
    else if (action === "file-save-project-as") saveProjectAs();
    else if (action === "file-export-midi") void handleExport();
    else if (action === "file-export-wav") setExportDialog("wav");
    else if (action === "file-export-ogg") setExportDialog("ogg");
    else if (action === "edit-undo") undo();
    else if (action === "edit-redo") redo();
    else if (action === "view-check-environment") void refreshEnvironment();
    else if (action === "view-settings") { setSettingsSection("general"); setSettingsOpen(true); }
    else if (action === "window-minimize") void magent?.minimizeWindow();
    else if (action === "window-maximize") void magent?.toggleMaximizeWindow();
    else if (action === "window-close") void magent?.closeWindow();
    else if (action === "instruments-settings") { setSettingsSection("sound"); setSettingsOpen(true); }
    else if (action === "plugins-settings") { setSettingsSection("plugins"); setSettingsOpen(true); }
    else if (action === "help-about") showToast("M Agent · 面向独立游戏开发者的桌面 MIDI 创作 Agent");
    else if (action === "help-settings") { setSettingsSection("general"); setSettingsOpen(true); }
  }, [magent, openRecentProject, requestWindowChoice, saveProjectAs, handleSaveProject, handleExport, undo, redo, refreshEnvironment, showToast]);
  useEffect(() => {
    const onMenuShortcut = (event: KeyboardEvent) => {
      // macOS 由原生菜单加速键处理，避免与 in-app 快捷键重复触发。
      if (isMac) return;
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "n") { event.preventDefault(); requestWindowChoice("new-project"); }
      else if (key === "o" && !event.shiftKey) { event.preventDefault(); requestWindowChoice("open-project"); }
      else if (key === "o" && event.shiftKey) { event.preventDefault(); requestWindowChoice("import-midi"); }
      else if (key === "s" && !event.shiftKey) { event.preventDefault(); handleSaveProject(); }
      else if (key === "s" && event.shiftKey) { event.preventDefault(); saveProjectAs(); }
      else if (key === "w") { event.preventDefault(); void magent?.closeWindow(); }
    };
    window.addEventListener("keydown", onMenuShortcut);
    return () => window.removeEventListener("keydown", onMenuShortcut);
  }, [isMac, magent, requestWindowChoice, handleSaveProject, saveProjectAs]);

  // macOS 原生菜单动作转发到 runMenuAction。
  useEffect(() => {
    if (!magent?.onMenuAction) return;
    return magent.onMenuAction(runMenuAction);
  }, [magent, runMenuAction]);

  // macOS 原生菜单「最近打开项目」点击。
  useEffect(() => {
    if (!magent?.onMenuOpenRecent) return;
    return magent.onMenuOpenRecent(openRecentProject);
  }, [magent, openRecentProject]);

  // Agent 运行中的实时调用更新（工具调用 / 轮次 / Skill 调用 / 思考增量）。
  useEffect(() => {
    if (!magent?.onAgentLive) return;
    const scheduleThinkingUi = () => {
      if (liveThinkingUiTimerRef.current != null) return;
      liveThinkingUiTimerRef.current = window.setTimeout(() => {
        liveThinkingUiTimerRef.current = null;
        const text = liveThinkingRef.current;
        if (!text) return;
        setMessages((items) => items.map((message) => message.id === runMessageIdRef.current
          ? { ...message, streamingThinking: text, streamingThinkingStartedAt: liveThinkingStartedAtRef.current || undefined }
          : message));
      }, 120);
    };
    const scheduleThinkingFlush = () => {
      if (liveThinkingFlushTimerRef.current != null) window.clearTimeout(liveThinkingFlushTimerRef.current);
      liveThinkingFlushTimerRef.current = window.setTimeout(() => {
        liveThinkingFlushTimerRef.current = null;
        const text = liveThinkingRef.current;
        const startedAt = liveThinkingStartedAtRef.current;
        liveThinkingRef.current = "";
        liveThinkingStartedAtRef.current = 0;
        if (!text) return;
        // 一段思考完成：追加为已收起条目（附该段耗时），清除流式占位。
        setMessages((items) => items.map((message) => message.id === runMessageIdRef.current
          ? { ...message, thinking: [...(message.thinking ?? []), { text, durationMs: startedAt ? Date.now() - startedAt : undefined }], streamingThinking: "", streamingThinkingStartedAt: undefined }
          : message));
      }, 800);
    };
    const unsubscribe = magent.onAgentLive((update) => {
      if (update.kind === "turn") {
        setAgentLive((current) => ({ ...current, turns: update.turns }));
        return;
      }
      if (update.kind === "thinking") {
        if (!liveThinkingRef.current) liveThinkingStartedAtRef.current = Date.now();
        liveThinkingRef.current += update.text;
        scheduleThinkingUi();
        scheduleThinkingFlush();
        return;
      }
      if (update.kind === "tool_start") {
        setAgentLive((current) => ({
          ...current,
          currentTool: update.name,
          toolCalls: { ...current.toolCalls, [update.name]: (current.toolCalls[update.name] ?? 0) + 1 },
        }));
        return;
      }
      if (update.kind === "tool_end") {
        setAgentLive((current) => ({ ...current, currentTool: null }));
        return;
      }
      if (update.kind === "skill") {
        setAgentLive((current) => ({
          ...current,
          skills: [...current.skills.slice(-7), { skill: update.skill, status: update.status, depth: update.depth, durationMs: update.durationMs }],
        }));
      }
    });
    return () => {
      unsubscribe();
      if (liveThinkingUiTimerRef.current != null) window.clearTimeout(liveThinkingUiTimerRef.current);
      if (liveThinkingFlushTimerRef.current != null) window.clearTimeout(liveThinkingFlushTimerRef.current);
      liveThinkingUiTimerRef.current = null;
      liveThinkingFlushTimerRef.current = null;
      liveThinkingStartedAtRef.current = 0;
    };
  }, [magent]);

  useEffect(() => { void loadRecentProjects(); }, [loadRecentProjects]);

  // 新窗口启动意图：新建 / 打开 / 导入在目标窗口内自动执行。
  // 无显式意图时：自动打开最近一个工程；没有则新建空工程。
  useEffect(() => {
    const intent = magent?.startupIntent;
    if (intent === "new-project") { newProject(); return; }
    if (intent === "open-project") { void handleOpenProject(); return; }
    if (intent === "import-midi") { void handleOpen(); return; }
    if (!magent?.listRecentProjects) { newProject(); return; }
    let cancelled = false;
    magent.listRecentProjects()
      .then(async (projects) => {
        if (cancelled) return;
        if (projects.length === 0) { newProject(); return; }
        const opened = await openRecentProject(projects[0].path);
        if (!opened) newProject();
      })
      .catch(() => { if (!cancelled) newProject(); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [magent]);

  // 测试/自动化钩子：允许通过 window 事件触发菜单动作（例如 Electron smoke 在原生菜单模式下打开设置）。
  useEffect(() => {
    const handler = (event: Event) => {
      const action = (event as CustomEvent<string>).detail;
      if (action) runMenuAction(action);
    };
    window.addEventListener("magent:menu-action", handler);
    return () => window.removeEventListener("magent:menu-action", handler);
  }, [runMenuAction]);

  const saveKey = async () => {
    const clean = apiKey.trim();
    if (!clean) return;
    if (!magent?.saveProviderApiKey) return showToast("桌面安全存储桥尚未连接");
    try {
      const report = await magent.saveProviderApiKey("openai", clean);
      setEnvironment(report);
      setApiKey("");
      showToast("API Key 已保存到系统安全存储");
    } catch (error) { showToast(errorMessage(error, "API Key 保存失败")); }
  };

  const clearSavedKey = async () => {
    if (!magent?.clearProviderApiKey) return showToast("桌面安全存储桥尚未连接");
    try {
      const report = await magent.clearProviderApiKey("openai");
      setEnvironment(report);
      showToast("应用内 API Key 已清除");
    } catch (error) { showToast(errorMessage(error, "API Key 清除失败")); }
  };

  const loginSubscription = async () => {
    if (!magent?.loginOpenAICodex) return showToast("桌面认证桥尚未连接");
    setEnvironmentBusy(true);
    try {
      const report = await magent.loginOpenAICodex();
      setEnvironment(report);
      setEnvironmentError(null);
      showToast("ChatGPT Plus/Pro 登录成功");
    } catch (error) { showToast(errorMessage(error, "订阅登录失败")); }
    finally { setEnvironmentBusy(false); }
  };

  const logoutSubscription = async () => {
    if (!magent?.logoutOpenAICodex) return showToast("桌面认证桥尚未连接");
    setEnvironmentBusy(true);
    try {
      const report = await magent.logoutOpenAICodex();
      setEnvironment(report);
      showToast("应用内订阅登录已退出");
    } catch (error) { showToast(errorMessage(error, "退出登录失败")); }
    finally { setEnvironmentBusy(false); }
  };

  const loadSubscriptions = useCallback(async () => {
    if (!magent?.listSubscriptions) return;
    try {
      setSubscriptions(await magent.listSubscriptions());
    } catch (error) {
      showToast(errorMessage(error, "读取订阅档案失败"));
    }
  }, [magent, showToast]);

  useEffect(() => { void loadSubscriptions(); }, [loadSubscriptions]);

  useEffect(() => {
    if (settingsOpen && settingsSection === "providers") void loadSubscriptions();
  }, [loadSubscriptions, settingsOpen, settingsSection]);

  const openNewProvider = useCallback(() => {
    setPresetPickerOpen(false);
    setEditingSubscriptionId(null);
    setSubscriptionDraft({
      name: "",
      providerId: "",
      apiType: "openai-completions",
      baseUrl: "",
      apiKey: "",
      models: [],
      notes: "",
    });
    setProvidersView("edit");
  }, []);

  const openProviderEditor = useCallback((profile: SubscriptionSummary | ProviderPreset | null) => {
    if (!profile) {
      setProvidersView("list");
      setEditingSubscriptionId(null);
      setSubscriptionDraft(null);
      return;
    }
    if ("models" in profile && "hasApiKey" in profile) {
      setEditingSubscriptionId(profile.id);
      setSubscriptionDraft({
        name: profile.name,
        providerId: profile.providerId,
        apiType: profile.apiType,
        baseUrl: profile.baseUrl,
        apiKey: "",
        models: profile.models.map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow })),
        notes: profile.notes ?? "",
        activeModelId: profile.activeModelId,
      });
    } else {
      setEditingSubscriptionId(null);
      setSubscriptionDraft({
        name: profile.name,
        providerId: profile.providerId,
        apiType: profile.apiType,
        baseUrl: profile.baseUrl,
        apiKey: "",
        models: profile.models.map((model) => ({ id: model.id, name: model.name, contextWindow: model.contextWindow })),
        notes: profile.notes ?? "",
      });
    }
    setProvidersView("edit");
  }, []);

  const saveSubscriptionDraft = async () => {
    if (!magent?.createSubscription || !magent?.updateSubscription) return showToast("桌面存储桥尚未连接");
    if (!subscriptionDraft) return;
    if (!subscriptionDraft.name.trim()) return showToast("请填写显示名称");
    if (!subscriptionDraft.baseUrl.trim()) return showToast("请填写 BaseURL");
    setSubscriptionBusy(true);
    try {
      if (editingSubscriptionId) {
        await magent.updateSubscription(editingSubscriptionId, subscriptionDraft);
        showToast("订阅档案已更新");
      } else {
        await magent.createSubscription(subscriptionDraft);
        showToast("订阅档案已创建");
      }
      setProvidersView("list");
      setEditingSubscriptionId(null);
      setSubscriptionDraft(null);
      await loadSubscriptions();
      await refreshEnvironment();
    } catch (error) {
      showToast(errorMessage(error, "保存订阅档案失败"));
    } finally {
      setSubscriptionBusy(false);
    }
  };

  const deleteSelectedSubscription = async () => {
    const profile = subscriptions.find((subscription) => subscription.id === editingSubscriptionId);
    if (!profile) return;
    if (!magent?.deleteSubscription) return showToast("桌面存储桥尚未连接");
    setSubscriptionBusy(true);
    try {
      await magent.deleteSubscription(profile.id);
      setProvidersView("list");
      setEditingSubscriptionId(null);
      setSubscriptionDraft(null);
      await loadSubscriptions();
      await refreshEnvironment();
      showToast(`已删除订阅「${profile.name}」`);
    } catch (error) {
      showToast(errorMessage(error, "删除订阅失败"));
    } finally {
      setSubscriptionBusy(false);
    }
  };

  const activateSelectedSubscription = async (id: string) => {
    if (!magent?.activateSubscription) return showToast("桌面存储桥尚未连接");
    setSubscriptionBusy(true);
    try {
      setSubscriptions(await magent.activateSubscription(id));
      await refreshEnvironment();
      showToast("已切换为当前订阅");
    } catch (error) {
      showToast(errorMessage(error, "激活订阅失败"));
    } finally {
      setSubscriptionBusy(false);
    }
  };

  /** 在对话界面切换当前订阅使用的模型并持久化。 */
  const setActiveModel = async (modelId: string) => {
    if (!activeSubscription || !magent?.updateSubscription) return;
    try {
      await magent.updateSubscription(activeSubscription.id, {
        name: activeSubscription.name,
        providerId: activeSubscription.providerId,
        apiType: activeSubscription.apiType,
        baseUrl: activeSubscription.baseUrl,
        models: activeSubscription.models,
        activeModelId: modelId,
      });
      setModelMenuOpen(false);
      await loadSubscriptions();
      showToast(`已切换模型：${modelId}`);
    } catch (error) {
      showToast(errorMessage(error, "切换模型失败"));
    }
  };

  const importExistingSubscriptions = async () => {
    if (!magent?.importSubscriptions) return showToast("桌面导入桥尚未连接");
    setSubscriptionBusy(true);
    try {
      const result = await magent.importSubscriptions();
      await loadSubscriptions();
      await refreshEnvironment();
      if (result.imported === 0 && result.skipped.length === 0) {
        showToast("未发现可导入的订阅");
      } else {
        const skipped = result.skipped.length ? `；跳过 ${result.skipped.length} 项` : "";
        showToast(`已导入 ${result.imported} 个订阅${skipped}`);
      }
    } catch (error) {
      showToast(errorMessage(error, "导入订阅失败"));
    } finally {
      setSubscriptionBusy(false);
    }
  };

  const runFetchModels = async () => {
    if (!magent?.fetchSubscriptionModels) return showToast("桌面拉取桥尚未连接");
    if (!subscriptionDraft) return;
    if (!subscriptionDraft.baseUrl.trim()) return showToast("请先填写 BaseURL");
    if (!subscriptionDraft.apiKey?.trim()) return showToast("请先填写 API Key");
    setFetchingModels(true);
    try {
      const request: FetchModelsRequest = {
        apiType: subscriptionDraft.apiType,
        baseUrl: subscriptionDraft.baseUrl,
        apiKey: subscriptionDraft.apiKey.trim(),
      };
      const result = await magent.fetchSubscriptionModels(request);
      setSubscriptionDraft((current) => current ? {
        ...current,
        models: result.models.map((model) => ({ id: model.id, name: model.name })),
      } : current);
      showToast(result.message ?? `拉取到 ${result.models.length} 个模型`);
    } catch (error) {
      showToast(errorMessage(error, "拉取模型失败"));
    } finally {
      setFetchingModels(false);
    }
  };

  const updateDraftModel = (index: number, patch: Partial<SubscriptionModel>) => {
    setSubscriptionDraft((current) => {
      if (!current) return current;
      const models = current.models.map((model, modelIndex) => modelIndex === index ? { ...model, ...patch } : model);
      return { ...current, models };
    });
  };

  const addDraftModel = () => {
    setSubscriptionDraft((current) => {
      if (!current) return current;
      const next: SubscriptionModel = { id: "", name: "" };
      return { ...current, models: [...current.models, next] };
    });
  };

  const removeDraftModel = (index: number) => {
    setSubscriptionDraft((current) => {
      if (!current) return current;
      return { ...current, models: current.models.filter((_, modelIndex) => modelIndex !== index) };
    });
  };

  const loadUsageSummary = useCallback(async () => {
    if (!magent?.getUsageSummary) return;
    try {
      setUsageSummary(await magent.getUsageSummary());
    } catch (error) {
      showToast(errorMessage(error, "读取用量汇总失败"));
    }
  }, [magent, showToast]);

  const loadUsageData = useCallback(async (view: "day" | "model", page: number) => {
    if (!magent?.getUsageDays || !magent?.getUsageModels) return;
    setUsageBusy(true);
    try {
      const data = view === "day" ? await magent.getUsageDays(page) : await magent.getUsageModels(page);
      setUsageData(data);
    } catch (error) {
      showToast(errorMessage(error, "读取用量列表失败"));
    } finally {
      setUsageBusy(false);
    }
  }, [magent, showToast]);

  useEffect(() => {
    if (settingsOpen && settingsSection === "usage") {
      void loadUsageSummary();
      void loadUsageData(usageView, usagePage);
    }
  }, [loadUsageData, loadUsageSummary, settingsOpen, settingsSection, usagePage, usageView]);

  const clearUsageStatistics = async () => {
    if (!magent?.clearUsage) return showToast("桌面用量桥尚未连接");
    setUsageBusy(true);
    try {
      await magent.clearUsage();
      setUsageSummary(null);
      setUsageData(null);
      setUsagePage(1);
      await loadUsageSummary();
      await loadUsageData(usageView, 1);
      showToast("本地用量统计已清空");
    } catch (error) {
      showToast(errorMessage(error, "清空用量统计失败"));
    } finally {
      setUsageBusy(false);
    }
  };

  const formatUsageTokens = (value: number) => value.toLocaleString("zh-CN");
  const formatUsageCost = (value: number) => `$${value.toFixed(4)}`;

  const playPosition = useMemo(() => {
    const totalBeats = playhead / projectPpq;
    const bar = Math.floor(totalBeats / BEATS_PER_BAR) + 1;
    const beat = Math.floor(totalBeats % BEATS_PER_BAR) + 1;
    const subdivision = Math.floor((totalBeats % 1) * 4) + 1;
    return `${String(bar).padStart(2, "0")}:${beat}:${subdivision}`;
  }, [playhead, projectPpq]);

  /** 工程最长轨道的末尾 tick（无音符为 0）。 */
  const projectEndTick = useMemo(() => tracks.reduce(
    (maxTick, track) => Math.max(maxTick, ...track.notes.map((note) => note.startTick + note.durationTicks)),
    0,
  ), [tracks]);

  /** 0 基 bar:beat:subdivision（用于时长，空工程为 00:0:0）。 */
  const formatBarBeat = (tick: number) => {
    const totalBeats = tick / projectPpq;
    const bar = Math.max(0, Math.floor(totalBeats / BEATS_PER_BAR));
    const beat = Math.max(0, Math.floor(totalBeats % BEATS_PER_BAR));
    const subdivision = Math.max(0, Math.floor((totalBeats % 1) * 4));
    return `${String(bar).padStart(2, "0")}:${beat}:${subdivision}`;
  };

  /** tick → mm:ss（按当前 BPM）。 */
  const formatDuration = (tick: number) => {
    const seconds = Math.floor(tick * 60 / (projectPpq * tempo));
    return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
  };

  /** 毫秒 → 人类可读时长（用于思考耗时展示）。 */
  const formatThinkingTime = (ms: number) => {
    if (!Number.isFinite(ms) || ms <= 0) return "";
    if (ms < 1_000) return `${Math.round(ms)}ms`;
    return `${(ms / 1_000).toFixed(1)}s`;
  };

  /** 所有思考段耗时的总和（无耗时信息的段不参与）。 */
  const thinkingTotalMs = (thinking?: ThinkingSegment[]) =>
    (thinking ?? []).reduce((sum, segment) => sum + (segment.durationMs ?? 0), 0);

  const environmentMessages = environmentError
    ? [{ id: "environment-report", message: environmentError, instruction: "请重新检测；若问题持续，请重新启动应用。", action: "repair-app" as const }]
    : environment?.issues ?? [];
  const showInstrumentWarning = instrumentLibraryLoaded && instrumentLibrary.length === 0 && projectInstruments.length === 0 && !instrumentWarningDismissed;
  const alertCount = (environmentMessages.length > 0 ? 1 : 0) + (showInstrumentWarning ? 1 : 0);
  const openAIStatus = environment?.providers.find((provider) => provider.id === "openai");
  const codexStatus = environment?.providers.find((provider) => provider.id === "openai-codex");
  const online = environment?.agentReady ?? false;
  const activeSubscription = subscriptions.find((subscription) => subscription.isActive);
  const activeModelId = activeSubscription
    ? (activeSubscription.activeModelId ?? activeSubscription.models[0]?.id ?? "")
    : "";
  const activeModelLabel = (() => {
    if (!activeSubscription) return "";
    const model = activeSubscription.models.find((item) => item.id === activeModelId);
    return model?.name || activeModelId || "未选择模型";
  })();
  const providerLabel = activeSubscription
    ? activeSubscription.name
    : environment?.activeProvider === "openai"
      ? "OpenAI API"
      : environment?.activeProvider === "openai-codex"
        ? "ChatGPT 订阅"
        : "Pi 离线模式";
  const activeSettings = settingsSections.find((section) => section.id === settingsSection) ?? settingsSections[0];
  const filteredProviderPresets = useMemo(() => {
    const query = presetSearch.trim().toLowerCase();
    if (!query) return PROVIDER_PRESETS;
    return PROVIDER_PRESETS.filter((preset) => (
      preset.name.toLowerCase().includes(query)
      || subscriptionApiTypeLabel(preset.apiType).toLowerCase().includes(query)
      || preset.baseUrl.toLowerCase().includes(query)
      || preset.models.some((model) => model.name.toLowerCase().includes(query) || model.id.toLowerCase().includes(query))
    ));
  }, [presetSearch]);
  const activeTheme = themePresets.find((theme) => theme.id === appearance.theme) ?? themePresets[0];
  const totalNotes = tracks.reduce((count, track) => count + track.notes.length, 0);
  const secureStorageReady = environment?.checks.find((check) => check.id === "secure-storage")?.status === "ready";
  const splitterCount = workspaceLayout.agentHidden ? 1 : 2;
  const availableForSidebars = Math.max(
    0,
    workspaceWidth - WORKSPACE_LAYOUT_LIMITS.editorMin - splitterCount * WORKSPACE_LAYOUT_LIMITS.splitterSize,
  );
  const tracksWidthMax = Math.max(
    WORKSPACE_LAYOUT_LIMITS.tracksMin,
    Math.min(
      WORKSPACE_LAYOUT_LIMITS.tracksMax,
      availableForSidebars - (workspaceLayout.agentHidden ? 0 : workspaceLayout.agentWidth),
    ),
  );
  const agentWidthMax = Math.max(
    WORKSPACE_LAYOUT_LIMITS.agentMin,
    Math.min(WORKSPACE_LAYOUT_LIMITS.agentMax, availableForSidebars - workspaceLayout.tracksWidth),
  );

  return (
    <div className={`app-shell ${isMac ? "macos" : ""} ${alertCount === 1 ? "has-one-alert" : alertCount === 2 ? "has-two-alerts" : ""}`}>
      <header className={`titlebar ${isMac ? "macos" : ""}`}>
        {!isMac && (
          <div className="brand" aria-label="M Agent">
            <span className="brand-mark">M<span>/</span>A</span>
            <nav className="menu-bar" ref={menuBarRef} aria-label="应用菜单">
              {APP_MENU_GROUPS.map((group) => (
                <div key={group.key} className={`menu-group ${activeMenu === group.key ? "open" : ""}`}>
                  <button
                    type="button"
                    className="menu-trigger"
                    aria-expanded={activeMenu === group.key}
                    onClick={() => setActiveMenu((current) => current === group.key ? null : group.key)}
                  >{group.label}{group.accessKey ? <span className="menu-access">({group.accessKey})</span> : null}</button>
                  {activeMenu === group.key && (
                    <div className="menu-panel" role="menu">
                      <MenuItemList
                        items={group.items.filter((item) => !item.role && !item.separator)}
                        recentProjects={recentProjects}
                        onAction={runMenuAction}
                      />
                    </div>
                  )}
                </div>
              ))}
            </nav>
          </div>
        )}
      </header>

      {environmentMessages.length > 0 && (
        <section className="environment-alert" role="alert" aria-live="polite">
          <Icon name="warning" />
          <div>
            <strong>{environmentMessages.map((issue) => issue.message).join("；")}</strong>
            <span>{environmentMessages.map((issue) => issue.instruction).join(" ")}</span>
          </div>
          <div className="environment-alert-actions">
            {environmentMessages.some((issue) => issue.action === "open-shell-settings") && (
              <button onClick={openShellSettings}>配置 Shell</button>
            )}
            {environmentMessages.some((issue) => issue.action === "open-provider-settings") && (
              <button onClick={() => { setSettingsSection("providers"); setSettingsOpen(true); }}>配置供应商</button>
            )}
          </div>
          <button disabled={environmentBusy} onClick={() => void refreshEnvironment()}>{environmentBusy ? "检测中…" : "重新检测"}</button>
        </section>
      )}

      {showInstrumentWarning && (
        <section className="instrument-alert" role="alert" aria-live="polite">
          <Icon name="warning" />
          <div>
            <strong>尚未配置音源</strong>
            <span>为获得真实音色试听，请在设置 → 音源 中「添加」工程音源，或把音源文件放入系统级音源库目录（打开文件夹）后扫描；未配置时轨道使用默认振荡器。</span>
          </div>
          <div className="instrument-alert-actions">
            <button onClick={() => { setSettingsSection("sound"); setSettingsOpen(true); }}>配置音源</button>
          </div>
          <button className="instrument-alert-close" onClick={dismissInstrumentWarning} aria-label="关闭音源提示"><Icon name="close" size={12} /></button>
        </section>
      )}

      <section className="transport" aria-label="播放控制">
        <div className="transport-group">
          <button className="icon-button" disabled={!past.length} onClick={undo} title="撤销 Ctrl+Z"><Icon name="undo" /></button>
          <button className="icon-button" disabled={!future.length} onClick={redo} title="重做 Ctrl+Y"><Icon name="redo" /></button>
        </div>
        <div className="transport-group transport-main">
          <button className="transport-circle" onClick={() => setIsPlaying((value) => !value)} aria-label={isPlaying ? "暂停" : "播放"}>
            <Icon name={isPlaying ? "pause" : "play"} size={18} />
          </button>
          <button className="icon-button" onClick={() => { setIsPlaying(false); setPlayhead(0); }} aria-label="停止"><Icon name="stop" /></button>
          <div className="position-readout">{playPosition} / {formatBarBeat(projectEndTick)} / {formatDuration(projectEndTick)}</div>
        </div>
        <label className="transport-field"><span>BPM</span><input type="number" min="40" max="240" value={tempo} onChange={(event) => setTempo(clamp(Number(event.target.value), 40, 240))} /></label>
        <div className="transport-field"><span>拍号</span>
          <div className="time-signature" ref={timeSigRef}>
            <div className="time-sig-field">
              <button
                type="button"
                className="time-sig-trigger"
                aria-expanded={timeSigOpen === "numerator"}
                onClick={() => setTimeSigOpen((current) => current === "numerator" ? null : "numerator")}
              >{timeSigNumerator}</button>
              {timeSigOpen === "numerator" && (
                <div className="time-sig-menu" role="listbox" aria-label="拍号分子">
                  {(TIME_SIGNATURE_NUMERATORS[timeSigDenominator] ?? TIME_SIGNATURE_NUMERATORS[4]).map((value) => (
                    <button
                      key={value}
                      type="button"
                      role="option"
                      aria-selected={timeSigNumerator === value}
                      className={timeSigNumerator === value ? "active" : ""}
                      onClick={() => { setTimeSigNumerator(value); setTimeSigOpen(null); }}
                    >{value}</button>
                  ))}
                </div>
              )}
            </div>
            <i>/</i>
            <div className="time-sig-field">
              <button
                type="button"
                className="time-sig-trigger"
                aria-expanded={timeSigOpen === "denominator"}
                onClick={() => setTimeSigOpen((current) => current === "denominator" ? null : "denominator")}
              >{timeSigDenominator}</button>
              {timeSigOpen === "denominator" && (
                <div className="time-sig-menu" role="listbox" aria-label="拍号分母">
                  {TIME_SIGNATURE_DENOMINATORS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      role="option"
                      aria-selected={timeSigDenominator === value}
                      className={timeSigDenominator === value ? "active" : ""}
                      onClick={() => {
                        setTimeSigDenominator(value);
                        setTimeSigNumerator((current) => normalizeTimeSignatureNumerator(current, value));
                        setTimeSigOpen(null);
                      }}
                    >{value}</button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="transport-divider" />
        <div className="tool-switch" aria-label="编辑工具">
          <button className={tool === "pointer" ? "active" : ""} onClick={() => setTool("pointer")} title="选择与拖动"><Icon name="pointer" /></button>
          <button className={tool === "pencil" ? "active" : ""} onClick={() => setTool("pencil")} title="绘制音符"><Icon name="pencil" /></button>
        </div>
        <label className="compact-select"><span>网格</span><select value={gridTicks} onChange={(event) => setGridTicks(Number(event.target.value))}><option value={Math.max(1, Math.round(projectPpq / 2))}>1/8</option><option value={Math.max(1, Math.round(projectPpq / 4))}>1/16</option><option value={Math.max(1, Math.round(projectPpq / 8))}>1/32</option></select></label>
        <label className="zoom-control"><span>−</span><input type="range" min="0.55" max="2" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /><span>＋</span></label>
        <div className="transport-spacer" />
        <button
          ref={agentPanelToggleRef}
          className={`icon-button agent-panel-toggle ${workspaceLayout.agentHidden ? "" : "active"}`}
          aria-label={workspaceLayout.agentHidden ? "显示 Agent 面板" : "隐藏 Agent 面板"}
          aria-controls="agent-panel"
          aria-expanded={!workspaceLayout.agentHidden}
          title={workspaceLayout.agentHidden ? "显示 Agent 面板" : "隐藏 Agent 面板"}
          onClick={() => setAgentPanelHidden(!workspaceLayout.agentHidden)}
        >
          <Icon name="panel" />
        </button>
        <div className="engine-status"><span className={online ? "status-light online" : "status-light"} />{providerLabel}</div>
      </section>

      <main
        ref={workspaceRef}
        className={`workspace ${workspaceLayout.agentHidden ? "agent-hidden" : ""}`}
        style={{
          "--tracks-width": `${workspaceLayout.tracksWidth}px`,
          "--agent-width": `${workspaceLayout.agentWidth}px`,
        } as React.CSSProperties}
      >
        <aside id="tracks-panel" className="tracks-panel">
          <div className="panel-heading">
            <div><span>TRACKS</span><strong>{tracks.length}</strong></div>
            <button className="icon-button small" onClick={addTrack} aria-label="添加轨道"><Icon name="plus" /></button>
          </div>
          <div className="track-list">
            {tracks.map((track, index) => (
              <button key={track.id} className={`track-row ${track.id === selectedTrackId ? "selected" : ""}`} onClick={() => { setSelectedTrackId(track.id); setSelectedNoteId(null); }}>
                <span className="track-number">{String(index + 1).padStart(2, "0")}</span>
                <span className="track-color" style={{ "--track-color": track.color } as React.CSSProperties} />
                <span className="track-copy"><strong>{track.name}</strong><small>{track.role} · {track.notes.length} notes</small></span>
                <span className="track-toggles">
                  <span role="button" tabIndex={0} className={track.muted ? "active" : ""} title="静音" onClick={(event) => { event.stopPropagation(); updateTrack(track.id, { muted: !track.muted }); }}>M</span>
                  <span role="button" tabIndex={0} className={track.solo ? "solo active" : ""} title="独奏" onClick={(event) => { event.stopPropagation(); updateTrack(track.id, { solo: !track.solo }); }}>S</span>
                </span>
              </button>
            ))}
          </div>
          {tracks.length > 0 && (
          <div className="track-inspector">
            <div className="inspector-label">SELECTED TRACK</div>
            <label><span>名称</span><input value={selectedTrack?.name ?? ""} onChange={(event) => setTracks(tracks.map((track) => track.id === selectedTrackId ? { ...track, name: event.target.value } : track))} onBlur={() => setPast((history) => history)} /></label>
            <label><span>角色</span><select value={selectedTrack?.role ?? "other"} onChange={(event) => updateTrack(selectedTrackId, { role: event.target.value as TrackRole })}><option value="melody">Melody</option><option value="harmony">Harmony</option><option value="bass">Bass</option><option value="drums">Drums</option><option value="other">Other</option></select></label>
            <label><span>音量</span><input type="range" min="0" max="1" step="0.01" value={selectedTrack?.volume ?? 1} onChange={(event) => updateTrack(selectedTrackId, { volume: Number(event.target.value) })} /></label>
            <label><span>音色</span>
              <select value={selectedTrack?.instrument?.type === "soundfont" ? `soundfont:${selectedTrack.instrument.libraryId}:${selectedTrack.instrument.bank}:${selectedTrack.instrument.program}` : selectedTrack?.instrument?.type === "sfz" ? `sfz:${selectedTrack.instrument.libraryId}` : "none"} onChange={(event) => {
                const value = event.target.value;
                if (value === "none") { updateTrack(selectedTrackId, { instrument: undefined }); return; }
                if (value.startsWith("sfz:")) {
                  updateTrack(selectedTrackId, { instrument: { type: "sfz", libraryId: value.slice("sfz:".length) } });
                  return;
                }
                const parts = value.slice("soundfont:".length).split(":");
                const libraryId = parts[0];
                const bank = Number(parts[1]);
                const program = Number(parts[2]);
                updateTrack(selectedTrackId, { instrument: { type: "soundfont", libraryId, bank, program } });
              }}>
                <option value="none">默认（振荡器）</option>
                {[...instrumentLibrary.filter((entry) => entry.type === "soundfont" && entry.enabled), ...projectInstruments.filter((entry) => entry.type === "soundfont")].map((entry) => {
                  const isProject = projectInstruments.some((item) => item.id === entry.id);
                  const presets = entry.presets ?? [];
                  if (presets.length === 0) {
                    return <option key={entry.id} value={`soundfont:${entry.id}:0:${selectedTrack?.program ?? 0}`}>{entry.name}{isProject ? "（工程）" : ""} · Program {selectedTrack?.program ?? 0}</option>;
                  }
                  return (
                    <optgroup key={entry.id} label={`${entry.name}${isProject ? "（工程）" : ""}`}>
                      {presets.map((preset) => (
                        <option key={`${entry.id}:${preset.bank}:${preset.program}`} value={`soundfont:${entry.id}:${preset.bank}:${preset.program}`}>{preset.name}</option>
                      ))}
                    </optgroup>
                  );
                })}
                {[...instrumentLibrary.filter((entry) => entry.type === "sfz" && entry.enabled), ...projectInstruments.filter((entry) => entry.type === "sfz")].map((entry) => (
                  <option key={entry.id} value={`sfz:${entry.id}`}>{entry.name}{projectInstruments.some((item) => item.id === entry.id) ? "（工程）" : ""}</option>
                ))}
              </select>
            </label>
            {selectedTrack?.instrument?.type === "soundfont" && (
              <label><span>音色号</span>
                <select value={`${selectedTrack.instrument.bank}:${selectedTrack.instrument.program}`} onChange={(event) => {
                  const [bank, program] = event.target.value.split(":").map(Number);
                  updateTrack(selectedTrackId, { instrument: { type: "soundfont", libraryId: selectedTrack.instrument!.libraryId, bank, program } });
                }}>
                  {(() => {
                    const entry = findInstrumentEntry(selectedTrack.instrument!.libraryId);
                    const presets = entry?.presets ?? [];
                    if (presets.length === 0) {
                      return <option value={`${selectedTrack.instrument!.bank}:${selectedTrack.instrument!.program}`}>使用默认音色</option>;
                    }
                    return presets.map((preset) => (
                      <option key={`${preset.bank}:${preset.program}`} value={`${preset.bank}:${preset.program}`}>{preset.name}</option>
                    ));
                  })()}
                </select>
              </label>
            )}
            <div className="inspector-track-actions">
              <button className="danger-text" disabled={!selectedTrackId} onClick={deleteSelectedTrack}><Icon name="trash" />删除轨道</button>
            </div>
            {selectedNote ? (
              <div className="note-inspector">
                <div className="inspector-label">SELECTED NOTE</div>
                <div className="note-data"><strong>{noteName(selectedNote.pitch)}</strong><span>VEL {selectedNote.velocity}</span></div>
                <label><span>力度</span><input type="range" min="1" max="127" value={selectedNote.velocity} onChange={(event) => setTracks(tracks.map((track) => ({ ...track, notes: track.notes.map((note) => note.id === selectedNote.id ? { ...note, velocity: Number(event.target.value) } : note) })))} onMouseUp={(event) => updateSelectedNote({ velocity: Number((event.target as HTMLInputElement).value) })} /></label>
                <button className="danger-text" onClick={deleteSelectedNote}><Icon name="trash" />删除音符</button>
              </div>
            ) : <p className="inspector-hint">双击空白处添加音符，拖动右边缘调整长度。</p>}
          </div>
          )}
        </aside>

        <div
          className={`workspace-resizer tracks-resizer ${resizingPane === "tracks" ? "is-resizing" : ""}`}
          role="separator"
          tabIndex={0}
          aria-label="调整音轨面板宽度"
          aria-controls="tracks-panel"
          aria-orientation="vertical"
          aria-valuemin={WORKSPACE_LAYOUT_LIMITS.tracksMin}
          aria-valuemax={Math.round(tracksWidthMax)}
          aria-valuenow={workspaceLayout.tracksWidth}
          onKeyDown={(event) => resizeWorkspaceWithKeyboard("tracks", event)}
          onPointerDown={(event) => beginWorkspaceResize("tracks", event)}
          onPointerMove={moveWorkspaceResize}
          onPointerUp={endWorkspaceResize}
          onPointerCancel={endWorkspaceResize}
          onLostPointerCapture={endWorkspaceResize}
        />

        <section className="editor-panel">
          <div className="editor-header">
            <div><strong>PIANO ROLL</strong><span>{selectedTrack?.name}</span></div>
            <div className="editor-legend"><span style={{ "--legend": selectedTrack?.color } as React.CSSProperties} />{selectedTrack?.notes.length ?? 0} NOTES</div>
          </div>
          <div className="canvas-scroll" ref={scrollRef}>
            <canvas
              ref={canvasRef}
              className={tool === "pencil" ? "pencil-cursor" : ""}
              onPointerDown={onCanvasPointerDown}
              onPointerMove={onCanvasPointerMove}
              onPointerUp={onCanvasPointerUp}
              onPointerCancel={onCanvasPointerUp}
              onContextMenu={onCanvasContextMenu}
              onDoubleClick={onCanvasDoubleClick}
            />
          </div>
          <footer className="editor-statusbar">
            <span><kbd>双击</kbd> 创建音符</span><span><kbd>拖动</kbd> 移动</span><span><kbd>边缘</kbd> 缩放</span><span><kbd>Del</kbd> 删除</span>
            <span className="status-spacer" />
            <span>{projectPpq} PPQ</span><span>16 BARS</span>
          </footer>
        </section>

        <div
          className={`workspace-resizer agent-resizer ${resizingPane === "agent" ? "is-resizing" : ""}`}
          role="separator"
          tabIndex={workspaceLayout.agentHidden ? -1 : 0}
          hidden={workspaceLayout.agentHidden}
          aria-label="调整 Agent 面板宽度"
          aria-controls="agent-panel"
          aria-orientation="vertical"
          aria-valuemin={WORKSPACE_LAYOUT_LIMITS.agentMin}
          aria-valuemax={Math.round(agentWidthMax)}
          aria-valuenow={workspaceLayout.agentWidth}
          onKeyDown={(event) => resizeWorkspaceWithKeyboard("agent", event)}
          onPointerDown={(event) => beginWorkspaceResize("agent", event)}
          onPointerMove={moveWorkspaceResize}
          onPointerUp={endWorkspaceResize}
          onPointerCancel={endWorkspaceResize}
          onLostPointerCapture={endWorkspaceResize}
        />

        <aside id="agent-panel" className="agent-panel" hidden={workspaceLayout.agentHidden}>
          <div className="agent-header">
            <div className="agent-title"><span className="agent-glyph"><Icon name="spark" /></span><div><strong>COMPOSER AGENT</strong><small>受控 MIDI 编辑器</small></div></div>
            <div className="agent-header-actions">
              <span className={`mode-badge ${mode}`}>{modeMeta[mode].short}</span>
              <button className="icon-button small" aria-label="隐藏 Agent 面板" onClick={() => setAgentPanelHidden(true, true)}><Icon name="close" size={14} /></button>
            </div>
          </div>
          <div className="mode-tabs">
            {(Object.keys(modeMeta) as AgentMode[]).map((item) => <button key={item} className={mode === item ? "active" : ""} onClick={() => setMode(item)}>{modeMeta[item].label}</button>)}
          </div>
          <div className={`mode-notice ${mode}`}>
            {mode === "research" && <Icon name="lock" />}
            {mode === "plan" && <Icon name="pointer" />}
            {mode === "goal" && <Icon name="spark" />}
            <span>{modeMeta[mode].description}</span>
          </div>

          <div className="conversation">
            {messages.map((message) => (
              <div key={message.id} className={`message ${message.author}`}>
                <span className="message-author">{message.author === "agent" ? "M/A" : "YOU"}</span>
                <div className="message-content">
                  {conversationSettings.showThinking && (
                    <>
                      {message.thinking && message.thinking.map((segment, index) => (
                        <details key={`${message.id}-thinking-${index}`} className="thinking-process">
                          <summary>思考 {index + 1}{segment.durationMs != null ? ` · ${formatThinkingTime(segment.durationMs)}` : ""}</summary>
                          <p>{segment.text}</p>
                        </details>
                      ))}
                      {message.streamingThinking ? (
                        <details open className="thinking-process">
                          <summary>思考中…{message.streamingThinkingStartedAt ? ` · ${formatThinkingTime(Date.now() - message.streamingThinkingStartedAt)}` : ""}</summary>
                          <p>{message.streamingThinking}</p>
                        </details>
                      ) : null}
                      {thinkingTotalMs(message.thinking) > 0 && (
                        <div className="thinking-total">思考总时长 {formatThinkingTime(thinkingTotalMs(message.thinking))}</div>
                      )}
                    </>
                  )}
                  <div className="message-answer"><MarkdownContent text={message.text} /></div>
                  {message.skillTrace && message.skillTrace.length > 0 && (
                    <details className="thinking-process skill-trace">
                      <summary>Skill 编排 · {message.skillTrace.length} 次调用</summary>
                      {message.skillTrace.map((entry, index) => (
                        <p key={`${message.id}-trace-${index}`}>
                          {entry.parentSkill ? `${entry.parentSkill} → ` : ""}{entry.childSkill} · depth {entry.depth} · {entry.status}
                          {entry.status === "ok" ? ` · ${entry.operationCount} ops / ${entry.affectedNoteCount} notes` : ""} · {entry.durationMs}ms
                        </p>
                      ))}
                    </details>
                  )}
                </div>
              </div>
            ))}
            {agentBusy && <div className="thinking"><span /><span /><span />正在分析乐句</div>}

            {mode !== "research" && candidates.length > 0 && (
              <section className="candidate-section">
                <div className="candidate-heading"><span>候选差异</span><small>{candidates.filter((item) => !item.state).length} VERSION(S)</small></div>
                {candidates.map((candidate) => (
                  <article key={candidate.id} className={`candidate-card ${candidate.state ?? ""}`}>
                    <div className="candidate-top"><strong>{candidate.title}</strong><span className="score">{candidate.score}</span></div>
                    <p>{candidate.description}</p>
                    <div className="diff-stats"><span><i>＋</i>{candidate.notesAdded} 新增</span><span><i>↝</i>{candidate.notesChanged} 修改</span>{candidate.notesDeleted > 0 && <span><i>−</i>{candidate.notesDeleted} 删除</span>}<span><i>◌</i>{candidate.loopScore}</span></div>
                    {candidate.state === "accepted" ? (
                      <div className="accepted-label"><Icon name="check" />已应用到工程</div>
                    ) : (
                      <div className="candidate-actions">
                        <button className="candidate-secondary" onClick={() => setCandidates((items) => items.map((item) => item.id === candidate.id ? { ...item, state: "rejected" } : item))}>忽略</button>
                        <button className="candidate-apply" disabled={mode !== "goal" || candidate.sourceMode !== "goal" || !candidate.supported || Boolean(candidate.state)} onClick={() => acceptCandidate(candidate)}>{candidate.sourceMode === "plan" || mode === "plan" ? "仅预览" : !candidate.supported ? "暂不支持" : candidate.state === "rejected" ? "已忽略" : candidate.state === "accepted" ? "已应用" : "应用候选"}</button>
                      </div>
                    )}
                  </article>
                ))}
              </section>
            )}
          </div>

          {agentBusy && (
            <div className="agent-live" role="status" aria-live="polite">
              <span>轮次 {agentLive.turns}</span>
              {agentLive.currentTool && <span className="agent-live-tool"><i />正在调用 {agentLive.currentTool}</span>}
              {Object.keys(agentLive.toolCalls).length > 0 && (
                <span>工具 {Object.entries(agentLive.toolCalls).map(([name, count]) => `${name}×${count}`).join("、")}</span>
              )}
              {agentLive.skills.length > 0 && (
                <span>Skill {agentLive.skills.map((item) => `${item.skill}${item.status === "ok" ? "✓" : "✗"}`).join(" → ")}</span>
              )}
            </div>
          )}

          <div className="prompt-area">
            <div className="prompt-context">
              <span>{selectedTrack ? `范围：${selectedTrack.name}` : "范围：全曲"}</span>
              {activeSubscription && activeSubscription.models.length > 0 && (
                <div className="model-select" ref={modelSelectRef}>
                  <button type="button" className="model-select-trigger" aria-expanded={modelMenuOpen} aria-haspopup="listbox" onClick={() => setModelMenuOpen((value) => !value)}>
                    <Icon name="spark" size={11} /><span className="model-select-label">{activeModelLabel}</span><span className="model-select-caret">▾</span>
                  </button>
                  {modelMenuOpen && (
                    <div className="model-select-menu" role="listbox" aria-label="选择模型">
                      {activeSubscription.models.map((model) => (
                        <button key={model.id} type="button" role="option" aria-selected={model.id === activeModelId} className={model.id === activeModelId ? "active" : ""} onClick={() => void setActiveModel(model.id)}>{model.name}</button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <span>{mode === "goal" ? `最多 ${conversationSettings.goalMaxTurns} 轮` : mode === "research" ? `最多 ${conversationSettings.researchMaxTurns} 轮` : modeMeta[mode].short}</span>
            </div>
            <div className="prompt-input-wrap" ref={promptWrapRef}>
              <textarea
                value={prompt}
                onChange={(event) => {
                  setPrompt(event.target.value);
                  updateSkillMention(event.target.value, event.target.selectionStart ?? event.target.value.length);
                }}
                onKeyDown={handlePromptKeyDown}
                onBlur={() => window.setTimeout(closeSkillMention, 120)}
                placeholder={mode === "research" ? "询问和声、结构或循环问题…" : mode === "plan" ? "描述想要的修改，生成执行计划…" : "例如：让第 7–8 小节更空旷，保持无缝循环…"}
              />
            </div>
            {skillMention.open && (
              <div className="skill-mention-menu" role="listbox" aria-label="选择 Skill">
                {filteredSkills.length === 0 ? (
                  <div className="skill-mention-empty">{agentSkillsLoaded ? "无匹配 Skill" : "加载中…"}</div>
                ) : (
                  filteredSkills.map((skill, index) => (
                    <button
                      key={skill.name}
                      type="button"
                      role="option"
                      aria-selected={index === skillMentionIndex}
                      className={index === skillMentionIndex ? "active" : ""}
                      onMouseDown={(event) => { event.preventDefault(); acceptSkillMention(skill.name); }}
                    >
                      <strong>@{skill.name}</strong><span>{skill.description}</span>
                    </button>
                  ))
                )}
              </div>
            )}
            {agentBusy ? (
              <button className="send-button cancel-button" onClick={() => void cancelAgentRun()} aria-label="取消"><Icon name="close" /></button>
            ) : (
              <button className="send-button" disabled={!prompt.trim() || agentBusy} onClick={sendPrompt} aria-label="发送"><Icon name="send" /></button>
            )}
          </div>
        </aside>
      </main>

      {settingsOpen && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSettingsOpen(false); }}>
          <section className="modal settings-modal" role="dialog" aria-modal="true" aria-labelledby="settings-title">
            <button className="modal-close" onClick={() => setSettingsOpen(false)}><Icon name="close" /></button>
            <aside className="settings-sidebar" aria-label="设置板块">
              <div className="settings-brand"><span className="modal-kicker">PREFERENCES</span><strong>设置</strong></div>
              <nav>
                {settingsSections.map((section) => (
                  <button key={section.id} className={settingsSection === section.id ? "active" : ""} onClick={() => setSettingsSection(section.id)}>
                    <Icon name={section.icon} size={14} /><span>{section.label}</span>
                  </button>
                ))}
              </nav>
              <small>M Agent Desktop</small>
            </aside>
            <div className="settings-content">
              <header className="settings-header">
                <span className="modal-kicker">{activeSettings.id.toUpperCase()}</span>
                <h2 id="settings-title">{activeSettings.label}</h2>
              </header>

              {settingsSection === "general" && (
                <div className="settings-pane">
                  <section className="settings-group appearance-settings">
                    <div className="settings-group-heading"><div><strong>外观</strong><span>选择界面主题与明暗方案，修改会立即生效并保存在本机。</span></div></div>
                    <fieldset className="appearance-fieldset">
                      <legend>主题</legend>
                      <button
                        type="button"
                        className="theme-list-toggle"
                        aria-label={`${themeListExpanded ? "收起" : "展开"}主题列表，当前为 ${activeTheme?.label ?? "默认"}`}
                        aria-expanded={themeListExpanded}
                        aria-controls="theme-preset-list"
                        onClick={() => setThemeListExpanded((expanded) => !expanded)}
                      >
                        <span className="theme-swatches compact" aria-hidden="true">
                          {activeTheme?.swatches.map((color) => <i key={color} style={{ background: color }} />)}
                        </span>
                        <span className="theme-preset-copy">
                          <strong>{activeTheme?.label ?? "默认"}</strong>
                          <small>{activeTheme?.source.kind === "plugin" ? `来自插件 · ${activeTheme.source.pluginName}` : "内置主题"} · 共 {themePresets.length} 个主题</small>
                        </span>
                        <span className={themeListExpanded ? "theme-toggle-chevron expanded" : "theme-toggle-chevron"} aria-hidden="true">⌄</span>
                      </button>
                      {themeListExpanded && (
                        <div className="theme-preset-grid" id="theme-preset-list">
                          {themePresets.map((theme) => (
                            <button
                              key={theme.id}
                              className={appearance.theme === theme.id ? "theme-preset active" : "theme-preset"}
                              type="button"
                              aria-pressed={appearance.theme === theme.id}
                              data-theme-id={theme.id}
                              onClick={() => selectTheme(theme.id)}
                            >
                              <span className="theme-swatches" aria-hidden="true">
                                {theme.swatches.map((color) => <i key={color} style={{ background: color }} />)}
                              </span>
                              <span className="theme-preset-copy">
                                <strong>{theme.label}</strong>
                                <small>{theme.source.kind === "plugin" ? `${theme.description} · ${theme.source.pluginName}` : theme.description}</small>
                              </span>
                              <span className="theme-check"><Icon name="check" size={12} /></span>
                            </button>
                          ))}
                        </div>
                      )}
                      <p className="theme-plugin-hint">未来插件安装后，可在此列表中提供经过权限校验的附加主题。</p>
                    </fieldset>
                    <fieldset className="appearance-fieldset mode-fieldset">
                      <legend>外观模式</legend>
                      <div className="appearance-mode-options">
                        {APPEARANCE_MODES.map((option) => (
                          <button
                            key={option.id}
                            type="button"
                            className={appearance.mode === option.id ? "active" : ""}
                            aria-pressed={appearance.mode === option.id}
                            data-appearance-mode={option.id}
                            onClick={() => selectAppearanceMode(option.id)}
                          >{option.label}</button>
                        ))}
                      </div>
                      <p>“跟随主题”会使用该主题推荐的明暗方案；Warn Paper 推荐浅色，其余预设推荐深色。</p>
                    </fieldset>
                  </section>
                  <section className="settings-group conversation-settings">
                    <div className="settings-group-heading"><div><strong>对话</strong><span>控制思考摘要的显示方式与目标模式预算，修改会立即保存在本机。</span></div></div>
                    <div className="settings-row">
                      <div><strong>显示思考过程</strong><span>任务完成后展示供应商返回的思考摘要；不改变模型实际推理强度。</span></div>
                      <button
                        type="button"
                        className={`settings-switch ${conversationSettings.showThinking ? "active" : ""}`}
                        role="switch"
                        aria-checked={conversationSettings.showThinking}
                        data-conversation-setting="show-thinking"
                        onClick={() => setConversationSettings((current) => ({ ...current, showThinking: !current.showThinking }))}
                      ><span /></button>
                    </div>
                    <label className="settings-row">
                      <div><strong>默认 thinking</strong><span>使用 Pi 的稳定跨供应商级别；模型不支持时会自动收敛到最近等级。</span></div>
                      <select
                        value={conversationSettings.thinkingLevel}
                        data-conversation-setting="thinking-level"
                        onChange={(event) => setConversationSettings((current) => ({ ...current, thinkingLevel: event.target.value as ConversationSettings["thinkingLevel"] }))}
                      >
                        {PI_THINKING_LEVELS.map((level) => <option key={level} value={level}>{level}</option>)}
                      </select>
                    </label>
                    <label className="settings-row">
                      <div><strong>目标最大轮次</strong><span>仅作用于目标模式；60 秒任务超时仍是独立的硬保护。</span></div>
                      <input
                        type="number"
                        min={GOAL_MAX_TURNS_RANGE.minimum}
                        max={GOAL_MAX_TURNS_RANGE.maximum}
                        step="1"
                        value={conversationSettings.goalMaxTurns}
                        data-conversation-setting="goal-max-turns"
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isFinite(value)) setConversationSettings((current) => ({ ...current, goalMaxTurns: Math.min(GOAL_MAX_TURNS_RANGE.maximum, Math.max(GOAL_MAX_TURNS_RANGE.minimum, Math.round(value))) }));
                        }}
                      />
                    </label>
                    <label className="settings-row">
                      <div><strong>调研最大轮次</strong><span>仅作用于调研模式；最后一轮含工具调用时会续跑读取结果，轮次上限由此控制。</span></div>
                      <input
                        type="number"
                        min={RESEARCH_MAX_TURNS_RANGE.minimum}
                        max={RESEARCH_MAX_TURNS_RANGE.maximum}
                        step="1"
                        value={conversationSettings.researchMaxTurns}
                        data-conversation-setting="research-max-turns"
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isFinite(value)) setConversationSettings((current) => ({ ...current, researchMaxTurns: Math.min(RESEARCH_MAX_TURNS_RANGE.maximum, Math.max(RESEARCH_MAX_TURNS_RANGE.minimum, Math.round(value))) }));
                        }}
                      />
                    </label>
                    <label className="settings-row">
                      <div><strong>目标最大 Token</strong><span>累计输出预算，每轮完成后检查；API Key 模式还会限制下一轮输出。</span></div>
                      <input
                        type="number"
                        min={GOAL_MAX_TOKENS_RANGE.minimum}
                        max={GOAL_MAX_TOKENS_RANGE.maximum}
                        step="1000"
                        value={conversationSettings.goalMaxTokens}
                        data-conversation-setting="goal-max-tokens"
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isFinite(value)) setConversationSettings((current) => ({ ...current, goalMaxTokens: Math.min(GOAL_MAX_TOKENS_RANGE.maximum, Math.max(GOAL_MAX_TOKENS_RANGE.minimum, Math.round(value))) }));
                        }}
                      />
                    </label>
                    <label className="settings-row">
                      <div><strong>子 Skill 超时（秒）</strong><span>单个子 Skill 调用的兜底超时；留空表示不限制，仅由取消按钮与 Token/轮次预算控制。</span></div>
                      <input
                        type="number"
                        min={SKILL_TIMEOUT_RANGE.minimum}
                        max={SKILL_TIMEOUT_RANGE.maximum}
                        step="1"
                        value={conversationSettings.skillTimeoutMs ?? ""}
                        data-conversation-setting="skill-timeout"
                        placeholder="不限制"
                        onChange={(event) => {
                          const raw = event.target.value;
                          if (raw.trim() === "") { setConversationSettings((current) => ({ ...current, skillTimeoutMs: undefined })); return; }
                          const value = Number(raw);
                          if (Number.isFinite(value)) setConversationSettings((current) => ({ ...current, skillTimeoutMs: Math.min(SKILL_TIMEOUT_RANGE.maximum, Math.max(SKILL_TIMEOUT_RANGE.minimum, Math.round(value))) }));
                        }}
                      />
                    </label>
                    <label className="settings-row">
                      <div><strong>工程注入方式</strong><span>选择注入全部轨道以获取完整工程，或仅注入概览与当前选中轨道的音符明细以节省 Token。</span></div>
                      <select
                        value={conversationSettings.projectInjection}
                        data-conversation-setting="project-injection"
                        onChange={(event) => setConversationSettings((current) => ({ ...current, projectInjection: event.target.value as ConversationSettings["projectInjection"] }))}
                      >
                        {PROJECT_INJECTION_MODES.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
                      </select>
                    </label>
                  </section>
                  <section className="settings-group export-settings">
                    <div className="settings-group-heading"><div><strong>导出</strong><span>控制 WAV / OGG 音频导出的渲染时长上限，修改会立即保存在本机。</span></div></div>
                    <label className="settings-row">
                      <div><strong>渲染时长上限</strong><span>超出上限的工程会拒绝导出，避免超大工程长时间占用资源。</span></div>
                      <input
                        type="number"
                        min={EXPORT_MAX_MINUTES_RANGE.minimum}
                        max={EXPORT_MAX_MINUTES_RANGE.maximum}
                        step="1"
                        value={exportSettings.maxMinutes}
                        data-export-setting="max-minutes"
                        onChange={(event) => {
                          const value = Number(event.target.value);
                          if (Number.isFinite(value)) setExportSettings((current) => ({
                            ...current,
                            maxMinutes: Math.min(EXPORT_MAX_MINUTES_RANGE.maximum, Math.max(EXPORT_MAX_MINUTES_RANGE.minimum, Math.round(value))),
                          }));
                        }}
                      />
                    </label>
                  </section>
                  <section className="settings-group shell-settings" id="shell-settings">
                    <div className="settings-group-heading"><div><strong>Shell 路径</strong><span>选择应用统一使用的 Bash、Windows PowerShell 或 PowerShell 7。只有检测通过后才会保存并生效。</span></div></div>
                    <label className="shell-path-field">
                      <span>可执行文件路径</span>
                      <div className="shell-path-controls">
                        <input
                          ref={shellInputRef}
                          type="text"
                          value={shellPath}
                          data-shell-setting="path"
                          spellCheck={false}
                          autoComplete="off"
                          disabled={shellBusy}
                          onChange={(event) => { setShellPath(event.target.value); setShellCheck(null); }}
                          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void detectShell(); } }}
                        />
                        <button type="button" className="candidate-secondary" data-shell-action="browse" disabled={shellBusy} onClick={() => void browseShell()}>浏览…</button>
                        <button type="button" className="candidate-secondary shell-detect-button" data-shell-action="detect" disabled={shellBusy || !shellPath.trim()} onClick={() => void detectShell()}>{shellBusy ? "检测中…" : "检测"}</button>
                      </div>
                    </label>
                    {shellCheck && (
                      <div className={`shell-check-result ${shellCheck.usable ? "ready" : "missing"}`} role="status" data-shell-status={shellCheck.status}>
                        <span className={`check-dot ${shellCheck.usable ? "ready" : "missing"}`} />
                        <div><strong>{shellCheck.usable ? "Shell 可用" : "Shell 不可用"}</strong><small>{shellCheck.version ? `${shellCheck.kind === "powershell" ? "PowerShell" : "Bash"} ${shellCheck.version} · ${shellCheck.message}` : shellCheck.message}</small></div>
                      </div>
                    )}
                    <p className="shell-settings-note">应用内部需要命令行时都会通过此 Shell 执行；当前仍未向 Agent 暴露 Shell 工具，不会改变三种模式的权限。</p>
                  </section>
                  <section className="settings-group">
                    <div className="settings-group-heading"><div><strong>运行环境</strong><span>应用启动时自动检查必要组件和安全能力。</span></div><button className="candidate-secondary" disabled={environmentBusy} onClick={() => void refreshEnvironment()}>{environmentBusy ? "检测中…" : "重新检测"}</button></div>
                    <div className="environment-list settings-environment-list">
                      {environmentError && <div className="settings-inline-error"><span className="check-dot missing" /><strong>检测失败</strong><small>{environmentError}</small></div>}
                      {!environment && !environmentError && <div><span className="check-dot skipped" /><strong>运行环境</strong><small>正在读取启动环境…</small></div>}
                      {(environment?.checks ?? []).map((check) => (
                        <div key={check.id}><span className={`check-dot ${check.status}`} /><strong>{check.label}</strong><small>{check.version ?? check.message}</small></div>
                      ))}
                    </div>
                  </section>
                </div>
              )}

              {settingsSection === "providers" && (
                <div className="settings-pane">
                  {providersView === "edit" && subscriptionDraft && (
                    <div className="subscription-editor">
                      <div className="subscription-editor-head">
                        <strong>{editingSubscriptionId ? "编辑订阅" : "新建订阅"}</strong>
                        <div className="subscription-editor-head-actions">
                          {editingSubscriptionId && (
                            <button className="danger-text compact" disabled={subscriptionBusy} onClick={deleteSelectedSubscription}>删除</button>
                          )}
                          <button className="candidate-secondary" disabled={subscriptionBusy} onClick={() => openProviderEditor(null)}>返回列表</button>
                        </div>
                      </div>
                      <label className="subscription-field"><span>显示名称</span><input value={subscriptionDraft.name} onChange={(event) => setSubscriptionDraft((current) => current ? { ...current, name: event.target.value } : current)} placeholder="例如：DeepSeek 主力" /></label>
                      <label className="subscription-field"><span>Provider ID</span><input value={subscriptionDraft.providerId} onChange={(event) => setSubscriptionDraft((current) => current ? { ...current, providerId: event.target.value } : current)} placeholder="例如：deepseek" /></label>
                      <label className="subscription-field"><span>API 类型</span>
                        <select value={subscriptionDraft.apiType} onChange={(event) => setSubscriptionDraft((current) => current ? { ...current, apiType: event.target.value as SubscriptionInput["apiType"] } : current)}>
                          {SUBSCRIPTION_API_TYPES.map((apiType) => <option key={apiType.id} value={apiType.id}>{apiType.label}</option>)}
                        </select>
                      </label>
                      <label className="subscription-field"><span>BaseURL</span><input value={subscriptionDraft.baseUrl} onChange={(event) => setSubscriptionDraft((current) => current ? { ...current, baseUrl: event.target.value } : current)} placeholder="https://api.example.com/v1" /></label>
                      <label className="subscription-field"><span>API key</span><input type="password" value={subscriptionDraft.apiKey ?? ""} onChange={(event) => setSubscriptionDraft((current) => current ? { ...current, apiKey: event.target.value } : current)} placeholder={editingSubscriptionId ? "留空表示保持不变" : "sk-••••••••••••••••"} autoComplete="off" /></label>
                      <div className="subscription-models">
                        <div className="subscription-models-head">
                          <strong>模型列表</strong>
                          <button className="candidate-secondary" disabled={fetchingModels} onClick={() => void runFetchModels()}>{fetchingModels ? "拉取中…" : "拉取模型"}</button>
                        </div>
                        <div className="subscription-model-head">
                          <span>模型 ID</span><span>显示名</span><span>上下文（留空为 128k）</span><span />
                        </div>
                        {subscriptionDraft.models.map((model, index) => (
                          <div className="subscription-model-row" key={index}>
                            <input value={model.id} onChange={(event) => updateDraftModel(index, { id: event.target.value })} placeholder="gpt-5-mini" />
                            <input value={model.name} onChange={(event) => updateDraftModel(index, { name: event.target.value })} placeholder="GPT-5 mini" />
                            <input value={model.contextWindow ?? ""} onChange={(event) => {
                              const raw = event.target.value;
                              const parsed = raw === "" ? undefined : Number(raw);
                              updateDraftModel(index, { contextWindow: raw === "" ? undefined : Number.isFinite(parsed) ? parsed : model.contextWindow });
                            }} placeholder="128000" />
                            <button className="danger-text compact" onClick={() => removeDraftModel(index)}>移除</button>
                          </div>
                        ))}
                        <button className="candidate-secondary" onClick={addDraftModel}>+ 添加模型</button>
                      </div>
                      <label className="subscription-field"><span>备注</span><textarea value={subscriptionDraft.notes ?? ""} onChange={(event) => setSubscriptionDraft((current) => current ? { ...current, notes: event.target.value } : current)} placeholder="可选" rows={2} /></label>
                      <div className="subscription-editor-actions">
                        <button className="candidate-secondary" onClick={() => openProviderEditor(null)}>取消</button>
                        <button className="primary-button" disabled={subscriptionBusy} onClick={() => void saveSubscriptionDraft()}>保存</button>
                      </div>
                    </div>
                  )}
                  {providersView === "list" && (
                    <>
                      <div className="subscription-toolbar">
                        <div>
                          <button className="quiet-button" disabled={subscriptionBusy} onClick={() => void importExistingSubscriptions()}><Icon name="download" />导入已有</button>
                          <button className="quiet-button" disabled={subscriptionBusy} onClick={() => setPresetPickerOpen((value) => !value)}><Icon name="plus" />从预设添加</button>
                        </div>
                        <button className="primary-button" disabled={subscriptionBusy} onClick={openNewProvider}><Icon name="plus" />新建</button>
                      </div>
                      {presetPickerOpen ? (
                        <div className="preset-picker">
                          <p className="settings-intro">选择常用预设，会以预设参数预填新建表单，再补充 API Key 与模型。</p>
                          <label className="preset-search"><Icon name="spark" size={14} /><input value={presetSearch} onChange={(event) => setPresetSearch(event.target.value)} placeholder="搜索预设名称、API 类型或 BaseURL…" autoFocus /></label>
                          <div className="preset-grid">
                            {filteredProviderPresets.map((preset) => (
                              <button key={preset.id} type="button" className="preset-card" onClick={() => { openProviderEditor(preset); setPresetPickerOpen(false); }}>
                                <strong>{preset.name}</strong>
                                <span>{subscriptionApiTypeLabel(preset.apiType)} · {preset.baseUrl}</span>
                                {preset.models.length > 0 && <small>{preset.models.length} 个模型</small>}
                                {preset.notes && <small>{preset.notes}</small>}
                              </button>
                            ))}
                            {filteredProviderPresets.length === 0 && (
                              <div className="settings-empty preset-empty"><strong>未找到匹配的预设</strong><p>换个关键词试试，或返回列表点击「新建」手动配置。</p></div>
                            )}
                          </div>
                        </div>
                      ) : subscriptions.length === 0 ? (
                        <div className="settings-empty subscription-empty">
                          <Icon name="cloud" size={24} />
                          <strong>暂无订阅档案</strong>
                          <p>可点击「导入已有」从 Pi / cc-switch 同步，或新建 / 从预设添加。</p>
                        </div>
                      ) : (
                        <div className="subscription-list">
                          {subscriptions.map((subscription) => (
                            <div key={subscription.id} className={subscription.isActive ? "subscription-card active" : "subscription-card"}>
                              <div className="subscription-card-main">
                                <div className="subscription-card-title">
                                  <strong>{subscription.name}</strong>
                                  {subscription.isActive && <span className="availability-badge ready">当前</span>}
                                  {!subscription.hasApiKey && <span className="availability-badge preview">未填 Key</span>}
                                </div>
                                <div className="subscription-card-meta">
                                  <span>{subscriptionApiTypeLabel(subscription.apiType)}</span>
                                  <span>{subscription.providerId}</span>
                                  <span>{subscription.baseUrl}</span>
                                </div>
                                <div className="subscription-card-meta">
                                  <span>{subscription.models.length} 个模型</span>
                                  <span>来源：{subscriptionSourceLabel(subscription.source)}</span>
                                  {subscription.activeModelId && <span>默认：{subscription.activeModelId}</span>}
                                </div>
                              </div>
                              <div className="subscription-card-actions">
                                {!subscription.isActive && (
                                  <button className="candidate-secondary" disabled={subscriptionBusy} onClick={() => void activateSelectedSubscription(subscription.id)}>设为当前</button>
                                )}
                                <button className="candidate-secondary" disabled={subscriptionBusy} onClick={() => openProviderEditor(subscription)}>编辑</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="security-note"><Icon name="lock" /><span>API Key 仅保存在本机系统安全存储中，不会出现在此界面或工程文件中。</span></div>
                    </>
                  )}
                </div>
              )}

              {settingsSection === "usage" && (
                <div className="settings-pane">
                  <section className="settings-group">
                    <div className="settings-group-heading"><div><strong>用量统计</strong><span>汇总本机在线 Agent 请求的轮次、Tokens、缓存命中与费用。</span></div><span className="availability-badge preview">本地汇总</span></div>
                    <div className="settings-summary-grid usage-grid">
                      <div><span>轮次</span><strong>{formatUsageTokens(usageSummary?.turns ?? 0)}</strong></div>
                      <div><span>Tokens</span><strong>{formatUsageTokens(usageSummary?.tokens ?? 0)}</strong></div>
                      <div><span>缓存命中</span><strong>{formatUsageTokens(usageSummary?.cacheRead ?? 0)}</strong></div>
                      <div><span>费用（$）</span><strong>{formatUsageCost(usageSummary?.cost ?? 0)}</strong></div>
                    </div>
                  </section>
                  <section className="settings-group">
                    <div className="settings-group-heading"><div><strong>用量明细</strong><span>{usageView === "day" ? "按日期聚合" : "按模型聚合"} · 每页 10 条</span></div></div>
                    <div className="usage-view-tabs" role="tablist" aria-label="用量视图">
                      <button className={usageView === "day" ? "active" : ""} role="tab" aria-selected={usageView === "day"} onClick={() => { setUsageView("day"); setUsagePage(1); }}>按日</button>
                      <button className={usageView === "model" ? "active" : ""} role="tab" aria-selected={usageView === "model"} onClick={() => { setUsageView("model"); setUsagePage(1); }}>按模型</button>
                    </div>
                    <div className="usage-table">
                      <div className="usage-table-head"><span>{(usageView === "day" ? "日期" : "模型")}</span><span>轮次</span><span>Tokens</span><span>缓存命中</span><span>费用（$）</span></div>
                      {(usageData?.rows ?? []).map((row) => (
                        <div className="usage-table-row" key={row.key}>
                          <span title={row.label}>{row.label}</span>
                          <span>{formatUsageTokens(row.turns)}</span>
                          <span>{formatUsageTokens(row.tokens)}</span>
                          <span>{formatUsageTokens(row.cacheRead)}</span>
                          <span>{formatUsageCost(row.cost)}</span>
                        </div>
                      ))}
                      {(usageData?.rows ?? []).length === 0 && !usageBusy && (
                        <div className="usage-table-empty">暂无在线请求记录</div>
                      )}
                      {usageBusy && <div className="usage-table-empty">加载中…</div>}
                    </div>
                    <div className="usage-pagination">
                      <button className="candidate-secondary" disabled={usageBusy || (usageData?.page ?? 1) <= 1} onClick={() => setUsagePage((page) => Math.max(1, page - 1))}>‹ 上一页</button>
                      <span>第 {usageData?.page ?? 1} / {usageData?.totalPages ?? 1} 页 · 共 {usageData?.total ?? 0} 条</span>
                      <button className="candidate-secondary" disabled={usageBusy || (usageData?.page ?? 1) >= (usageData?.totalPages ?? 1)} onClick={() => setUsagePage((page) => page + 1)}>下一页 ›</button>
                    </div>
                  </section>
                  <div className="usage-clear">
                    <span>仅清本地汇总，不影响会话</span>
                    <button className="candidate-secondary" disabled={usageBusy || (usageSummary?.runCount ?? 0) === 0} onClick={() => void clearUsageStatistics()}>清空</button>
                  </div>
                </div>
              )}

              {settingsSection === "sound" && (
                <div className="settings-pane">
                  {soundView === "list" ? (
                    <>
                      <div className="subscription-toolbar">
                        <div>
                          <button className="quiet-button" onClick={() => void loadInstrumentLibrary()}><Icon name="spark" size={13} />扫描音源库</button>
                        </div>
                        <button className="primary-button" onClick={() => setSoundView("add")}><Icon name="plus" />添加</button>
                      </div>
                      {instrumentLibrary.length + projectInstruments.length === 0 ? (
                        <div className="settings-empty subscription-empty">
                          <Icon name="music" size={24} />
                          <strong>暂无音源</strong>
                          <p>点击右上角「添加」绑定当前工程音源，或把音源文件放入系统级音源库目录（音源库 → 打开文件夹）后点击「扫描音源库」。</p>
                          <button className="primary-button" disabled={recommendedDownloadBusy} onClick={() => void downloadRecommendedSoundfont()}>
                            {recommendedDownloadBusy ? "下载中…" : "没有音源？下载推荐音源！"}
                          </button>
                        </div>
                      ) : (
                        <div className="subscription-list">
                          {instrumentLibrary.map((entry) => (
                            <div key={entry.id} className={entry.enabled ? "subscription-card active" : "subscription-card"}>
                              <div className="subscription-card-main">
                                <div className="subscription-card-title">
                                  <strong>{entry.name}</strong>
                                  {!entry.enabled && <span className="availability-badge preview">已禁用</span>}
                                  <span className="availability-badge preview">{entry.type === "soundfont" ? "SoundFont" : "SFZ"}</span>
                                  <span className="availability-badge preview">系统级</span>
                                </div>
                                <div className="subscription-card-meta">
                                  <span title={entry.path}>{entry.path}</span>
                                  <span>{entry.type === "soundfont" ? `${entry.presetCount} 个音色` : `${entry.sfzRegions?.length ?? 0} 个采样区域`}</span>
                                </div>
                              </div>
                              <div className="subscription-card-actions">
                                <button className="candidate-secondary" onClick={() => void setSystemInstrumentEnabled(entry)}>{entry.enabled ? "禁用" : "启用"}</button>
                              </div>
                            </div>
                          ))}
                          {projectInstruments.map((entry) => (
                            <div key={entry.id} className="subscription-card">
                              <div className="subscription-card-main">
                                <div className="subscription-card-title">
                                  <strong>{entry.name ?? entry.path.split(/[\\/]/).pop()}</strong>
                                  <span className="availability-badge preview">{entry.type === "soundfont" ? "SoundFont" : "SFZ"}</span>
                                  <span className="availability-badge ready">工程</span>
                                </div>
                                <div className="subscription-card-meta">
                                  <span title={entry.path}>{entry.path}</span>
                                  <span>{entry.type === "soundfont" ? `${entry.presets?.length ?? 0} 个音色` : `${entry.sfzRegions?.length ?? 0} 个采样区域`}</span>
                                </div>
                              </div>
                              <div className="subscription-card-actions">
                                <button className="candidate-secondary" onClick={() => unbindProjectInstrument(entry.id)}>移除绑定</button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                      <div className="security-note"><Icon name="music" /><span>音源文件仅记录路径，不随工程复制；项目迁移至其他电脑后，工程音源绑定会失效。</span></div>
                    </>
                  ) : (
                    <>
                      <div className="subscription-editor-head">
                        <strong>新建音源库</strong>
                        <div className="subscription-editor-head-actions">
                          <button className="candidate-secondary" onClick={() => setSoundView("list")}>返回列表</button>
                        </div>
                      </div>
                      <section className="settings-group">
                        <div className="settings-group-heading"><div><strong>项目级音源库</strong><span>绑定当前工程专用的音源，绑定随工程一起保存。注意事项：项目迁移至其他电脑会导致音源绑定的失效。</span></div></div>
                        <div
                          className={`instrument-dropzone ${instrumentDropActive ? "drag-over" : ""}`}
                          role="button"
                          tabIndex={0}
                          aria-label="绑定工程音源：点击选择文件，或将 .sf2/.sf3/.sfz 文件拖入此区域"
                          onClick={() => void addProjectInstrumentsFromDialog()}
                          onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void addProjectInstrumentsFromDialog(); } }}
                          onDragOver={(event) => { event.preventDefault(); setInstrumentDropActive(true); }}
                          onDragLeave={(event) => { if (event.currentTarget.contains(event.relatedTarget as Node)) return; setInstrumentDropActive(false); }}
                          onDrop={(event) => { setInstrumentDropActive(false); addProjectInstrumentsFromDrop(event); }}
                        >
                          <Icon name="plus" size={18} />
                          <strong>点击选择，或将 .sf2 / .sf3 / .sfz 文件拖入此处</strong>
                          <span>绑定即生效，保存工程时随工程一起保存；可在轨道检查器中为轨道分配这些音色。</span>
                        </div>
                        {projectInstruments.length > 0 && (
                          <p className="shell-settings-note">当前工程已绑定 {projectInstruments.length} 个项目音源，可在音源列表查看与移除绑定。</p>
                        )}
                      </section>
                      <section className="settings-group">
                        <div className="settings-group-heading"><div><strong>系统级音源库</strong><span>存放于系统目录，所有工程共享；把音源文件放入该目录后点击「扫描音源库」即可使用。</span></div>
                          <button className="candidate-secondary" onClick={() => void openSystemInstrumentFolder()}><Icon name="folder" size={13} />打开文件夹</button>
                        </div>
                      </section>
                      <section className="settings-group">
                        <div className="settings-group-heading"><div><strong>系统级音源库路径</strong><span>默认 ~/Documents/m-agent/Instruments；修改时应用会询问是否把音源同步迁移到新目录。</span></div></div>
                        <label className="shell-path-field">
                          <span>目录</span>
                          <div className="shell-path-controls">
                            <input
                              type="text"
                              value={systemPathDraft}
                              spellCheck={false}
                              autoComplete="off"
                              onChange={(event) => setSystemPathDraft(event.target.value)}
                              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); applySystemPath(); } }}
                            />
                            <button type="button" className="candidate-secondary" disabled={!systemPathDraft.trim() || systemPathDraft.trim() === systemPath} onClick={applySystemPath}>应用</button>
                          </div>
                        </label>
                      </section>
                    </>
                  )}
                </div>
              )}

              {settingsSection === "plugins" && (
                <div className="settings-pane">
                  <section className="settings-group">
                    <div className="settings-group-heading"><div><strong>插件管理</strong><span>用于扩展 Agent 工具、MIDI 处理和音源能力。</span></div><span className="availability-badge preview">规划中</span></div>
                  </section>
                  <div className="settings-empty"><Icon name="plugin" size={24} /><strong>插件系统尚未接入</strong><p>当前版本不会扫描或执行第三方插件。插件清单、Manifest、权限和启停功能尚待实现。</p></div>
                </div>
              )}

              <div className="modal-actions settings-actions"><button className="candidate-secondary" onClick={() => setSettingsOpen(false)}>关闭</button></div>
            </div>
          </section>
        </div>
      )}
      {migratePrompt && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setMigratePrompt(null); }}>
          <section className="modal migrate-modal" role="alertdialog" aria-modal="true" aria-labelledby="migrate-title">
            <span className="modal-kicker">SYSTEM INSTRUMENT PATH</span>
            <h3 id="migrate-title">更改系统音源目录</h3>
            <p className="settings-intro">要把现有音源从当前目录同步迁移到新目录吗？</p>
            <div className="shell-path-field">
              <span>当前</span>
              <code className="migrate-path">{migratePrompt.from}</code>
            </div>
            <div className="shell-path-field">
              <span>新目录</span>
              <code className="migrate-path">{migratePrompt.to}</code>
            </div>
            <p className="shell-settings-note">「迁移音源」会把文件移动到新目录并更新扫描缓存；「仅更改路径」只切换扫描目录，不移动文件。</p>
            <div className="modal-actions">
              <button className="candidate-secondary" onClick={() => setMigratePrompt(null)}>取消</button>
              <button className="candidate-secondary" onClick={() => void confirmSystemPathChange(false)}>仅更改路径</button>
              <button className="primary-button" onClick={() => void confirmSystemPathChange(true)}>迁移音源</button>
            </div>
          </section>
        </div>
      )}
      {windowChoice && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setWindowChoice(null); }}>
          <section className="modal migrate-modal" role="alertdialog" aria-modal="true" aria-labelledby="window-choice-title">
            <span className="modal-kicker">PROJECT TARGET</span>
            <h3 id="window-choice-title">在哪里打开？</h3>
            <p className="settings-intro">
              {windowChoice === "new-project" ? "新建项目" : windowChoice === "open-project" ? "打开项目" : "导入 MIDI"}
              ：在当前窗口进行，还是另开一个新窗口？
            </p>
            <div className="modal-actions">
              <button className="candidate-secondary" onClick={() => setWindowChoice(null)}>取消</button>
              <button className="candidate-secondary" onClick={() => confirmWindowChoice(windowChoice, "current")}>当前窗口</button>
              <button className="primary-button" onClick={() => confirmWindowChoice(windowChoice, "new")}>新窗口</button>
            </div>
          </section>
        </div>
      )}
      {exportDialog && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !exportBusy) setExportDialog(null); }}>
          <section className="modal migrate-modal" role="dialog" aria-modal="true" aria-labelledby="export-audio-title">
            <span className="modal-kicker">AUDIO EXPORT</span>
            <h3 id="export-audio-title">导出{exportDialog === "ogg" ? " OGG" : " WAV"} 音频</h3>
            <p className="settings-intro">
              离线渲染完整工程为{exportDialog === "ogg" ? " Ogg Vorbis（.ogg）" : " WAV（.wav）"}。
              包含 SoundFont 采样、SFZ 采样与振荡器回退轨道，时长随最长轨道并附加释放尾音。
            </p>
            <label className="settings-row">
              <div><strong>采样率</strong><span>越高保真越好、文件越大。</span></div>
              <select value={exportSampleRate} onChange={(event) => setExportSampleRate(Number(event.target.value) as ExportSampleRate)}>
                {EXPORT_SAMPLE_RATES.map((rate) => <option key={rate} value={rate}>{rate} Hz</option>)}
              </select>
            </label>
            <label className="settings-row">
              <div>
                <strong>仅导出循环区</strong>
                <span>只渲染工程级循环区（标尺虚线框）范围内的内容，需先通过 Agent 设置循环区。</span>
              </div>
              <input type="checkbox" checked={exportLoopOnly} disabled={!projectMetadata?.loopRegion} onChange={(event) => setExportLoopOnly(event.target.checked)} />
            </label>
            <div className="modal-actions">
              <button className="candidate-secondary" disabled={exportBusy} onClick={() => setExportDialog(null)}>取消</button>
              <button className="primary-button" disabled={exportBusy} onClick={() => void handleExportAudio(exportDialog, exportSampleRate)}>
                {exportBusy ? "正在渲染并编码…" : "导出"}
              </button>
            </div>
          </section>
        </div>
      )}
      {toast && <div className="toast"><span className="status-light online" />{toast}</div>}
    </div>
  );
}
