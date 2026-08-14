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

export interface RendererTrack {
  id: string;
  name: string;
  role: "melody" | "harmony" | "bass" | "drums" | "other";
  color?: string;
  channel?: number;
  program: number;
  muted: boolean;
  solo: boolean;
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
}

export interface AgentResponsePayload {
  analysis: string;
  candidates: ProposedChangeSet[];
  kernel: "pi";
  provider: "pi-openai" | "pi-openai-codex" | "pi-offline";
  turns: number;
  thinking: string[];
  effectiveThinkingLevel: PiThinkingLevel;
  outputTokens: number;
}

export type EnvironmentCheckStatus = "ready" | "missing" | "warning" | "skipped";

export interface EnvironmentCheck {
  id: "electron" | "node" | "shell" | "npm" | "pi-core" | "pi-cli" | "secure-storage";
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
  action: "open-provider-settings" | "open-shell-settings" | "install-npm" | "repair-app";
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
}
