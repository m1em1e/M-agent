import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectInstrumentFiles, stableId } from "../../src/main/audio/system-scan";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "magent-scan-"));
}

describe("collectInstrumentFiles", () => {
  it("递归收集音源文件并忽略非音源文件", async () => {
    const dir = await tempDir();
    try {
      await mkdir(join(dir, "samples"), { recursive: true });
      await writeFile(join(dir, "a.sf2"), "x");
      await writeFile(join(dir, "samples", "b.sfz"), "x");
      await writeFile(join(dir, "samples", "note.wav"), "x");
      await writeFile(join(dir, "readme.txt"), "x");
      const files = await collectInstrumentFiles(dir);
      const relative = files.map((file) => file.slice(dir.length + 1)).sort();
      expect(relative).toEqual(["a.sf2", join("samples", "b.sfz").replace(/\\/g, "/")]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("目录不存在时返回空数组", async () => {
    expect(await collectInstrumentFiles(join(tmpdir(), "magent-missing-" + Date.now()))).toEqual([]);
  });
});

describe("stableId", () => {
  it("相同路径生成稳定 id 且带 lib- 前缀", () => {
    const path = "/banks/Piano.sf2";
    expect(stableId(path)).toBe(stableId(path));
    expect(stableId(path)).toMatch(/^lib-/);
    expect(stableId(path)).not.toBe(stableId("/banks/Other.sf2"));
  });
});
