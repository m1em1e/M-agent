/** 子 Skill 调用的结果状态。 */
export type SkillInvocationStatus = "ok" | "skipped" | "error";

/** 一次子调用的可观测记录。 */
export interface SkillTraceEntry {
  parentSkill?: string;
  childSkill: string;
  depth: number;
  startedAt: number;
  durationMs: number;
  status: SkillInvocationStatus;
  operationCount: number;
  affectedNoteCount: number;
}