import type { SkillDefinition, SkillMeta } from "./types.js";

/**
 * Skill 按需加载接口（progressive disclosure）。
 * 主进程实现文件系统读取；core 只依赖该接口，保持纯逻辑可测。
 * list 只返回 name/description（不常驻 instructions），load 按需取完整 SKILL.md。
 */
export interface SkillLoader {
  /** 所有 Skill 的名称与描述（发现层）。 */
  list(): Promise<SkillMeta[]>;
  /** 按需加载单个 Skill 的完整定义（含 instructions）。不存在返回 undefined。 */
  load(name: string): Promise<SkillDefinition | undefined>;
}

/** 同一顶层运行内避免重复读取：简单内存缓存，运行结束自然丢弃，不做永久缓存。 */
export function withCachedLoader(loader: SkillLoader): SkillLoader {
  const cache = new Map<string, SkillDefinition | undefined>();
  return {
    list: () => loader.list(),
    load: async (name) => {
      if (cache.has(name)) return cache.get(name);
      const skill = await loader.load(name);
      cache.set(name, skill);
      return skill;
    },
  };
}
