import type {
  AgentMode,
  AgentSession,
  ControllerEvent,
  MidiNote,
  MidiProject,
  PitchBendEvent,
  ProposedChangeSet,
  Revision,
  TempoEvent,
  TickRange,
  TimeSignatureEvent,
  TrackRole,
} from "./midi.js";
import type { ConversationSettings, PiThinkingLevel } from "./conversation-settings.js";
import type { BrowseShellResult, ShellCheckResult, ShellSettingsSnapshot } from "./shell.js";
import type {
  FetchModelsRequest,
  FetchModelsResult,
  ImportResult,
  SubscriptionInput,
  SubscriptionSummary,
} from "./subscriptions.js";
import type { InstrumentReference, InstrumentLibrarySummary, ProjectInstrument, ProjectInstrumentSnapshot } from "./instrument.js";
import type { SkillTraceEntry } from "./skills.js";

export interface RendererTrack {
  id: string;
  name: string;
  role: TrackRole;
  color?: string;
  channel?: number;
  program: number;
  muted: boolean;
  solo: boolean;
  volume?: number;
  instrument?: InstrumentReference;
  loopRegion?: TickRange | null;
  controllerEvents?: ControllerEvent[];
  pitchBends?: PitchBendEvent[];
  notes: MidiNote[];
}

export interface RendererProjectPayload {
  id?: string;
  title?: string;
  ppq: number;
  tempo: number;
  tempoMap?: TempoEvent[];
  timeSignatures?: TimeSignatureEvent[];
  loopRegion?: TickRange | null;
  tracks: RendererTrack[];
  revisions?: Revision[];
  agentSessions?: AgentSession[];
  /** 项目级音源清单（保存时快照）。 */
  instruments?: ProjectInstrument[];
}

export interface OpenMidiResult {
  canceled: boolean;
  filePath?: string;
  warnings?: string[];
  project?: MidiProject;
}

export interface SaveResult {
  canceled: boolean;
  filePath?: string;
}

/** 最近打开的项目记录。 */
export interface RecentProject {
  path: string;
  title?: string;
  openedAt: number;
}

/** 新建/打开/导入时目标窗口的选择。 */
export type ProjectOpenIntent = "new-project" | "open-project" | "import-midi";

export interface AgentRequestPayload {
  mode: AgentMode;
  objective: string;
  project: RendererProjectPayload;
  conversation?: ConversationSettings;
  /** 当前选中的轨道 id；配合 conversation.projectInjection === "selected" 使用。 */
  focusTrackId?: string;
  /** 工程内容哈希，用于候选版本绑定；应用候选前比对。 */
  projectVersion?: string;
}

export interface AgentResponsePayload {
  analysis: string;
  candidates: ProposedChangeSet[];
  kernel: "pi";
  provider: "pi-openai" | "pi-openai-codex" | "pi-custom" | "pi-offline";
  turns: number;
  /** 完成的思考段（含每段耗时）。 */
  thinking: ThinkingSegment[];
  effectiveThinkingLevel: PiThinkingLevel;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  /** 生成候选时对应的工程版本（透传请求值）。 */
  projectVersion?: string;
  /** Skill 嵌套调用轨迹（非 skill 运行为空数组）。 */
  skillTrace: SkillTraceEntry[];
}

export interface UsageSummary {
  runCount: number;
  turns: number;
  tokens: number;
  cacheRead: number;
  cost: number;
}

export interface UsageRow {
  key: string;
  label: string;
  runCount: number;
  turns: number;
  tokens: number;
  cacheRead: number;
  cost: number;
}

export interface UsagePage {
  rows: UsageRow[];
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export type EnvironmentCheckStatus = "ready" | "missing" | "warning" | "skipped";

export interface EnvironmentCheck {
  id: "electron" | "node" | "shell" | "pi-core" | "secure-storage";
  label: string;
  status: EnvironmentCheckStatus;
  required: boolean;
  version?: string;
  message: string;
}

export interface ProviderStatus {
  id: "openai" | "openai-codex";
  label: string;
  configured: boolean;
  usable: boolean;
  authType: "api_key" | "oauth" | null;
  source: "app" | "pi" | "environment" | "none";
  message: string;
}

export interface EnvironmentIssue {
  id: string;
  message: string;
  instruction: string;
  action: "open-provider-settings" | "open-shell-settings" | "repair-app";
}

/** 一段已完成的思考内容及其耗时（毫秒）。provider 未提供 start/end 事件时 durationMs 为空。 */
export interface ThinkingSegment {
  text: string;
  durationMs?: number;
}

export interface StartupEnvironmentReport {
  schemaVersion: 1;
  checkedAt: string;
  development: boolean;
  checks: EnvironmentCheck[];
  providers: ProviderStatus[];
  agentReady: boolean;
  activeProvider: "openai" | "openai-codex" | "offline";
  issues: EnvironmentIssue[];
}

/** Agent 运行中的实时调用更新（工具开始/结束、轮次、Skill 调用、思考增量）。 */
export type AgentLiveUpdate =
  | { kind: "tool_start"; name: string }
  | { kind: "tool_end"; name: string; isError?: boolean }
  | { kind: "turn"; turns: number }
  | { kind: "thinking"; text: string }
  | { kind: "skill"; skill: string; parentSkill?: string; depth: number; status: string; durationMs: number };

export interface MagentBridge {
  /** 运行平台（process.platform 透传）。 */
  platform: string;
  /** 订阅主进程原生菜单触发的动作；返回取消订阅函数。 */
  onMenuAction(callback: (action: string) => void): () => void;
  openMidi(): Promise<OpenMidiResult>;
  exportMidi(payload: RendererProjectPayload, defaultName?: string): Promise<SaveResult>;
  /** 导出离线渲染的音频字节（WAV/OGG）到用户选择的位置。 */
  exportAudio(payload: { format: "wav" | "ogg"; bytes: ArrayBuffer; defaultName: string }): Promise<SaveResult>;
  openProject(): Promise<OpenMidiResult>;
  saveProject(payload: RendererProjectPayload, defaultName?: string): Promise<SaveResult>;
  saveProviderApiKey(providerId: "openai", key: string): Promise<StartupEnvironmentReport>;
  clearProviderApiKey(providerId: "openai"): Promise<StartupEnvironmentReport>;
  getStartupEnvironment(): Promise<StartupEnvironmentReport>;
  loginOpenAICodex(): Promise<StartupEnvironmentReport>;
  logoutOpenAICodex(): Promise<StartupEnvironmentReport>;
  getShellSettings(): Promise<ShellSettingsSnapshot>;
  browseShell(): Promise<BrowseShellResult>;
  checkShell(path: string): Promise<ShellCheckResult>;
  runAgent(payload: AgentRequestPayload): Promise<AgentResponsePayload>;
  /** 取消当前窗口正在运行的 Agent 任务。 */
  cancelAgent(): Promise<void>;
  /** 订阅 Agent 运行中的实时调用更新；返回取消订阅函数。 */
  onAgentLive(callback: (update: AgentLiveUpdate) => void): () => void;
  /** 当前可用 Skill 列表（name + description），用于 @ 提及选择。 */
  listAgentSkills(): Promise<Array<{ name: string; description: string }>>;
  /** 启动意图：由主进程通过 additionalArguments 传入（新窗口打开/新建/导入）。 */
  startupIntent: ProjectOpenIntent | "";
  /** 最近打开的项目（.magent）列表。 */
  listRecentProjects(): Promise<RecentProject[]>;
  /** 直接打开指定路径的 .magent 工程。 */
  openProjectAt(path: string): Promise<OpenMidiResult>;
  /** 保存工程到已授权路径（不经对话框）。 */
  saveProjectTo(payload: RendererProjectPayload, path: string): Promise<SaveResult>;
  /** 在目标意图下新建一个窗口。 */
  createProjectWindow(intent: ProjectOpenIntent): Promise<void>;
  /** 订阅 macOS 原生菜单「最近打开项目」点击（携带路径）；返回取消订阅函数。 */
  onMenuOpenRecent(callback: (path: string) => void): () => void;
  listSubscriptions(): Promise<SubscriptionSummary[]>;
  createSubscription(input: SubscriptionInput): Promise<SubscriptionSummary>;
  updateSubscription(id: string, input: SubscriptionInput): Promise<SubscriptionSummary>;
  deleteSubscription(id: string): Promise<void>;
  activateSubscription(id: string): Promise<SubscriptionSummary[]>;
  importSubscriptions(): Promise<ImportResult>;
  fetchSubscriptionModels(request: FetchModelsRequest): Promise<FetchModelsResult>;
  getUsageSummary(): Promise<UsageSummary>;
  getUsageDays(page: number): Promise<UsagePage>;
  getUsageModels(page: number): Promise<UsagePage>;
  clearUsage(): Promise<void>;
  minimizeWindow(): Promise<void>;
  toggleMaximizeWindow(): Promise<void>;
  closeWindow(): Promise<void>;
  /** 确认未保存改动后放行关闭当前窗口（配合 onBeforeWindowClose）。 */
  confirmWindowClose(): Promise<void>;
  /** 订阅主进程「窗口即将关闭」事件（系统关闭入口），用于未保存改动提示；返回取消订阅函数。 */
  onBeforeWindowClose(callback: () => void): () => void;
  listInstruments(): Promise<InstrumentLibrarySummary[]>;
  /** 下载推荐音源（GeneralUser GS）到系统音源库目录；已存在则跳过下载。 */
  downloadRecommendedInstrument(): Promise<{ ok: boolean; path?: string; downloaded: boolean; error?: string }>;
  /** 弹出原生多选对话框，返回选中音源文件路径。 */
  pickInstrumentFiles(): Promise<string[]>;
  /** 解析单个音源文件为项目级快照（校验扩展名与大小，不写入任何库）。 */
  bindInstrumentToProject(path: string): Promise<ProjectInstrumentSnapshot>;
  /** 获取系统级音源目录绝对路径。 */
  getInstrumentSystemPath(): Promise<string>;
  /** 修改系统级音源目录；migrate 为 true 时把原目录文件迁移到新目录。 */
  setInstrumentSystemPath(path: string, migrate: boolean): Promise<{ path: string; migrated: boolean }>;
  /** 打开系统级音源目录（不存在则创建）。 */
  openInstrumentFolder(): Promise<{ ok: boolean; error?: string }>;
  /** 设置系统级音源条目启用状态（移除 = 仅禁用）。 */
  setInstrumentEnabled(path: string, enabled: boolean): Promise<InstrumentLibrarySummary[]>;
  /** 解析拖入的文件为本地绝对路径（Electron 沙箱渲染进程无法直接读取 File.path）。 */
  getPathForFile(file: File): string;
  readInstrumentFile(path: string): Promise<ArrayBuffer>;
}
