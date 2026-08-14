import { Agent, type AgentEvent, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  Type,
  createModels,
  createProvider,
  fauxAssistantMessage,
  fauxProvider,
  clampThinkingLevel,
  fauxThinking,
  fauxText,
  fauxToolCall,
  type CredentialStore,
  type Model,
  type Provider,
} from "@earendil-works/pi-ai";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { googleGenerativeAIApi } from "@earendil-works/pi-ai/api/google-generative-ai.lazy";
import type { AgentMode } from "../../shared/midi.js";
import type { MidiProject, ProposedChangeSet } from "../../shared/midi.js";
import type { PiThinkingLevel } from "../../shared/conversation-settings.js";
import type { SubscriptionApiType, SubscriptionModel } from "../../shared/subscriptions.js";
import { DEFAULT_CONTEXT_WINDOW } from "../../shared/subscriptions.js";
import { validateChangeSet } from "../midi/edits.js";
import { assertAgentToolAllowed } from "./permissions.js";
import { parseProposedChangeSet } from "./schema.js";
import { AGENT_CONTEXT_PROMPT } from "./context-prompt.js";

export interface PiCustomProviderConfig {
  providerId: string;
  apiType: SubscriptionApiType;
  baseUrl: string;
  apiKey: string;
  models: SubscriptionModel[];
  activeModelId?: string;
}

export interface PiKernelRequest {
  requestId: string;
  mode: AgentMode;
  objective: string;
  project: Readonly<MidiProject>;
  apiKey?: string | null;
  provider?: "openai" | "openai-codex" | "custom";
  credentials?: CredentialStore;
  customProvider?: PiCustomProviderConfig;
  modelId?: string;
  maximumTurns?: number;
  maximumOutputTokens?: number;
  thinkingLevel?: PiThinkingLevel;
  /** 工程注入方式：selected 注入概览 + 选中轨道音符明细；all（默认）注入完整工程。 */
  projectInjection?: "all" | "selected";
  /** 配合 projectInjection === "selected" 使用；不存在时回退到完整工程。 */
  focusTrackId?: string;
  signal?: AbortSignal;
}

export interface PiKernelEvent {
  type: "lifecycle" | "text_delta" | "thinking_delta" | "tool_start" | "tool_end";
  name: string;
  text?: string;
  isError?: boolean;
}

export interface PiKernelResult {
  analysis: string;
  candidates: ProposedChangeSet[];
  provider: "pi-openai" | "pi-openai-codex" | "pi-custom" | "pi-offline";
  events: PiKernelEvent[];
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

const TOOL_CAPABILITIES = {
  inspect_midi_project: "project.read",
  analyze_midi_project: "project.analyze",
  propose_midi_changes: "changes.propose",
} as const;

type PiToolName = keyof typeof TOOL_CAPABILITIES;

const MODE_TOOLS: Readonly<Record<AgentMode, ReadonlySet<PiToolName>>> = {
  research: new Set(["inspect_midi_project", "analyze_midi_project"]),
  plan: new Set(["inspect_midi_project", "analyze_midi_project", "propose_midi_changes"]),
  goal: new Set(["inspect_midi_project", "analyze_midi_project", "propose_midi_changes"]),
};
const MAX_CANDIDATES = 3;

const operationSchema = Type.Object(
  {
    type: Type.String(),
  },
  { additionalProperties: true },
);

const proposedChangeSetSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  summary: Type.String({ minLength: 1 }),
  operations: Type.Array(operationSchema, { minItems: 1, maxItems: 500 }),
  validation: Type.Array(Type.Any()),
  estimatedAffectedNotes: Type.Integer({ minimum: 0, maximum: 10_000 }),
});

/** 单次循环计算音高范围，避免展开参数在超大单轨上触发栈溢出。 */
function pitchRange(notes: ReadonlyArray<{ pitch: number }>): [number, number] | null {
  if (notes.length === 0) return null;
  let minimum = notes[0].pitch;
  let maximum = notes[0].pitch;
  for (let index = 1; index < notes.length; index += 1) {
    const pitch = notes[index].pitch;
    if (pitch < minimum) minimum = pitch;
    else if (pitch > maximum) maximum = pitch;
  }
  return [minimum, maximum];
}

function analysisSnapshot(project: Readonly<MidiProject>) {
  const notes = project.tracks.flatMap((track) => track.notes);
  const lastTick = notes.reduce(
    (maximum, note) => Math.max(maximum, note.startTick + note.durationTicks),
    0,
  );
  return {
    title: project.title,
    ppq: project.ppq,
    tempoMap: project.tempoMap,
    timeSignatures: project.timeSignatures,
    loopRegion: project.loopRegion,
    tracks: project.tracks.map((track) => ({
      id: track.id,
      name: track.name,
      role: track.role,
      channel: track.channel,
      program: track.program,
      muted: track.muted,
      solo: track.solo,
      noteCount: track.notes.length,
      pitchRange: pitchRange(track.notes),
      endTick: track.notes.reduce(
        (maximum, note) => Math.max(maximum, note.startTick + note.durationTicks),
        0,
      ),
    })),
    noteCount: notes.length,
    endTick: lastTick,
  };
}


export function buildProjectContext(request: PiKernelRequest): string {
  if (request.projectInjection === "selected" && request.focusTrackId) {
    const track = request.project.tracks.find((item) => item.id === request.focusTrackId);
    if (track) {
      return `Current project overview:\n${JSON.stringify(analysisSnapshot(request.project))}\n\nSelected track (${track.name}, id=${track.id}):\n${JSON.stringify(track)}`;
    }
  }
  return `Current project (.magent):\n${JSON.stringify(projectForPrompt(request.project))}`;
}

/**
 * 注入给模型的工程序列化：剥离顶层 instruments（含本地绝对路径），
 * 避免泄露文件路径；Agent 用不到音源清单（只读元数据）。
 */
function projectForPrompt(project: Readonly<MidiProject>): unknown {
  const { instruments: _instruments, ...rest } = project;
  return rest;
}

function systemPrompt(mode: AgentMode): string {
  const boundary = mode === "research"
    ? "You are in read-only research mode. Never propose, apply, export, or write changes."
    : mode === "plan"
      ? "You are in plan mode. You may propose validated edits for preview, but never apply, export, or write them."
      : "You are in goal mode. Generate one to three validated candidate change sets, but never apply, export, or write them.";
  return [
    "You are the Pi-powered planning kernel of a game-music MIDI desktop editor.",
    boundary,
    "Use the provided tools instead of inventing track or note identifiers.",
    "Keep MIDI pitch and velocity in 0..127, ticks non-negative, and durations positive.",
    "Finish with a concise Chinese analysis for the user.",
    AGENT_CONTEXT_PROMPT,
  ].join("\n\n");
}

function textFromEvent(event: AgentEvent): string {
  if (event.type !== "message_update") return "";
  const update = event.assistantMessageEvent;
  return update.type === "text_delta" ? update.delta : "";
}

function thinkingFromEvent(event: AgentEvent): string {
  if (event.type !== "message_update") return "";
  const update = event.assistantMessageEvent;
  return update.type === "thinking_delta" ? update.delta : "";
}

function collectAssistantText(agent: Agent): string {
  const messages = [...agent.state.messages].reverse();
  for (const message of messages) {
    if (message.role !== "assistant") continue;
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();
  }
  return "";
}

function collectAssistantThinking(agent: Agent): string[] {
  return agent.state.messages.flatMap((message) => message.role === "assistant"
    ? message.content.flatMap((block) => block.type === "thinking" && !block.redacted && block.thinking.trim()
      ? [block.thinking.trim()]
      : [])
    : []);
}

function createTools(
  request: PiKernelRequest,
  candidates: ProposedChangeSet[],
): AgentTool[] {
  const inspectParameters = Type.Object({});
  const analyzeParameters = Type.Object({ focus: Type.Optional(Type.String()) });
  const proposeParameters = Type.Object({ changeSet: proposedChangeSetSchema });
  const inspect: AgentTool<typeof inspectParameters> = {
    name: "inspect_midi_project",
    label: "Inspect MIDI project",
    description: "Read a compact, non-mutating overview of the current MIDI project.",
    parameters: inspectParameters,
    execute: async () => ({
      content: [{ type: "text", text: JSON.stringify(analysisSnapshot(request.project)) }],
      details: { readOnly: true },
    }),
  };
  const analyze: AgentTool<typeof analyzeParameters> = {
    name: "analyze_midi_project",
    label: "Analyze MIDI project",
    description: "Read the full normalized MIDI project for musical analysis. This never mutates it.",
    parameters: analyzeParameters,
    execute: async (_id, params) => ({
      content: [{ type: "text", text: JSON.stringify({ focus: params.focus, project: request.project }) }],
      details: { readOnly: true },
    }),
  };
  const propose: AgentTool<typeof proposeParameters> = {
    name: "propose_midi_changes",
    label: "Propose MIDI changes",
    description: "Submit a candidate MIDI edit transaction for validation and user preview. It does not apply edits.",
    parameters: proposeParameters,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const parsed = parseProposedChangeSet(params.changeSet);
      if (candidates.length >= MAX_CANDIDATES) {
        throw new Error(`A maximum of ${MAX_CANDIDATES} candidates is allowed per run.`);
      }
      if (candidates.some((candidate) => candidate.id === parsed.id)) {
        throw new Error(`Candidate ID ${parsed.id} has already been submitted.`);
      }
      const domain = validateChangeSet(request.project, parsed, {
        maximumOperations: 500,
        maximumAffectedNotes: 10_000,
      });
      if (!domain.valid) {
        throw new Error(domain.issues.map((issue) => issue.message).join(" "));
      }
      const validated: ProposedChangeSet = {
        ...parsed,
        validation: [...(parsed.validation ?? []), domain],
        estimatedAffectedNotes: domain.affectedNotes,
      };
      candidates.push(validated);
      return {
        content: [{ type: "text", text: `Candidate ${validated.id} passed validation and is awaiting user approval.` }],
        details: { candidateId: validated.id, applied: false },
      };
    },
  };
  return request.mode === "research" ? [inspect, analyze] : [inspect, analyze, propose];
}

function createOfflineRuntime(request: PiKernelRequest, project: Readonly<MidiProject>) {
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const melody = project.tracks.find((track) => track.role === "melody") ?? project.tracks[0];
  const snapshot = analysisSnapshot(project);
  if (request.mode === "research" || !melody?.notes.length) {
    faux.setResponses([
      fauxAssistantMessage(
        [
          fauxThinking(`先检查 ${snapshot.tracks.length} 条轨道的音符数量、音域与循环结尾，保持只读边界。`),
          fauxText(`Pi 离线调研完成：${snapshot.tracks.length} 条轨道、${snapshot.noteCount} 个音符；未产生任何修改。`),
        ],
      ),
    ]);
  } else {
    const ending = [...melody.notes].sort((a, b) => b.startTick - a.startTick).slice(0, 4);
    const changeSet = {
      id: `${request.requestId}-pi-offline`,
      summary: request.mode === "plan" ? "收束结尾动态（Pi 计划预览）" : "收束结尾动态（Pi 离线候选）",
      operations: [{
        type: "update_notes",
        trackId: melody.id,
        changes: ending.map((note, index) => ({
          noteId: note.id,
          velocity: Math.max(45, note.velocity - 8 - index * 2),
        })),
      }],
      validation: [],
      estimatedAffectedNotes: ending.length,
    };
    faux.setResponses([
      fauxAssistantMessage(
        [fauxToolCall("inspect_midi_project", {}), fauxToolCall("propose_midi_changes", { changeSet })],
        { stopReason: "toolUse" },
      ),
      fauxAssistantMessage(fauxText(
        request.mode === "plan"
          ? "Pi 已形成一份只供预览的修改计划，工程未发生修改。"
          : "Pi 已生成并验证一个候选，只有用户确认后才能应用。",
      )),
    ]);
  }
  return { models, model: faux.getModel(), provider: "pi-offline" as const };
}

function createOpenAIRuntime(apiKey: string | undefined, credentials: CredentialStore | undefined, modelId: string) {
  const models = createModels({ credentials });
  models.setProvider(openaiProvider());
  const model = models.getModel("openai", modelId);
  if (!model) throw new Error(`Pi AI 找不到 OpenAI 模型：${modelId}`);
  return { models, model, apiKey, provider: "pi-openai" as const };
}

function createOpenAICodexRuntime(credentials: CredentialStore, modelId: string) {
  const models = createModels({ credentials });
  models.setProvider(openaiCodexProvider());
  const model = models.getModel("openai-codex", modelId);
  if (!model) throw new Error(`Pi AI 找不到 OpenAI Codex 模型：${modelId}`);
  return { models, model, provider: "pi-openai-codex" as const };
}

export function buildCustomProviderModels(config: PiCustomProviderConfig): Array<Model<any>> {
  return config.models.map((model) => ({
    id: model.id,
    name: model.name,
    api: config.apiType,
    provider: config.providerId,
    baseUrl: config.baseUrl,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
  }));
}

export function createCustomProvider(config: PiCustomProviderConfig): Provider {
  const apiForType = (apiType: SubscriptionApiType) => {
    if (apiType === "openai-completions") return openAICompletionsApi();
    if (apiType === "openai-responses") return openAIResponsesApi();
    if (apiType === "anthropic-messages") return anthropicMessagesApi();
    return googleGenerativeAIApi();
  };
  return createProvider({
    id: config.providerId,
    name: config.providerId,
    baseUrl: config.baseUrl,
    auth: {
      apiKey: {
        name: `${config.providerId} API key`,
        resolve: async () => ({ auth: { apiKey: config.apiKey, baseUrl: config.baseUrl } }),
      },
    },
    models: buildCustomProviderModels(config),
    api: apiForType(config.apiType),
  });
}

function createCustomRuntime(config: PiCustomProviderConfig, activeModelId: string) {
  const models = createModels();
  const provider = createCustomProvider(config);
  models.setProvider(provider);
  const model = models.getModel(config.providerId, activeModelId);
  if (!model) throw new Error(`Pi AI 找不到订阅模型：${activeModelId}`);
  return { models, model, apiKey: config.apiKey, provider: "pi-custom" as const };
}

export async function runPiKernel(request: PiKernelRequest): Promise<PiKernelResult> {
  const candidates: ProposedChangeSet[] = [];
  const events: PiKernelEvent[] = [];
  const runtime = request.provider === "openai-codex" && request.credentials
    ? createOpenAICodexRuntime(request.credentials, request.modelId ?? "gpt-5.4-mini")
    : request.provider === "custom" && request.customProvider
      ? createCustomRuntime(request.customProvider, request.modelId ?? request.customProvider.activeModelId ?? request.customProvider.models[0]?.id ?? "")
      : request.provider === "openai" && (request.apiKey || request.credentials)
        ? createOpenAIRuntime(request.apiKey ?? undefined, request.credentials, request.modelId ?? "gpt-5-mini")
        : request.apiKey
          ? createOpenAIRuntime(request.apiKey, undefined, request.modelId ?? "gpt-5-mini")
          : createOfflineRuntime(request, request.project);
  const maximumTurns = Math.max(1, Math.min(Math.round(request.maximumTurns ?? (request.mode === "goal" ? 20 : 2)), 100));
  const maximumOutputTokens = Math.max(1_024, Math.min(Math.round(request.maximumOutputTokens ?? 500_000), 2_000_000));
  const requestedThinkingLevel = request.thinkingLevel ?? "medium";
  const clampedThinkingLevel = clampThinkingLevel(runtime.model, requestedThinkingLevel);
  const effectiveThinkingLevel = clampedThinkingLevel === "low" || clampedThinkingLevel === "medium" || clampedThinkingLevel === "high"
    ? clampedThinkingLevel
    : requestedThinkingLevel;
  let turns = 0;
  let outputTokens = 0;
  let inputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let cost = 0;
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt(request.mode),
      model: runtime.model as Model<any>,
      thinkingLevel: effectiveThinkingLevel,
      tools: createTools(request, candidates),
      messages: [],
    },
    streamFn: (model, context, options) => {
      const remainingOutputTokens = Math.max(16, maximumOutputTokens - outputTokens);
      return runtime.models.streamSimple(model, context, {
        ...options,
        maxTokens: Math.min(model.maxTokens, remainingOutputTokens),
      });
    },
    getApiKey: () => request.apiKey ?? undefined,
    toolExecution: "sequential",
    sessionId: request.requestId,
    shouldStopAfterTurn: ({ message }) => {
      turns += 1;
      const usage = message.usage;
      if (usage) {
        inputTokens += usage.input;
        outputTokens += usage.output;
        cacheReadTokens += usage.cacheRead;
        cacheWriteTokens += usage.cacheWrite;
        cost += usage.cost?.total ?? 0;
      }
      if (turns >= maximumTurns) return true;
      if (outputTokens >= maximumOutputTokens) return true;
      if (request.mode === "research") return true;
      return candidates.length > 0 && turns >= 2;
    },
    beforeToolCall: async ({ toolCall }) => {
      const name = toolCall.name as PiToolName;
      if (!(name in TOOL_CAPABILITIES) || !MODE_TOOLS[request.mode].has(name)) {
        return { block: true, terminate: true, reason: `Tool ${toolCall.name} is forbidden in ${request.mode} mode.` };
      }
      assertAgentToolAllowed(request.mode, TOOL_CAPABILITIES[name]);
      return undefined;
    },
  });
  agent.subscribe((event) => {
    const delta = textFromEvent(event);
    const thinkingDelta = thinkingFromEvent(event);
    if (events.length >= 2_000) return;
    if (delta) events.push({ type: "text_delta", name: "assistant", text: delta });
    else if (thinkingDelta) events.push({ type: "thinking_delta", name: "assistant", text: thinkingDelta });
    else if (event.type === "tool_execution_start") events.push({ type: "tool_start", name: event.toolName });
    else if (event.type === "tool_execution_end") events.push({ type: "tool_end", name: event.toolName, isError: event.isError });
    else events.push({ type: "lifecycle", name: event.type });
  });
  const abortListener = () => agent.abort();
  request.signal?.addEventListener("abort", abortListener, { once: true });
  try {
    await agent.prompt([
      {
        role: "user",
        content: `${request.objective}\n\n${buildProjectContext(request)}`,
        timestamp: Date.now(),
      },
    ]);
  } finally {
    request.signal?.removeEventListener("abort", abortListener);
  }
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
  return {
    analysis: collectAssistantText(agent) || "Pi Agent 已完成运行。",
    candidates: request.mode === "research" ? [] : candidates,
    provider: runtime.provider,
    events,
    turns,
    thinking: collectAssistantThinking(agent),
    effectiveThinkingLevel,
    modelId: runtime.model.id,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    cost,
  };
}

export { MODE_TOOLS as PI_MODE_TOOLS };

