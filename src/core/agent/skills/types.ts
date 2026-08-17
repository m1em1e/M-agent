import type { MidiEditOperation } from "../../../shared/midi.js";

/** 运行时加载的一个 Skill 定义（frontmatter name/description + SKILL.md 正文）。 */
export interface SkillDefinition {
  /** canonical 名称，如 song-arranger。 */
  name: string;
  /** 一句话说明，用于 list_skills 发现。 */
  description: string;
  /** SKILL.md 正文（含委托规则与工作流）。 */
  instructions: string;
}

/** 发现层元信息：只含 name/description，不含 instructions（progressive disclosure）。 */
export interface SkillMeta {
  name: string;
  description: string;
}

/** 传给子 Skill 的紧凑上下文，不包含完整工程。 */
export interface SkillContext {
  goal?: string;
  projectId?: string;
  section?: string;
  relevantTrackIds?: string[];
  relevantNoteIds?: string[];
  tickRange?: { startTick: number; endTick: number };
  meter?: string;
  tempo?: number;
  currentFindings?: string[];
  constraints?: string[];
}

/** 子 Skill 的结构化返回（与 SKILL.md 子结果契约一致）。 */
export interface SkillInvocationResult {
  skill: string;
  summary: string;
  operations: MidiEditOperation[];
  affectedTracks: string[];
  affectedNotes: string[];
  assumptions: string[];
  warnings: string[];
  depth: number;
  status: "ok" | "skipped" | "error";
  error?: string;
}

/** 一次子调用的可观测记录。 */
export interface SkillTraceEntry {
  parentSkill?: string;
  childSkill: string;
  depth: number;
  startedAt: number;
  durationMs: number;
  status: SkillInvocationResult["status"];
  operationCount: number;
  affectedNoteCount: number;
}

/** 嵌套调用的防失控状态（深度优先、逐次传递、共享 childCounts 与 totalCalls）。 */
export interface InvocationState {
  /** 当前 Skill 的嵌套深度（顶层 0）。 */
  depth: number;
  /** 正在执行的 Skill 名（用于禁止 self-invocation）。 */
  parentSkill?: string;
  /** 当前调用链（用于禁止 A→B→A 环）。 */
  visited: string[];
  maxDepth: number;
  maxChildrenPerParent: number;
  maxTotal: number;
  /** 本顶层运行已发起的子调用总数。 */
  totalCalls: number;
  /** 每个父 Skill 已发起的子调用计数。 */
  childCounts: Record<string, number>;
  signal?: AbortSignal;
}

export const DEFAULT_INVOCATION_LIMITS = {
  /** 委托深度：顶层 0，child 为 1，禁止更深（child 是 leaf）。 */
  maxDepth: 1,
  /** 每个父 Skill 最多 2 个子调用。 */
  maxChildrenPerParent: 2,
  /** 单次顶层运行子调用总量兜底。 */
  maxTotal: 4,
} as const;

export function createInvocationState(signal?: AbortSignal): InvocationState {
  return {
    depth: 0,
    visited: [],
    maxDepth: DEFAULT_INVOCATION_LIMITS.maxDepth,
    maxChildrenPerParent: DEFAULT_INVOCATION_LIMITS.maxChildrenPerParent,
    maxTotal: DEFAULT_INVOCATION_LIMITS.maxTotal,
    totalCalls: 0,
    childCounts: {},
    signal,
  };
}
