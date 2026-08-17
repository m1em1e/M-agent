import { mkdir, appendFile, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentLogEvent, AgentLogSink } from "../shared/agent-log.js";

const currentDir = dirname(fileURLToPath(import.meta.url));

/**
 * Agent 调试日志：仅测试环境（npm run dev，即 VITE_DEV_SERVER_URL 已设）生效，
 * 把所有 agent 请求/返回/思考/结果以 JSON-lines 追加写入 `log/log-yyyy-MM-dd HH-mm-ss.log`。
 * 非测试环境返回 no-op，零开销。
 *
 * @param logBaseDir 日志根目录（默认仓库根）；测试可传临时目录。
 */
export function createAgentLogSink(logBaseDir?: string): AgentLogSink {
  if (!process.env.VITE_DEV_SERVER_URL) return () => undefined;

  let filePath: string | null = null;
  let queue: Promise<void> = Promise.resolve();

  const ensureFile = async (): Promise<string> => {
    if (filePath) return filePath;
    // 开发态 src/main -> 仓库根；日志放 <root>/log/ 下。
    const base = logBaseDir ?? join(currentDir, "../..");
    const logDir = join(base, "log");
    await mkdir(logDir, { recursive: true });
    const now = new Date();
    const pad = (value: number) => String(value).padStart(2, "0");
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
      `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    filePath = join(logDir, `log-${stamp}.log`);
    return filePath;
  };

  return (event: AgentLogEvent) => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`;
    queue = queue.then(async () => {
      try {
        const path = await ensureFile();
        await appendFile(path, line, "utf8");
      } catch (error) {
        console.warn(`[agent-log] 写入失败：${error instanceof Error ? error.message : String(error)}`);
      }
    });
  };
}

/** 读取 <base>/log/ 下的全部日志行（供测试/校验）。目录或文件不存在时返回空数组。 */
export async function readAgentLogLines(base: string): Promise<Array<Record<string, unknown>>> {
  const logDir = join(base, "log");
  let files;
  try {
    files = await readdir(logDir);
  } catch {
    return [];
  }
  const newest = files
    .filter((name) => name.startsWith("log-") && name.endsWith(".log"))
    .sort()
    .at(-1);
  if (!newest) return [];
  const raw = await readFile(join(logDir, newest), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}
