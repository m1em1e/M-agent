import type { SkillMeta } from "./types.js";

export interface SkillAvailability {
  name: string;
  description: string;
  /** 当前运行（模式/深度/环）下是否可调用。 */
  available: boolean;
}

export function listSkills(skills: SkillMeta[]): Array<{ name: string; description: string }> {
  return skills.map((skill) => ({ name: skill.name, description: skill.description }));
}

export function hasSkill(skills: SkillMeta[], name: string): boolean {
  return skills.some((skill) => skill.name === name);
}

/** 解析目标是否在当前状态（self/环/深度/上限）下可调用；返回不可用原因。 */
export function skillAvailabilityReason(
  skills: SkillMeta[],
  name: string,
  current: { parentSkill?: string; visited: string[]; depth: number; maxDepth: number; parentChildren: number; maxChildrenPerParent: number; totalCalls: number; maxTotal: number },
): string | null {
  if (!hasSkill(skills, name)) return "unknown-skill";
  if (name === current.parentSkill) return "self-invocation";
  if (current.visited.includes(name)) return "cycle";
  if (current.depth >= current.maxDepth) return "max-depth";
  if (current.parentChildren >= current.maxChildrenPerParent) return "max-children";
  if (current.totalCalls >= current.maxTotal) return "max-total";
  return null;
}

export function listSkillAvailability(
  skills: SkillMeta[],
  current: { parentSkill?: string; visited: string[]; depth: number; maxDepth: number; parentChildren: number; maxChildrenPerParent: number; totalCalls: number; maxTotal: number },
): SkillAvailability[] {
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    available: skillAvailabilityReason(skills, skill.name, current) === null,
  }));
}
