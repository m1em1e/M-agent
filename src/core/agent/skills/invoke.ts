import type { MidiProject, ProposedChangeSet } from "../../../shared/midi.js";
import type { CredentialStore } from "@earendil-works/pi-ai";
import type { PiThinkingLevel } from "../../../shared/conversation-settings.js";
import { getSkill, skillAvailabilityReason } from "./registry.js";
import type {
  InvocationState,
  SkillContext,
  SkillDefinition,
  SkillInvocationResult,
  SkillTraceEntry,
} from "./types.js";
import type { PiCustomProviderConfig } from "../pi-kernel.js";

/** 子 Skill 内核请求（结构化兼容 pi-kernel 的 PiKernelRequest）。 */
export interface ChildKernelRequest {
  requestId: string;
  mode: "research" | "plan" | "goal";
  objective: string;
  project: MidiProject;
  apiKey?: string | null;
  provider?: "openai" | "openai-codex" | "custom";
  credentials?: CredentialStore;
  customProvider?: PiCustomProviderConfig;
  modelId?: string;
  thinkingLevel?: PiThinkingLevel;
  skills?: SkillDefinition[];
  skill?: {
    name: string;
    instructions: string;
    parentSkill?: string;
    depth: number;
    taskContext?: SkillContext;
    visited?: string[];
  };
  signal?: AbortSignal;
}

export interface ChildKernelResult {
  analysis: string;
  candidates: ProposedChangeSet[];
}

export type ChildRunKernel = (request: ChildKernelRequest) => Promise<ChildKernelResult>;

export interface InvokeSkillOptions {
  skills: SkillDefinition[];
  project: MidiProject;
  targetSkill: string;
  task: string;
  context?: SkillContext;
  constraints?: string[];
  state: InvocationState;
  parent: {
    requestId: string;
    mode: ChildKernelRequest["mode"];
    apiKey?: string | null;
    provider?: ChildKernelRequest["provider"];
    credentials?: CredentialStore;
    customProvider?: PiCustomProviderConfig;
    modelId?: string;
    thinkingLevel?: PiThinkingLevel;
    signal?: AbortSignal;
  };
  runKernel: ChildRunKernel;
  /** 子 Skill 运行超时（毫秒）。留空表示不限时。 */
  childTimeoutMs?: number;
  recordTrace: (entry: SkillTraceEntry) => void;
}

/**
 * 调用一个子 Skill：守卫（self / 环 / 深度 / 子调用上限 / 全局预算 / abort）→
 * 以父 mode 递归运行子内核（SKILL.md 注入 + 紧凑上下文）→ 收拢为结构化结果。
 * 子 Skill 失败不会抛出：以 status "error" 返回，由父 Skill 决定 fallback。
 */
export async function invokeSkill(options: InvokeSkillOptions): Promise<SkillInvocationResult> {
  const startedAt = Date.now();
  const { targetSkill, state } = options;
  const parentKey = state.parentSkill ?? "__root__";
  const parentChildren = state.childCounts[parentKey] ?? 0;
  const childDepth = state.depth + 1;

  const failure = (message: string): SkillInvocationResult => ({
    skill: targetSkill,
    summary: "",
    operations: [],
    affectedTracks: [],
    affectedNotes: [],
    assumptions: [],
    warnings: [message],
    depth: childDepth,
    status: "error",
    error: message,
  });

  const reason = skillAvailabilityReason(options.skills, targetSkill, {
    parentSkill: state.parentSkill,
    visited: state.visited,
    depth: state.depth,
    maxDepth: state.maxDepth,
    parentChildren,
    maxChildrenPerParent: state.maxChildrenPerParent,
    totalCalls: state.totalCalls,
    maxTotal: state.maxTotal,
  });
  if (reason) return finishTrace(options, startedAt, failure(`无法调用 ${targetSkill}：${reason}`));

  state.childCounts[parentKey] = parentChildren + 1;
  state.totalCalls += 1;

  const skill = getSkill(options.skills, targetSkill);
  if (!skill) return finishTrace(options, startedAt, failure(`未找到 Skill：${targetSkill}`));

  const childRequest: ChildKernelRequest = {
    requestId: `${options.parent.requestId}-skill-${targetSkill}-${childDepth}`,
    mode: options.parent.mode,
    objective: options.task,
    project: options.project,
    apiKey: options.parent.apiKey,
    provider: options.parent.provider,
    credentials: options.parent.credentials,
    customProvider: options.parent.customProvider,
    modelId: options.parent.modelId,
    thinkingLevel: options.parent.thinkingLevel,
    skills: options.skills,
    skill: {
      name: targetSkill,
      instructions: skill.instructions,
      parentSkill: state.parentSkill,
      depth: childDepth,
      taskContext: options.context,
    },
    // 子 Skill 独立超时作为兜底（父级取消会经 parent.signal 一并中止）。
    // 留空（childTimeoutMs 未设置）表示不限时，仅由父级取消/预算控制。
    signal: options.childTimeoutMs !== undefined
      ? combineSignals(options.childTimeoutMs, options.parent.signal)
      : options.parent.signal,
  };

  try {
    const childResult = await options.runKernel(childRequest);
    const operations = childResult.candidates.flatMap((candidate) => candidate.operations);
    const affectedTracks = [...new Set(operations.flatMap((op) =>
      "trackId" in op && typeof op.trackId === "string" ? [op.trackId] : []))];
    const affectedNoteIds = [...new Set(operations.flatMap((op) => {
      if (op.type === "delete_notes") return op.noteIds;
      if (op.type === "update_notes") return op.changes.map((change) => change.noteId).filter(Boolean) as string[];
      return [];
    }))];
    const result: SkillInvocationResult = {
      skill: targetSkill,
      summary: childResult.analysis,
      operations,
      affectedTracks,
      affectedNotes: affectedNoteIds,
      assumptions: [],
      warnings: [],
      depth: childDepth,
      status: "ok",
    };
    return finishTrace(options, startedAt, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return finishTrace(options, startedAt, failure(`子 Skill ${targetSkill} 运行失败：${message}`));
  }
}

function finishTrace(
  options: InvokeSkillOptions,
  startedAt: number,
  result: SkillInvocationResult,
): SkillInvocationResult {
  options.recordTrace({
    parentSkill: options.state.parentSkill,
    childSkill: result.skill,
    depth: result.depth,
    startedAt,
    durationMs: Date.now() - startedAt,
    status: result.status,
    operationCount: result.operations.length,
    affectedNoteCount: result.affectedNotes.length,
  });
  return result;
}

function combineSignals(timeoutMs: number, parent?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return parent ? AbortSignal.any([parent, timeout]) : timeout;
}
