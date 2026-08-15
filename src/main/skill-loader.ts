import { app } from "electron";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isValidSkillDefinition, parseSkillMarkdown } from "../core/agent/skills/parse.js";
import type { SkillDefinition } from "../core/agent/skills/types.js";

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

/** 扫描目录下所有 <name>/SKILL.md，解析 frontmatter；无效/重复项跳过并警告。 */
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
    let text: string;
    try {
      text = await readFile(join(dir, entry.name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    const parsed = parseSkillMarkdown(text);
    if (!isValidSkillDefinition(parsed)) {
      console.warn(`[skills] 跳过无效 Skill：${entry.name}`);
      continue;
    }
    if (skills.some((skill) => skill.name === parsed.name)) {
      console.warn(`[skills] 跳过重复 Skill：${parsed.name}`);
      continue;
    }
    skills.push(parsed);
  }
  return skills;
}

/** 当前生效的 Skill 列表（目录缺失返回空数组）。 */
export async function loadAvailableSkills(): Promise<SkillDefinition[]> {
  return loadSkillsFromDirectory(getSkillsDirectory());
}
