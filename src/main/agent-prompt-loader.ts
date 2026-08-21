import { app } from "electron";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));

/**
 * Agent 提示词目录（开发态与打包态名称一致，均为 agent）：
 * - 开发态：仓库根 `agent/`（用户可在此自定义 context-prompt.md）。
 * - 打包态：process.resourcesPath/agent（由 electron-builder extraResources 带入）。
 */
export function getAgentPromptDirectory(): string {
  const isPackaged = typeof app?.isPackaged === "boolean" && app.isPackaged;
  return isPackaged
    ? join(process.resourcesPath, "agent")
    : join(currentDir, "../../agent");
}

/** 读取对话注入用上下文提示词；文件缺失返回 null（调用方回退极简兜底）。 */
export async function loadContextPrompt(dir = getAgentPromptDirectory()): Promise<string | null> {
  try {
    const text = await readFile(join(dir, "context-prompt.md"), "utf8");
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}
