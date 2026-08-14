import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { inferInstrumentTypeFromPath } from "../../shared/instrument.js";

/** 递归收集目录下所有 .sf2/.sf3/.sfz 文件（不解析，只收集路径）。 */
export async function collectInstrumentFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && inferInstrumentTypeFromPath(full)) results.push(full);
    }
  }
  return results;
}

/** 路径 → 稳定 id（保证跨扫描一致，轨道引用不失效）。 */
export function stableId(path: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < path.length; index += 1) {
    hash ^= path.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `lib-${(hash >>> 0).toString(36)}`;
}
