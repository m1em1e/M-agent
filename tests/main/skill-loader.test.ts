import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromDirectory } from "../../src/main/skill-loader";

async function tempSkillsDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "magent-skills-"));
}

describe("loadSkillsFromDirectory", () => {
  it("扫描 <dir>/*/SKILL.md 并解析 frontmatter", async () => {
    const dir = await tempSkillsDir();
    try {
      await mkdir(join(dir, "song-arranger"), { recursive: true });
      await writeFile(join(dir, "song-arranger", "SKILL.md"), `---
name: song-arranger
description: Orchestrate whole-song arrangements.
---
# Song Arranger
You are the orchestrator.
`);
      await mkdir(join(dir, "harmony-arranger"), { recursive: true });
      await writeFile(join(dir, "harmony-arranger", "SKILL.md"), `---
name: harmony-arranger
description: Harmony specialist.
---
# Harmony
Work on harmony.
`);
      const skills = await loadSkillsFromDirectory(dir);
      expect(skills.map((skill) => skill.name).sort()).toEqual(["harmony-arranger", "song-arranger"]);
      expect(skills.find((skill) => skill.name === "song-arranger")?.instructions).toContain("orchestrator");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("跳过无效与重复项", async () => {
    const dir = await tempSkillsDir();
    try {
      await mkdir(join(dir, "valid"), { recursive: true });
      await writeFile(join(dir, "valid", "SKILL.md"), "---\nname: good\n---\n\nbody");
      await mkdir(join(dir, "broken"), { recursive: true });
      await writeFile(join(dir, "broken", "SKILL.md"), "");
      await mkdir(join(dir, "dup"), { recursive: true });
      await writeFile(join(dir, "dup", "SKILL.md"), "---\nname: good\ndescription: x\n---\n\nother");
      const skills = await loadSkillsFromDirectory(dir);
      expect(skills).toHaveLength(1);
      expect(skills[0].name).toBe("good");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("目录不存在返回空数组", async () => {
    expect(await loadSkillsFromDirectory(join(tmpdir(), "magent-missing-" + Date.now()))).toEqual([]);
  });
});
