import { describe, expect, it } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSfz } from "../../src/main/soundfont-parser";

describe("parseSfz include", () => {
  it("递归加载 <include> 子文件并合并 regions，防循环", async () => {
    const dir = await mkdtemp(join(tmpdir(), "magent-sfz-test-"));
    const subDir = join(dir, "sub");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(subDir, { recursive: true });
    // 主文件 include 一个子文件（子文件再 include 回主文件验证防循环）。
    await writeFile(join(dir, "main.sfz"), [
      "<include>sub/a.sfz</include>",
      "<include>loop.sfz</include>",
      "<region> sample=main.wav key=60",
    ].join("\n"), "utf8");
    await writeFile(join(dir, "sub", "a.sfz"), [
      "<include>../main.sfz</include>",
      "<region> sample=sub.wav key=64",
    ].join("\n"), "utf8");
    await writeFile(join(dir, "loop.sfz"), "<region> sample=loop.wav key=67", "utf8");

    const result = await parseSfz(join(dir, "main.sfz"));
    const samples = result.regions.map((region) => region.samplePath.replace(/\\/g, "/").split("/").pop());
    expect(samples).toEqual(["main.wav", "sub.wav", "loop.wav"]);
    // files 应包含主文件与全部 include 链。
    expect(result.files.map((file) => file.replace(/\\/g, "/"))).toEqual([
      join(dir, "main.sfz").replace(/\\/g, "/"),
      join(dir, "sub", "a.sfz").replace(/\\/g, "/"),
      join(dir, "loop.sfz").replace(/\\/g, "/"),
    ]);
  });
});