import type { SkillDefinition } from "./types.js";

/** 解析 SKILL.md 文本：提取 frontmatter 的 name/description，instructions 为正文。 */
export function parseSkillMarkdown(text: string): Omit<SkillDefinition, "instructions"> & { instructions?: string } {
  const body = text.replace(/^\uFEFF/, "");
  const match = body.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    const name = body.split(/\r?\n/, 1)[0]?.replace(/^#\s*/, "").trim();
    return name ? { name, description: name, instructions: body.trim() } : { name: "", description: "", instructions: body.trim() };
  }
  const front = match[1];
  const name = /^\s*name\s*:\s*["']?([^\s"']+)["']?\s*$/m.exec(front)?.[1]?.trim();
  const description = /^\s*description\s*:\s*["']?([^"'\r\n]+)["']?\s*$/m.exec(front)?.[1]?.trim();
  const instructions = body.slice(match[0].length).trim();
  return {
    name: name ?? "",
    description: description ?? "",
    instructions,
  };
}

/** 校验解析结果：name 与正文都非空才算有效 Skill。 */
export function isValidSkillDefinition(parsed: Omit<SkillDefinition, "instructions"> & { instructions?: string }): parsed is SkillDefinition {
  return Boolean(parsed.name.trim()) && Boolean(parsed.instructions?.trim());
}
