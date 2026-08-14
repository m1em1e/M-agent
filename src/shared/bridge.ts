import type {
  AgentMode,
  AgentSession,
  MidiProject,
  ProposedChangeSet,
  Revision,
  TempoEvent,
  TickRange,
  TimeSignatureEvent,
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

export interface RendererTrack {
  id: string;
  name: string;
  role: "melody" | "harmony" | "bass" | "drums" | "other";
  color?: string;
  channel?: number;
  program: number;
  muted: boolean;
  solo: boolean;
  volume?: number;
  instrument?: InstrumentReference;
  notes: Array<{
    id: string;
    pitch: number;
    startTick: number;
    durationTicks: number;
    velocity: number;
  }>;
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

export interface AgentRequestPayload {
  mode: AgentMode;
  objective: string;
  project: RendererProjectPayload;
  conversation?: ConversationSettings;
  /** 当前选中的轨道 id；配合 conversation.projectInjection === "selected" 使用。 */
  focusTrackId?: string;
}

export interface AgentResponsePayload {
  analysis: string;
  candidates: ProposedChangeSet[];
  kernel: "pi";
  provider: "pi-openai" | "pi-openai-codex" | "pi-custom" | "pi-offline";
  turns: number;
  thinking: string[];
  effectiveThinkingLevel: PiThinkingLevel;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
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

export interface MagentBridge {
  /** 运行平台（process.platform 透传）。 */
  platform: string;
  /** 订阅主进程原生菜单触发的动作；返回取消订阅函数。 */
  onMenuAction(callback: (action: string) => void): () => void;
  openMidi(): Promise<OpenMidiResult>;
  exportMidi(payload: RendererProjectPayload): Promise<SaveResult>;
  openProject(): Promise<OpenMidiResult>;
  saveProject(payload: RendererProjectPayload): Promise<SaveResult>;
  saveApiKey(key: string): Promise<void>;
  clearApiKey(): Promise<void>;
  hasApiKey(): Promise<boolean>;
  saveProviderApiKey(providerId: "openai", key: string): Promise<StartupEnvironmentReport>;
  clearProviderApiKey(providerId: "openai"): Promise<StartupEnvironmentReport>;
  getStartupEnvironment(): Promise<StartupEnvironmentReport>;
  loginOpenAICodex(): Promise<StartupEnvironmentReport>;
  logoutOpenAICodex(): Promise<StartupEnvironmentReport>;
  getShellSettings(): Promise<ShellSettingsSnapshot>;
  browseShell(): Promise<BrowseShellResult>;
  checkShell(path: string): Promise<ShellCheckResult>;
  runAgent(payload: AgentRequestPayload): Promise<AgentResponsePayload>;
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
  listInstruments(): Promise<InstrumentLibrarySummary[]>;
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
