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
  RendererProjectPayload,
  StartupEnvironmentReport,
  UsagePage,
  UsageSummary,
} from "../shared/bridge";
import type { AgentSession, MidiProject, ProposedChangeSet, Revision, TempoEvent, TickRange, TimeSignatureEvent } from "../shared/midi";
import type { ShellCheckResult } from "../shared/shell";
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
  saveConversationSettings,
  type ConversationSettings,
} from "../shared/conversation-settings";
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

interface MenuEntry {
  label: string;
  shortcut?: string;
  action?: string;
  disabled?: boolean;
}

interface MenuGroup {
  key: string;
  label: string;
  accessKey: string;
  items: MenuEntry[];
}

const menuGroups: MenuGroup[] = [
  {
    key: "file",
    label: "文件",
    accessKey: "F",
    items: [
      { label: "导入 MIDI", shortcut: "Ctrl+O", action: "file-open-midi" },
      { label: "打开工程", shortcut: "Ctrl+Shift+O", action: "file-open-project" },
      { label: "保存工程", shortcut: "Ctrl+S", action: "file-save-project" },
      { label: "导出 MIDI", shortcut: "Ctrl+Shift+S", action: "file-export-midi" },
      { label: "关闭窗口", shortcut: "Ctrl+W", action: "window-close" },
    ],
  },
  {
    key: "edit",
    label: "编辑",
    accessKey: "E",
    items: [
      { label: "撤销", shortcut: "Ctrl+Z", action: "edit-undo" },
      { label: "重做", shortcut: "Ctrl+Y", action: "edit-redo" },
    ],
  },
  {
    key: "view",
    label: "视图",
    accessKey: "V",
    items: [
      { label: "重新检测运行环境", action: "view-check-environment" },
      { label: "设置", action: "view-settings" },
    ],
  },
  {
    key: "window",
    label: "窗口",
    accessKey: "W",
    items: [
      { label: "最小化", action: "window-minimize" },
      { label: "最大化 / 还原", action: "window-maximize" },
    ],
  },
  {
    key: "plugins",
    label: "插件",
    accessKey: "P",
    items: [
      { label: "插件管理", action: "plugins-settings" },
    ],
  },
  {
    key: "help",
    label: "帮助",
    accessKey: "H",
    items: [
      { label: "关于 M Agent", action: "help-about" },
      { label: "设置", action: "help-settings" },
    ],
  },
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
  state?: "accepted" | "rejected";
}

interface ChatMessage {
  id: string;
  author: "agent" | "user";
  text: string;
  thinking?: string[];
}

interface DragState {
  kind: "move" | "resize";
  noteId: string;
  startX: number;
  startY: number;
  original: MidiNote;
  base: MidiTrack[];
}

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

const PPQ = 480;
const BEATS_PER_BAR = 4;
const BAR_COUNT = 16;
const MIN_PITCH = 36;
const MAX_PITCH = 96;
const ROW_HEIGHT = 18;
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

const projectToTracks = (project: MidiProject): MidiTrack[] => project.tracks.map((track, index) => ({
  id: track.id,
  name: track.name,
  role: track.role,
  color: TRACK_COLORS[index % TRACK_COLORS.length],
  channel: track.channel,
  program: track.program,
  muted: track.muted,
  solo: track.solo,
  notes: track.notes.map((note) => ({ ...note })),
}));

const candidateFromChangeSet = (changeSet: ProposedChangeSet, index: number, sourceMode: AgentMode): Candidate => {
  let notesAdded = 0;
  let notesChanged = 0;
  let notesDeleted = 0;
  let supported = changeSet.operations.length > 0;
  changeSet.operations.forEach((operation) => {
    if (operation.type === "insert_notes") notesAdded += operation.notes.length;
    else if (operation.type === "update_notes") notesChanged += operation.changes.length;
    else if (operation.type === "delete_notes") notesDeleted += operation.noteIds.length;
    else supported = false;
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
  };
};

const toProjectPayload = (title: string, ppq: number, tempo: number, tracks: MidiTrack[], metadata: ProjectMetadata | null): RendererProjectPayload => ({
  ...(metadata ? {
    id: metadata.id,
    tempoMap: [
      { tick: 0, bpm: tempo },
      ...metadata.tempoMap.filter((event) => event.tick !== 0).map((event) => ({ ...event })),
    ],
    timeSignatures: metadata.timeSignatures.map((event) => ({ ...event })),
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
});

const validateNote = (note: MidiNote) =>
  typeof note.id === "string" && note.id.trim().length > 0
  && Number.isInteger(note.pitch) && note.pitch >= 0 && note.pitch <= 127
  && Number.isInteger(note.startTick) && note.startTick >= 0
  && Number.isInteger(note.durationTicks) && note.durationTicks > 0
  && Number.isInteger(note.velocity) && note.velocity >= 1 && note.velocity <= 127;

function applyNoteChangeSet(current: MidiTrack[], changeSet: ProposedChangeSet): MidiTrack[] {
  const next = cloneTracks(current);
  const knownIds = new Set(next.flatMap((track) => track.notes.map((note) => note.id)));

  for (const operation of changeSet.operations) {
    if (operation.type !== "insert_notes" && operation.type !== "update_notes" && operation.type !== "delete_notes") {
      throw new Error(`暂不支持 ${operation.type} 操作。`);
    }
    const track = next.find((item) => item.id === operation.trackId);
    if (!track) throw new Error(`候选引用了不存在的轨道 ${operation.trackId}。`);

    if (operation.type === "insert_notes") {
      const inserted = operation.notes.map((input) => {
        const id = input.id ?? uid("agent-note");
        const note: MidiNote = { ...input, id };
        if (knownIds.has(id)) throw new Error(`候选包含重复音符 ID ${id}。`);
        if (!validateNote(note)) throw new Error("候选包含越界或无效的音符数据。");
        knownIds.add(id);
        return note;
      });
      track.notes.push(...inserted);
      continue;
    }

    if (operation.type === "update_notes") {
      for (const change of operation.changes) {
        const noteIndex = track.notes.findIndex((note) => note.id === change.noteId);
        if (noteIndex < 0) throw new Error(`候选引用了不存在的音符 ${change.noteId}。`);
        const updated = { ...track.notes[noteIndex], ...change };
        delete (updated as MidiNote & { noteId?: string }).noteId;
        if (!validateNote(updated)) throw new Error("候选修改后产生了无效音符。");
        track.notes[noteIndex] = updated;
      }
      continue;
    }

    const missing = operation.noteIds.find((noteId) => !track.notes.some((note) => note.id === noteId));
    if (missing) throw new Error(`候选引用了不存在的音符 ${missing}。`);
    const deleting = new Set(operation.noteIds);
    track.notes = track.notes.filter((note) => !deleting.has(note.id));
    operation.noteIds.forEach((noteId) => knownIds.delete(noteId));
  }

  return next;
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

interface AppProps {
  initialAppearance: AppearancePreferences;
  themePresets: readonly ThemePreset[];
}

export default function App({ initialAppearance, themePresets }: AppProps) {
  const [projectTitle, setProjectTitle] = useState("Ruins After Rain");
  useEffect(() => { document.title = `${projectTitle} · M Agent`; }, [projectTitle]);
  const [projectPpq, setProjectPpq] = useState(PPQ);
  const [projectMetadata, setProjectMetadata] = useState<ProjectMetadata | null>(null);
  const [tracks, setTracks] = useState<MidiTrack[]>(() => cloneTracks(initialTracks));
  const [selectedTrackId, setSelectedTrackId] = useState(initialTracks[0].id);
  const [selectedNoteId, setSelectedNoteId] = useState<string | null>(null);
  const [tool, setTool] = useState<EditorTool>("pointer");
  const [zoom, setZoom] = useState(1);
  const [gridTicks, setGridTicks] = useState(PPQ / 4);
  const [tempo, setTempo] = useState(104);
  const [playhead, setPlayhead] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [mode, setMode] = useState<AgentMode>("goal");
  const [past, setPast] = useState<MidiTrack[][]>([]);
  const [future, setFuture] = useState<MidiTrack[][]>([]);
  const [drag, setDrag] = useState<DragState | null>(null);
  const [candidates, setCandidates] = useState<Candidate[]>(seedCandidates);
  const [messages, setMessages] = useState<ChatMessage[]>([
    { id: "hello", author: "agent", text: "我读完了当前 4 条轨道。循环在第 8 小节尾部略显拥挤，可以先留出半拍，再让旋律回到 C5。" },
  ]);
  const [prompt, setPrompt] = useState("");
  const [agentBusy, setAgentBusy] = useState(false);
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const menuBarRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const [appearance, setAppearance] = useState<AppearancePreferences>(initialAppearance);
  const [conversationSettings, setConversationSettings] = useState<ConversationSettings>(loadConversationSettings);
  const [shellPath, setShellPath] = useState(DEFAULT_SHELL_SETTINGS.path);
  const [shellCheck, setShellCheck] = useState<ShellCheckResult | null>(null);
  const [shellBusy, setShellBusy] = useState(false);
  const [themeListExpanded, setThemeListExpanded] = useState(false);
  const [workspaceLayout, setWorkspaceLayout] = useState(loadWorkspaceLayoutPreferences);
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth);
  const [resizingPane, setResizingPane] = useState<WorkspacePane | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [environment, setEnvironment] = useState<StartupEnvironmentReport | null>(null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [environmentBusy, setEnvironmentBusy] = useState(false);
  const [subscriptions, setSubscriptions] = useState<SubscriptionSummary[]>([]);
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
  const audioRef = useRef<AudioContext | null>(null);

  const beatWidth = 54 * zoom;
  const canvasWidth = KEY_WIDTH + BAR_COUNT * BEATS_PER_BAR * beatWidth;
  const selectedTrack = tracks.find((track) => track.id === selectedTrackId) ?? tracks[0];
  const selectedNote = selectedTrack?.notes.find((note) => note.id === selectedNoteId) ?? null;
  const magent = (window as unknown as { magent?: MagentBridge }).magent;

  const projectPayload = useCallback(
    (): RendererProjectPayload => toProjectPayload(projectTitle, projectPpq, tempo, tracks, projectMetadata),
    [projectMetadata, projectPpq, projectTitle, tempo, tracks],
  );

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(null), 2400);
  }, []);

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
    saveWorkspaceLayoutPreferences(workspaceLayout);
  }, [workspaceLayout]);

  useEffect(() => {
    saveConversationSettings(conversationSettings);
  }, [conversationSettings]);

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

  const commitTracks = useCallback((next: MidiTrack[], preserveCandidates = false) => {
    setTracks((current) => {
      setPast((history) => [...history.slice(-39), cloneTracks(current)]);
      setFuture([]);
      return next;
    });
    if (!preserveCandidates) setCandidates([]);
  }, []);

  const undo = useCallback(() => {
    setCandidates([]);
    setPast((history) => {
      if (!history.length) return history;
      const previous = history[history.length - 1];
      setTracks((current) => {
        setFuture((items) => [cloneTracks(current), ...items].slice(0, 40));
        return cloneTracks(previous);
      });
      return history.slice(0, -1);
    });
  }, []);

  const redo = useCallback(() => {
    setCandidates([]);
    setFuture((items) => {
      if (!items.length) return items;
      const next = items[0];
      setTracks((current) => {
        setPast((history) => [...history.slice(-39), cloneTracks(current)]);
        return cloneTracks(next);
      });
      return items.slice(1);
    });
  }, []);

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
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
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
  }, [deleteSelectedNote, redo, undo]);

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
    const dpr = window.devicePixelRatio || 1;
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

    for (let beat = 0; beat <= BAR_COUNT * BEATS_PER_BAR; beat += 1) {
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
      if (isBar && beat < BAR_COUNT * BEATS_PER_BAR) {
        context.fillStyle = themeColor("--canvas-ruler-text", "#8d9290");
        context.font = "10px ui-monospace, monospace";
        context.textBaseline = "middle";
        context.fillText(String(beat / BEATS_PER_BAR + 1).padStart(2, "0"), x + 7, 15);
      }
    }

    const soloActive = tracks.some((track) => track.solo);
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
  }, [appearance, beatWidth, canvasWidth, playhead, projectPpq, selectedNoteId, selectedTrackId, tracks]);

  useEffect(drawCanvas, [drawCanvas]);

  const soundNote = useCallback((pitch: number, velocity: number, durationMs = 120) => {
    try {
      const AudioCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtor) return;
      const audio = audioRef.current ?? new AudioCtor();
      audioRef.current = audio;
      const oscillator = audio.createOscillator();
      const gain = audio.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.value = 440 * 2 ** ((pitch - 69) / 12);
      const now = audio.currentTime;
      const volume = (velocity / 127) * 0.045;
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.001, volume), now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + durationMs / 1000);
      oscillator.connect(gain).connect(audio.destination);
      oscillator.start(now);
      oscillator.stop(now + durationMs / 1000 + 0.02);
    } catch {
      // Audition is optional; editing remains available when audio is unavailable.
    }
  }, []);

  useEffect(() => {
    if (!isPlaying) return;
    startedAtRef.current = performance.now();
    startTickRef.current = currentPlayheadRef.current;
    lastTickRef.current = currentPlayheadRef.current;
    const maxTick = BAR_COUNT * BEATS_PER_BAR * projectPpq;
    let frame = 0;
    const update = (now: number) => {
      const elapsed = now - startedAtRef.current;
      let tick = startTickRef.current + elapsed * ((tempo * projectPpq) / 60000);
      if (tick >= maxTick) {
        tick %= maxTick;
        startedAtRef.current = now;
        startTickRef.current = tick;
        lastTickRef.current = 0;
      }
      const previous = lastTickRef.current;
      const soloActive = tracks.some((track) => track.solo);
      tracks.forEach((track) => {
        if (track.muted || (soloActive && !track.solo)) return;
        track.notes.forEach((note) => {
          if (note.startTick >= previous && note.startTick < tick) {
            soundNote(note.pitch, note.velocity, Math.min(300, (note.durationTicks / projectPpq) * (60000 / tempo)));
          }
        });
      });
      lastTickRef.current = tick;
      setPlayhead(tick);
      frame = requestAnimationFrame(update);
    };
    frame = requestAnimationFrame(update);
    return () => cancelAnimationFrame(frame);
  }, [isPlaying, projectPpq, soundNote, tempo, tracks]);

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

  const onCanvasPointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const { x, y } = canvasPoint(event);
    if (y < RULER_HEIGHT && x > KEY_WIDTH) {
      setPlayhead(clamp((x - KEY_WIDTH) / beatWidth * projectPpq, 0, BAR_COUNT * BEATS_PER_BAR * projectPpq));
      return;
    }
    if (x <= KEY_WIDTH || y <= RULER_HEIGHT || !selectedTrack) return;
    const hit = noteAtPoint(x, y);
    if (hit) {
      setSelectedNoteId(hit.id);
      soundNote(hit.pitch, hit.velocity);
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
      soundNote(note.pitch, note.velocity);
    } else {
      setSelectedNoteId(null);
    }
  };

  const onCanvasPointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    const { x, y } = canvasPoint(event);
    const deltaTicks = Math.round((((x - drag.startX) / beatWidth) * projectPpq) / gridTicks) * gridTicks;
    const deltaPitch = -Math.round((y - drag.startY) / ROW_HEIGHT);
    setTracks(drag.base.map((track) => ({
      ...track,
      notes: track.notes.map((note) => {
        if (note.id !== drag.noteId) return note;
        if (drag.kind === "resize") {
          return { ...note, durationTicks: Math.max(gridTicks, drag.original.durationTicks + deltaTicks) };
        }
        return {
          ...note,
          startTick: Math.max(0, drag.original.startTick + deltaTicks),
          pitch: clamp(drag.original.pitch + deltaPitch, MIN_PITCH, MAX_PITCH),
        };
      }),
    })));
  };

  const onCanvasPointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (!drag) return;
    setPast((history) => [...history.slice(-39), drag.base]);
    setFuture([]);
    setCandidates([]);
    setDrag(null);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const onCanvasDoubleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x <= KEY_WIDTH || y <= RULER_HEIGHT || noteAtPoint(x, y) || !selectedTrack) return;
    const note: MidiNote = { id: uid("note"), pitch: pitchAtY(y), startTick: Math.max(0, tickAtX(x)), durationTicks: projectPpq, velocity: 88 };
    commitTracks(tracks.map((track) => track.id === selectedTrackId ? { ...track, notes: [...track.notes, note] } : track));
    setSelectedNoteId(note.id);
    soundNote(note.pitch, note.velocity);
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

  const sendPrompt = async () => {
    const clean = prompt.trim();
    if (!clean || agentBusy) return;
    const requestMode = mode;
    setMessages((items) => [...items, { id: uid("message"), author: "user", text: clean }]);
    setPrompt("");
    setAgentBusy(true);
    try {
      if (!magent?.runAgent) {
        const fallback = requestMode === "research"
          ? "演示只读分析：当前工程的旋律与低音在结尾密度偏高。工程未发生修改。"
          : requestMode === "plan"
            ? "演示计划：降低结尾力度并清理循环接缝；当前仅展示预览。"
            : "桌面桥尚未连接，已保留演示候选供交互测试。";
        setMessages((items) => [...items, { id: uid("message"), author: "agent", text: fallback }]);
        setCandidates(requestMode === "goal" ? seedCandidates.map((candidate) => ({ ...candidate, id: uid("candidate") })) : []);
        return;
      }
      const response = await magent.runAgent({
        mode: requestMode,
        objective: clean,
        project: projectPayload(),
        conversation: conversationSettings,
        focusTrackId: selectedTrack?.id,
      });
      setMessages((items) => [...items, {
        id: uid("message"),
        author: "agent",
        text: `${response.analysis}${response.provider === "pi-offline" ? "（离线分析）" : ""}`,
        thinking: response.thinking,
      }]);
      setCandidates(requestMode === "research"
        ? []
        : response.candidates.map((changeSet, index) => candidateFromChangeSet(changeSet, index, requestMode)));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Agent 请求失败。";
      setMessages((items) => [...items, { id: uid("message"), author: "agent", text: `请求失败：${message} 工程未发生修改。` }]);
      setCandidates([]);
    } finally {
      setAgentBusy(false);
    }
  };

  const acceptCandidate = (candidate: Candidate) => {
    if (mode !== "goal" || candidate.sourceMode !== "goal" || !candidate.supported || candidate.state) return;
    try {
      const next = applyNoteChangeSet(tracks, candidate.changeSet);
      commitTracks(next, true);
      setCandidates((items) => items.map((item) => item.id === candidate.id ? { ...item, state: "accepted" } : item));
      setMessages((items) => [...items, { id: uid("message"), author: "agent", text: `已原子应用“${candidate.title}”。全部操作可用 Ctrl+Z 一次撤销。` }]);
      showToast("候选已应用，可一次撤销");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "候选应用失败");
    }
  };

  const loadProjectResult = (result: OpenMidiResult, source: "MIDI" | "工程") => {
    if (result.canceled) return;
    if (!result.project) {
      showToast(`${source}未返回可用的工程数据`);
      return;
    }
    const loadedTracks = projectToTracks(result.project);
    setTracks(loadedTracks);
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
    setSelectedTrackId(loadedTracks[0]?.id ?? "");
    setSelectedNoteId(null);
    setPlayhead(0);
    setPast([]);
    setFuture([]);
    setCandidates([]);
    setMessages((items) => [...items, { id: uid("message"), author: "agent", text: `${source}已载入：${loadedTracks.length} 条轨道。${result.warnings?.length ? `另有 ${result.warnings.length} 条导入提示。` : ""}` }]);
    showToast(`${source}已载入`);
  };

  const handleOpen = async () => {
    if (!magent?.openMidi) return showToast("桌面文件桥尚未连接，当前为演示工程");
    try { loadProjectResult(await magent.openMidi(), "MIDI"); } catch (error) { showToast(errorMessage(error, "未能打开 MIDI 文件")); }
  };

  const handleOpenProject = async () => {
    if (!magent?.openProject) return showToast("桌面文件桥尚未连接");
    try { loadProjectResult(await magent.openProject(), "工程"); } catch (error) { showToast(errorMessage(error, "未能打开工程文件")); }
  };

  const handleSaveProject = async () => {
    if (!magent?.saveProject) return showToast("桌面文件桥尚未连接");
    try {
      const result = await magent.saveProject(projectPayload());
      if (!result.canceled) showToast("工程已保存");
    } catch (error) { showToast(errorMessage(error, "工程保存失败")); }
  };

  const handleExport = async () => {
    if (!magent?.exportMidi) return showToast("桌面文件桥尚未连接，导出将在集成后可用");
    try {
      const result = await magent.exportMidi(projectPayload());
      if (!result.canceled) showToast("MIDI 已导出");
    } catch (error) { showToast(errorMessage(error, "导出失败")); }
  };

  const runMenuAction = useCallback((action: string) => {
    setActiveMenu(null);
    if (action === "file-open-midi") void handleOpen();
    else if (action === "file-open-project") void handleOpenProject();
    else if (action === "file-save-project") void handleSaveProject();
    else if (action === "file-export-midi") void handleExport();
    else if (action === "edit-undo") undo();
    else if (action === "edit-redo") redo();
    else if (action === "view-check-environment") void refreshEnvironment();
    else if (action === "view-settings") { setSettingsSection("general"); setSettingsOpen(true); }
    else if (action === "window-minimize") void magent?.minimizeWindow();
    else if (action === "window-maximize") void magent?.toggleMaximizeWindow();
    else if (action === "window-close") void magent?.closeWindow();
    else if (action === "plugins-settings") { setSettingsSection("plugins"); setSettingsOpen(true); }
    else if (action === "help-about") showToast("M Agent · 面向独立游戏开发者的桌面 MIDI 创作 Agent");
    else if (action === "help-settings") { setSettingsSection("general"); setSettingsOpen(true); }
  }, [handleExport, handleOpen, handleOpenProject, handleSaveProject, magent, redo, refreshEnvironment, showToast, undo]);

  useEffect(() => {
    const onMenuShortcut = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select")) return;
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "o" && !event.shiftKey) { event.preventDefault(); void handleOpen(); }
      else if (key === "o" && event.shiftKey) { event.preventDefault(); void handleOpenProject(); }
      else if (key === "s" && !event.shiftKey) { event.preventDefault(); void handleSaveProject(); }
      else if (key === "s" && event.shiftKey) { event.preventDefault(); void handleExport(); }
      else if (key === "w") { event.preventDefault(); void magent?.closeWindow(); }
    };
    window.addEventListener("keydown", onMenuShortcut);
    return () => window.removeEventListener("keydown", onMenuShortcut);
  }, [handleExport, handleOpen, handleOpenProject, handleSaveProject, magent]);

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

  const environmentMessages = environmentError
    ? [{ id: "environment-report", message: environmentError, instruction: "请重新检测；若问题持续，请重新启动应用。", action: "repair-app" as const }]
    : environment?.issues ?? [];
  const openAIStatus = environment?.providers.find((provider) => provider.id === "openai");
  const codexStatus = environment?.providers.find((provider) => provider.id === "openai-codex");
  const online = environment?.agentReady ?? false;
  const activeSubscription = subscriptions.find((subscription) => subscription.isActive);
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
    <div className={`app-shell ${environmentMessages.length ? "has-environment-alert" : ""}`}>
      <header className="titlebar">
        <div className="brand" aria-label="M Agent">
          <span className="brand-mark">M<span>/</span>A</span>
          <nav className="menu-bar" ref={menuBarRef} aria-label="应用菜单">
            {menuGroups.map((group) => (
              <div key={group.key} className={`menu-group ${activeMenu === group.key ? "open" : ""}`}>
                <button
                  type="button"
                  className="menu-trigger"
                  aria-expanded={activeMenu === group.key}
                  onClick={() => setActiveMenu((current) => current === group.key ? null : group.key)}
                >{group.label}<span className="menu-access">({group.accessKey})</span></button>
                {activeMenu === group.key && (
                  <div className="menu-panel" role="menu">
                    {group.items.map((item) => (
                      <button
                        key={`${group.key}-${item.label}`}
                        type="button"
                        className="menu-item"
                        role="menuitem"
                        disabled={item.disabled}
                        onClick={() => item.action && runMenuAction(item.action)}
                      >
                        <span>{item.label}</span>
                        {item.shortcut && <kbd>{item.shortcut}</kbd>}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </nav>
        </div>
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
          <div className="position-readout">{playPosition}</div>
        </div>
        <label className="transport-field"><span>BPM</span><input type="number" min="40" max="240" value={tempo} onChange={(event) => setTempo(clamp(Number(event.target.value), 40, 240))} /></label>
        <div className="transport-field"><span>拍号</span><strong>4 / 4</strong></div>
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
          <div className="track-inspector">
            <div className="inspector-label">SELECTED TRACK</div>
            <label><span>名称</span><input value={selectedTrack?.name ?? ""} onChange={(event) => setTracks(tracks.map((track) => track.id === selectedTrackId ? { ...track, name: event.target.value } : track))} onBlur={() => setPast((history) => history)} /></label>
            <label><span>角色</span><select value={selectedTrack?.role ?? "other"} onChange={(event) => updateTrack(selectedTrackId, { role: event.target.value as TrackRole })}><option value="melody">Melody</option><option value="harmony">Harmony</option><option value="bass">Bass</option><option value="drums">Drums</option><option value="other">Other</option></select></label>
            {selectedNote ? (
              <div className="note-inspector">
                <div className="inspector-label">SELECTED NOTE</div>
                <div className="note-data"><strong>{noteName(selectedNote.pitch)}</strong><span>VEL {selectedNote.velocity}</span></div>
                <label><span>力度</span><input type="range" min="1" max="127" value={selectedNote.velocity} onChange={(event) => setTracks(tracks.map((track) => ({ ...track, notes: track.notes.map((note) => note.id === selectedNote.id ? { ...note, velocity: Number(event.target.value) } : note) })))} onMouseUp={(event) => updateSelectedNote({ velocity: Number((event.target as HTMLInputElement).value) })} /></label>
                <button className="danger-text" onClick={deleteSelectedNote}><Icon name="trash" />删除音符</button>
              </div>
            ) : <p className="inspector-hint">双击空白处添加音符，拖动右边缘调整长度。</p>}
          </div>
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
                  {conversationSettings.showThinking && message.thinking && message.thinking.length > 0 && (
                    <details className="thinking-process">
                      <summary>思考过程 · {message.thinking.length} 段</summary>
                      {message.thinking.map((thinking, index) => <p key={`${message.id}-thinking-${index}`}>{thinking}</p>)}
                    </details>
                  )}
                  <p className="message-answer">{message.text}</p>
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

          <div className="prompt-area">
            <div className="prompt-context"><span>{selectedTrack ? `范围：${selectedTrack.name}` : "范围：全曲"}</span><span>{mode === "goal" ? `最多 ${conversationSettings.goalMaxTurns} 轮` : modeMeta[mode].short}</span></div>
            <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); sendPrompt(); } }} placeholder={mode === "research" ? "询问和声、结构或循环问题…" : mode === "plan" ? "描述想要的修改，生成执行计划…" : "例如：让第 7–8 小节更空旷，保持无缝循环…"} />
            <button className="send-button" disabled={!prompt.trim() || agentBusy} onClick={sendPrompt} aria-label="发送"><Icon name="send" /></button>
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
                  <section className="settings-group">
                    <div className="settings-group-heading"><div><strong>试听音源</strong><span>当前钢琴卷帘尝试使用浏览器内置振荡器进行无依赖试听。</span></div><span className="availability-badge preview">当前实现</span></div>
                    <div className="settings-row"><div><strong>内置合成器</strong><span>Web Audio Oscillator · 实际可用性取决于系统音频环境</span></div><span className="provider-state">默认试听路径</span></div>
                  </section>
                  <div className="settings-empty"><Icon name="music" size={24} /><strong>SoundFont 与 VST 暂未接入</strong><p>音色包选择、采样器、MIDI 输出设备和插件乐器将在后续音源系统中提供。</p></div>
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
      {toast && <div className="toast"><span className="status-light online" />{toast}</div>}
    </div>
  );
}
