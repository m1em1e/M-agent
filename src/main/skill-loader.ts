import { app } from "electron";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidSkillDefinition, parseSkillMarkdown } from "../core/agent/skills/parse.js";
import type { SkillLoader } from "../core/agent/skills/loader.js";
import type { SkillDefinition, SkillMeta } from "../core/agent/skills/types.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

/**
 * Skill 目录（开发态与打包态名称一致，均为 skills）：
 * - 开发态：仓库根 `skills/`（用户可在此自定义 <name>/SKILL.md）。
 * - 打包态：process.resourcesPath/skills（由 electron-builder extraResources 带入）。
 */
export function getSkillsDirectory(): string {
  const isPackaged = typeof app?.isPackaged === "boolean" && app.isPackaged;
  return isPackaged
    ? join(process.resourcesPath, "skills")
    : join(currentDir, "../../skills");
}

/** 确保 Skill 目录存在（供用户添加自定义 Skill）。 */
export async function ensureSkillsDirectory(): Promise<string> {
  const dir = getSkillsDirectory();
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 只读解析单个 Skill 文件；缺失/无效返回 undefined。 */
async function loadSkillFile(dir: string, name: string): Promise<SkillDefinition | undefined> {
  let text: string;
  try {
    text = await readFile(join(dir, name, "SKILL.md"), "utf8");
  } catch {
    return undefined;
  }
  const parsed = parseSkillMarkdown(text);
  if (!isValidSkillDefinition(parsed)) return undefined;
  return parsed;
}

/** 发现层：列出所有 Skill 的 name/description（不含 instructions，progressive disclosure）。 */
export async function listSkillMeta(dir = getSkillsDirectory()): Promise<SkillMeta[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const metas: SkillMeta[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = await loadSkillFile(dir, entry.name);
    if (!skill) continue;
    if (metas.some((meta) => meta.name === skill.name)) continue;
    metas.push({ name: skill.name, description: skill.description });
  }
  return metas;
}

/** 按需加载单个 Skill 的完整定义（含 instructions）。 */
export async function loadSkillInstructions(name: string, dir = getSkillsDirectory()): Promise<SkillDefinition | undefined> {
  return loadSkillFile(dir, name);
}

/** 主进程 SkillLoader 实现（含同运行内存缓存）。 */
export function createSkillLoader(): SkillLoader {
  const dir = getSkillsDirectory();
  const cache = new Map<string, SkillDefinition | undefined>();
  return {
    list: () => listSkillMeta(dir),
    load: async (name) => {
      if (cache.has(name)) return cache.get(name);
      const skill = await loadSkillInstructions(name, dir);
      cache.set(name, skill);
      return skill;
    },
  };
}

/** 兼容旧调用：加载目录下全部完整 Skill（已弃用，仅保留测试用；正式路径用 createSkillLoader）。 */
export async function loadSkillsFromDirectory(dir: string): Promise<SkillDefinition[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: SkillDefinition[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skill = await loadSkillFile(dir, entry.name);
    if (!skill) continue;
    if (skills.some((existing) => existing.name === skill.name)) continue;
    skills.push(skill);
  }
  return skills;
}
