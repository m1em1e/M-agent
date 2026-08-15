import { describe, expect, it } from "vitest";
import { isValidSkillDefinition, parseSkillMarkdown } from "../../../src/core/agent/skills/parse";

describe("parseSkillMarkdown", () => {
  it("解析 frontmatter 的 name/description 与正文", () => {
    const parsed = parseSkillMarkdown(`---
name: song-arranger
description: Orchestrate whole-song MIDI arrangements.
---
# Song Arranger

You are the top-level orchestrator.
`);
    expect(parsed.name).toBe("song-arranger");
    expect(parsed.description).toBe("Orchestrate whole-song MIDI arrangements.");
    expect(parsed.instructions).toContain("top-level orchestrator");
    expect(isValidSkillDefinition(parsed)).toBe(true);
  });

  it("无 frontmatter 时从首个 # 标题取 name，正文照常", () => {
    const parsed = parseSkillMarkdown("# Bass Arranger\n\nHandle bass lines.\n");
    expect(parsed.name).toBe("Bass Arranger");
    expect(parsed.description).toBe("Bass Arranger");
    expect(parsed.instructions).toContain("Handle bass lines");
  });

  it("空内容判定为无效", () => {
    expect(isValidSkillDefinition({ name: "", description: "", instructions: "" })).toBe(false);
    expect(isValidSkillDefinition({ name: "x", description: "x", instructions: "   " })).toBe(false);
  });
});
