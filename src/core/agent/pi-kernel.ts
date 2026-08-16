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
import type { InstrumentLibrarySummary } from "../../shared/instrument.js";
import type { AgentLiveUpdate } from "../../shared/bridge.js";
import type { PiThinkingLevel } from "../../shared/conversation-settings.js";
import type { SubscriptionApiType, SubscriptionModel } from "../../shared/subscriptions.js";
import { DEFAULT_CONTEXT_WINDOW } from "../../shared/subscriptions.js";
import { validateChangeSet } from "../midi/edits.js";
import { assertAgentToolAllowed } from "./permissions.js";
import { parseProposedChangeSet } from "./schema.js";
import { AGENT_CONTEXT_PROMPT } from "./context-prompt.js";
import { invokeSkill, type ChildRunKernel } from "./skills/invoke.js";
import { mergeSkillOperations, type SkillOperationSource } from "./skills/merge.js";
import { getSkill, listSkillAvailability } from "./skills/registry.js";
import { createInvocationState, DEFAULT_INVOCATION_LIMITS } from "./skills/types.js";
import type {
  InvocationState,
  SkillContext,
  SkillDefinition,
  SkillInvocationResult,
  SkillTraceEntry,
} from "./skills/types.js";

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
  /** 子 Skill 调用兜底超时（毫秒）。undefined 表示不限时。 */
  childTimeoutMs?: number;
  /** 本次运行可用的 Skill 定义（由主进程加载）。 */
  skills?: SkillDefinition[];
  /** 系统音源库条目（用于 instrument_search）。工程级音源在 project.instruments 中。 */
  instruments?: InstrumentLibrarySummary[];
  /** 当前 Skill 作用域（顶层由 @skill 解析，子 Skill 由 invokeSkill 设置）。 */
  skill?: {
    name: string;
    instructions: string;
    parentSkill?: string;
    depth: number;
    taskContext?: SkillContext;
    /** 当前调用链（用于跨内核环检测）。 */
    visited?: string[];
  };
  /**
   * 离线调试钩子：仅 offline provider 生效，用于脚本化模型回复（测试/复现）。
   */
  offlineScript?: (faux: ReturnType<typeof fauxProvider>) => void;
  /** 实时调用更新回调（工具调用/轮次/Skill 调用），供界面展示请求调用情况。 */
  onLive?: (update: AgentLiveUpdate) => void;
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
  /** 本运行发起的 Skill 嵌套调用轨迹（非 skill 运行为空）。 */
  skillTrace: SkillTraceEntry[];
}

const TOOL_CAPABILITIES = {
  inspect_midi_project: "project.read",
  analyze_midi_project: "project.analyze",
  propose_midi_changes: "changes.propose",
  instrument_search: "instrument.search",
  set_track_instrument: "track.set-instrument",
  list_skills: "skill.read",
  load_skill: "skill.read",
  invoke_skill: "skill.invoke",
} as const;

type PiToolName = keyof typeof TOOL_CAPABILITIES;

const MODE_TOOLS: Readonly<Record<AgentMode, ReadonlySet<PiToolName>>> = {
  research: new Set(["inspect_midi_project", "analyze_midi_project", "instrument_search", "list_skills", "load_skill", "invoke_skill"]),
  plan: new Set(["inspect_midi_project", "analyze_midi_project", "propose_midi_changes", "instrument_search", "set_track_instrument", "list_skills", "load_skill", "invoke_skill"]),
  goal: new Set(["inspect_midi_project", "analyze_midi_project", "propose_midi_changes", "instrument_search", "set_track_instrument", "list_skills", "load_skill", "invoke_skill"]),
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
  // 子 Skill：注入紧凑上下文，不 dump 完整工程；细节由 inspect/analyze 按需读取。
  if (request.skill?.taskContext) {
    return [
      `Current skill task context:\n${JSON.stringify(request.skill.taskContext)}`,
      "Use inspect_midi_project / analyze_midi_project to read the project as needed.",
    ].join("\n\n");
  }
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

function systemPrompt(mode: AgentMode, skill?: NonNullable<PiKernelRequest["skill"]>): string {
  const boundary = mode === "research"
    ? "You are in read-only research mode. Never propose, apply, export, or write changes."
    : mode === "plan"
      ? "You are in plan mode. You may propose validated edits for preview, but never apply, export, or write them."
      : "You are in goal mode. Generate one to three validated candidate change sets, but never apply, export, or write them.";
  const parts = [
    "You are the Pi-powered planning kernel of a game-music MIDI desktop editor.",
    boundary,
    "Use the provided tools instead of inventing track or note identifiers.",
    "Keep MIDI pitch and velocity in 0..127, ticks non-negative, and durations positive.",
    "Finish with a concise Chinese analysis for the user.",
    AGENT_CONTEXT_PROMPT,
  ];
  if (skill) {
    parts.push(
      "",
      `## 当前 Skill：${skill.name}`,
      skill.instructions,
      "",
      "## Skill 委托规则",
      "- 使用 list_skills / load_skill / invoke_skill 进行发现与委托；工具 Schema 权威，不要发明 API。",
      "- 子 Skill 只处理委托的子任务并返回结构化结果；不得直接修改工程，不得输出最终用户长答案。",
      "- 禁止自我调用与循环；默认最大嵌套深度 2、每个父 Skill 最多 4 个子调用。",
      "- 汇总所有子结果后，通过 propose_midi_changes 提交统一候选；冲突由合并引擎裁决，不要自行覆盖。",
    );
  }
  return parts.join("\n\n");
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

/** 判断某轮 assistant 消息是否包含工具调用（用于 skill 作用域的 research 续跑）。 */
function messageHasToolCalls(message: { content?: unknown; stopReason?: string }): boolean {
  if (message.stopReason === "toolUse") return true;
  return Array.isArray(message.content) && message.content.some(
    (block) => block !== null && typeof block === "object" && (block as { type?: string }).type === "toolCall",
  );
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
  skillRuntime: {
    skills: SkillDefinition[];
    state: InvocationState;
    skillResults: SkillInvocationResult[];
    skillTrace: SkillTraceEntry[];
  },
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
      const validated = submitChangeSet(parsed);
      return {
        content: [{ type: "text", text: `Candidate ${validated.id} passed validation and is awaiting user approval.` }],
        details: { candidateId: validated.id, applied: false },
      };
    },
  };

  /** 候选提交公共通道：上限 / id 去重 / 领域校验 / 入列。 */
  const submitChangeSet = (changeSet: ProposedChangeSet): ProposedChangeSet => {
    if (candidates.length >= MAX_CANDIDATES) {
      throw new Error(`A maximum of ${MAX_CANDIDATES} candidates is allowed per run.`);
    }
    if (candidates.some((candidate) => candidate.id === changeSet.id)) {
      throw new Error(`Candidate ID ${changeSet.id} has already been submitted.`);
    }
    const domain = validateChangeSet(request.project, changeSet, {
      maximumOperations: 500,
      maximumAffectedNotes: 10_000,
    });
    if (!domain.valid) {
      throw new Error(domain.issues.map((issue) => issue.message).join(" "));
    }
    const validated: ProposedChangeSet = {
      ...changeSet,
      validation: [...(changeSet.validation ?? []), domain],
      estimatedAffectedNotes: domain.affectedNotes,
    };
    candidates.push(validated);
    return validated;
  };

  const instrumentSearchParameters = Type.Object({
    query: Type.Optional(Type.String()),
    type: Type.Optional(Type.Union([Type.Literal("soundfont"), Type.Literal("sfz")])),
  });
  const instrumentSearch: AgentTool<typeof instrumentSearchParameters> = {
    name: "instrument_search",
    label: "Search instruments",
    description: "Search available instruments (system library + project-bound instruments) by name. Returns id/name/type and SoundFont presets (bank/program) so you can reference them in set_track_instrument.",
    parameters: instrumentSearchParameters,
    execute: async (_id, params) => {
      const query = (params.query ?? "").trim().toLowerCase();
      const projectInstruments = request.project.instruments ?? [];
      const entries: Array<{
        id: string;
        name: string;
        type: "soundfont" | "sfz";
        presets?: Array<{ bank: number; program: number; name: string }>;
      }> = [...(request.instruments ?? []), ...projectInstruments].flatMap((entry) => {
        const type = entry.type;
        const name = entry.name ?? entry.id;
        const presets = type === "soundfont"
          ? (entry.presets ?? []).map((preset) => ({ bank: preset.bank, program: preset.program, name: preset.name }))
          : undefined;
        if (params.type && type !== params.type) return [];
        if (query && !name.toLowerCase().includes(query)
          && !(presets ?? []).some((preset) => preset.name.toLowerCase().includes(query))) return [];
        return [{ id: entry.id, name, type, presets }];
      }).slice(0, 20);
      return {
        content: [{ type: "text", text: JSON.stringify(entries) }],
        details: { readOnly: true },
      };
    },
  };

  const soundfontReferenceSchema = Type.Object({
    type: Type.Literal("soundfont"),
    libraryId: Type.String({ minLength: 1 }),
    bank: Type.Integer({ minimum: 0, maximum: 16_383 }),
    program: Type.Integer({ minimum: 0, maximum: 127 }),
  });
  const sfzReferenceSchema = Type.Object({
    type: Type.Literal("sfz"),
    libraryId: Type.String({ minLength: 1 }),
    presetId: Type.Optional(Type.String()),
  });
  const setInstrumentParameters = Type.Object({
    trackId: Type.String({ minLength: 1 }),
    instrument: Type.Union([soundfontReferenceSchema, sfzReferenceSchema, Type.Null()]),
    summary: Type.Optional(Type.String()),
  });
  const setTrackInstrument: AgentTool<typeof setInstrumentParameters> = {
    name: "set_track_instrument",
    label: "Set track instrument",
    description: "Propose switching a track's instrument to a specific SoundFont preset or SFZ (use instrument_search first). Pass null to clear the instrument. Produces a validated candidate for user confirmation; it never applies directly.",
    parameters: setInstrumentParameters,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const track = request.project.tracks.find((item) => item.id === params.trackId);
      if (!track) throw new Error(`Track ${params.trackId} does not exist.`);
      const changeSet: ProposedChangeSet = {
        id: `set-instrument-${params.trackId}-${Date.now().toString(36)}`,
        summary: params.summary?.trim() || `切换轨道 ${track.name} 的音色`,
        operations: [{ type: "update_track", trackId: params.trackId, changes: { instrument: params.instrument } }],
        validation: [],
        estimatedAffectedNotes: 0,
      };
      const validated = submitChangeSet(changeSet);
      return {
        content: [{ type: "text", text: `Candidate ${validated.id} passed validation and is awaiting user approval.` }],
        details: { candidateId: validated.id, applied: false },
      };
    },
  };
  const base = request.mode === "research"
    ? [inspect, analyze, instrumentSearch]
    : [inspect, analyze, propose, instrumentSearch, setTrackInstrument];
  if (!request.skill) return base;

  const { skills, state, skillResults, skillTrace } = skillRuntime;
  const parentKey = state.parentSkill ?? "__root__";
  const parentChildren = state.childCounts[parentKey] ?? 0;
  const availabilityCurrent = {
    parentSkill: state.parentSkill,
    visited: state.visited,
    depth: state.depth,
    maxDepth: state.maxDepth,
    parentChildren,
    maxChildrenPerParent: state.maxChildrenPerParent,
    totalCalls: state.totalCalls,
    maxTotal: state.maxTotal,
  };

  const skillContextSchema = Type.Object({
    goal: Type.Optional(Type.String()),
    projectId: Type.Optional(Type.String()),
    section: Type.Optional(Type.String()),
    relevantTrackIds: Type.Optional(Type.Array(Type.String())),
    relevantNoteIds: Type.Optional(Type.Array(Type.String())),
    tickRange: Type.Optional(Type.Object({ startTick: Type.Number(), endTick: Type.Number() })),
    meter: Type.Optional(Type.String()),
    tempo: Type.Optional(Type.Number()),
    currentFindings: Type.Optional(Type.Array(Type.String())),
    constraints: Type.Optional(Type.Array(Type.String())),
  });
  const invokeParameters = Type.Object({
    skillName: Type.String({ minLength: 1 }),
    task: Type.String({ minLength: 1 }),
    context: Type.Optional(skillContextSchema),
    constraints: Type.Optional(Type.Array(Type.String())),
  });

  const runKernel: ChildRunKernel = runPiKernel;
  const recordTrace = (entry: SkillTraceEntry) => {
    skillTrace.push(entry);
    request.onLive?.({
      kind: "skill",
      skill: entry.childSkill,
      parentSkill: entry.parentSkill,
      depth: entry.depth,
      status: entry.status,
      durationMs: entry.durationMs,
    });
    console.debug(
      `[skills] ${entry.parentSkill ?? "root"} -> ${entry.childSkill} depth=${entry.depth} ` +
      `${entry.status} ${entry.durationMs}ms ops=${entry.operationCount} notes=${entry.affectedNoteCount}`,
    );
  };

  const listSkillsTool: AgentTool<typeof inspectParameters> = {
    name: "list_skills",
    label: "List skills",
    description: "List available Skills with their canonical name, description, and whether they can be invoked right now.",
    parameters: inspectParameters,
    execute: async () => ({
      content: [{ type: "text", text: JSON.stringify(listSkillAvailability(skills, availabilityCurrent)) }],
      details: { readOnly: true },
    }),
  };
  const loadSkillParameters = Type.Object({ skillName: Type.String({ minLength: 1 }) });
  const loadSkillTool: AgentTool<typeof loadSkillParameters> = {
    name: "load_skill",
    label: "Load skill",
    description: "Load the full SKILL.md instructions of a specific Skill by canonical name.",
    parameters: loadSkillParameters,
    execute: async (_id, params) => {
      const skill = getSkill(skills, params.skillName);
      if (!skill) throw new Error(`未找到 Skill：${params.skillName}`);
      return { content: [{ type: "text", text: skill.instructions }], details: { skill: skill.name } };
    },
  };
  const invokeSkillTool: AgentTool<typeof invokeParameters> = {
    name: "invoke_skill",
    label: "Invoke skill",
    description: "Invoke another Skill as a bounded child task. Returns a structured SkillInvocationResult (skill, summary, operations, affectedTracks, affectedNotes, assumptions, warnings).",
    parameters: invokeParameters,
    executionMode: "sequential",
    execute: async (_id, params) => {
      const result = await invokeSkill({
        skills,
        project: request.project,
        targetSkill: params.skillName,
        task: params.task,
        context: params.context,
        constraints: params.constraints,
        state,
        parent: {
          requestId: request.requestId,
          mode: request.mode,
          apiKey: request.apiKey,
          provider: request.provider,
          credentials: request.credentials,
          customProvider: request.customProvider,
          modelId: request.modelId,
          thinkingLevel: request.thinkingLevel,
          signal: request.signal,
        },
        runKernel,
        recordTrace,
        childTimeoutMs: request.childTimeoutMs,
      });
      skillResults.push(result);
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
  return [...base, listSkillsTool, loadSkillTool, invokeSkillTool];
}

function createOfflineRuntime(request: PiKernelRequest, project: Readonly<MidiProject>) {
  const faux = fauxProvider({ tokensPerSecond: 10_000 });
  const models = createModels();
  models.setProvider(faux.provider);
  const melody = project.tracks.find((track) => track.role === "melody") ?? project.tracks[0];
  const snapshot = analysisSnapshot(project);
  if (request.offlineScript) {
    request.offlineScript(faux);
  } else if (request.mode === "research" || !melody?.notes.length) {
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
  const skillResults: SkillInvocationResult[] = [];
  const skillTrace: SkillTraceEntry[] = [];
  const skills = request.skills ?? [];
  const skillRuntime = {
    skills,
    state: request.skill
      ? {
          depth: request.skill.depth,
          parentSkill: request.skill.name,
          visited: request.skill.visited ?? [request.skill.name],
          maxDepth: DEFAULT_INVOCATION_LIMITS.maxDepth,
          maxChildrenPerParent: DEFAULT_INVOCATION_LIMITS.maxChildrenPerParent,
          maxTotal: DEFAULT_INVOCATION_LIMITS.maxTotal,
          totalCalls: 0,
          childCounts: {},
          signal: request.signal,
        }
      : createInvocationState(request.signal),
    skillResults,
    skillTrace,
  };
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
  // 工具调用统计（用于中止/超时诊断：判断模型是否在循环调用工具而未收敛）。
  const toolCallCounts: Record<string, number> = {};
  const recentToolCalls: string[] = [];
  const recordToolCall = (name: string) => {
    toolCallCounts[name] = (toolCallCounts[name] ?? 0) + 1;
    recentToolCalls.push(name);
    if (recentToolCalls.length > 8) recentToolCalls.shift();
  };
  const agent = new Agent({
    initialState: {
      systemPrompt: systemPrompt(request.mode, request.skill),
      model: runtime.model as Model<any>,
      thinkingLevel: effectiveThinkingLevel,
      tools: createTools(request, candidates, skillRuntime),
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
      request.onLive?.({ kind: "turn", turns });
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
      // research 普通模式每轮即停；skill 作用域允许在还有工具调用时续跑（让父 Skill 能 invoke 后总结）。
      if (request.mode === "research") return !request.skill || !messageHasToolCalls(message);
      return candidates.length > 0 && turns >= 2;
    },
    beforeToolCall: async ({ toolCall }) => {
      const name = toolCall.name as PiToolName;
      recordToolCall(name);
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
    else if (thinkingDelta) {
      request.onLive?.({ kind: "thinking", text: thinkingDelta });
      events.push({ type: "thinking_delta", name: "assistant", text: thinkingDelta });
    }
    else if (event.type === "tool_execution_start") {
      request.onLive?.({ kind: "tool_start", name: event.toolName });
      events.push({ type: "tool_start", name: event.toolName });
    } else if (event.type === "tool_execution_end") {
      request.onLive?.({ kind: "tool_end", name: event.toolName, isError: event.isError });
      events.push({ type: "tool_end", name: event.toolName, isError: event.isError });
    } else events.push({ type: "lifecycle", name: event.type });
  });
  const abortListener = () => agent.abort();
  const startedAt = Date.now();
  request.signal?.addEventListener("abort", abortListener, { once: true });
  // 中止时抛出「原因 + 运行诊断」，让用户/日志能判断是网络卡死还是模型一直在跑。
  const enrichAbortError = (): Error => {
    const base = request.signal?.reason instanceof Error
      ? request.signal.reason
      : new Error("Agent 请求已中止。");
    const toolSummary = Object.keys(toolCallCounts).length > 0
      ? `、工具调用：${Object.entries(toolCallCounts).map(([name, count]) => `${name}×${count}`).join("、")}` +
        (recentToolCalls.length > 0 ? `（最近：${recentToolCalls.join(" → ")}）` : "")
      : "";
    const detail = `已运行 ${Math.round((Date.now() - startedAt) / 1000)}s、${turns} 轮、事件 ${events.length} 条` +
      (skillTrace.length > 0 ? `、Skill 调用 ${skillTrace.length} 次` : "") +
      `、输入 ${inputTokens} / 输出 ${outputTokens} tokens` +
      toolSummary +
      "。";
    const enriched = new Error(`${base.message}（${detail}）`);
    enriched.name = base.name;
    return enriched;
  };
  try {
    await agent.prompt([
      {
        role: "user",
        content: `${request.objective}\n\n${buildProjectContext(request)}`,
        timestamp: Date.now(),
      },
    ]);
  } catch (error) {
    if (request.signal?.aborted) {
      console.warn(`[agent] 已中止，底层错误：${error instanceof Error ? error.message : String(error)}`);
      throw enrichAbortError();
    }
    throw error;
  } finally {
    request.signal?.removeEventListener("abort", abortListener);
  }
  if (request.signal?.aborted) throw enrichAbortError();
  if (agent.state.errorMessage) throw new Error(agent.state.errorMessage);
  // 顶层 Skill 运行：合并全部子 Skill 结果（+ 父自身候选）为一个统一候选。
  if (request.skill && request.skill.depth === 0 && skillResults.length > 0) {
    const inputs: SkillOperationSource[] = skillResults.map((result) => ({
      source: result.skill,
      operations: result.operations,
      warnings: result.warnings,
    }));
    for (const candidate of candidates) {
      inputs.push({ source: request.skill.name, operations: candidate.operations });
    }
    const merged = mergeSkillOperations(inputs, request.project, {
      maximumOperations: 500,
      maximumAffectedNotes: 10_000,
    });
    for (const warning of merged.warnings) {
      events.push({ type: "lifecycle", name: `skill-merge-warning: ${warning}` });
      console.debug(`[skills] 合并警告：${warning}`);
    }
    if (merged.operations.length > 0) {
      const mergedSet: ProposedChangeSet = {
        id: `skill-merge-${request.requestId}`,
        summary: `编排合并候选（${skillResults.length} 个子 Skill）`,
        operations: merged.operations,
      };
      const domain = validateChangeSet(request.project, mergedSet, {
        maximumOperations: 500,
        maximumAffectedNotes: 10_000,
      });
      if (domain.valid) {
        candidates.length = 0;
        candidates.push({ ...mergedSet, validation: [domain], estimatedAffectedNotes: domain.affectedNotes });
      } else {
        events.push({ type: "lifecycle", name: "skill-merge-invalid" });
        console.warn(`[skills] 合并候选未通过领域校验：${domain.issues.map((issue) => issue.message).join(" ")}`);
      }
    }
  }
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
    skillTrace,
  };
}

export { MODE_TOOLS as PI_MODE_TOOLS };

