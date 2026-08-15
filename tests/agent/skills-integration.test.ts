import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createMidiProject, createMidiTrack } from "../../src/core/midi";
import { runPiKernel } from "../../src/core/agent/pi-kernel";
import type { SkillDefinition } from "../../src/core/agent/skills/types";

const skills: SkillDefinition[] = [
  { name: "song-arranger", description: "顶层编排", instructions: "song instructions" },
  { name: "harmony-arranger", description: "和声", instructions: "harmony instructions" },
  { name: "rhythm-arranger", description: "节奏", instructions: "rhythm instructions" },
  { name: "bass-arranger", description: "低音", instructions: "bass instructions" },
];

function project() {
  const value = createMidiProject({ id: "p1", title: "JRPG Battle", ppq: 480, bpm: 140 });
  value.tracks.push(createMidiTrack({
    id: "melody",
    name: "Melody",
    role: "melody",
    channel: 0,
    program: 1,
    notes: [
      { id: "n1", pitch: 64, startTick: 0, durationTicks: 480, velocity: 90 },
      { id: "n2", pitch: 67, startTick: 480, durationTicks: 480, velocity: 88 },
      { id: "n3", pitch: 71, startTick: 960, durationTicks: 480, velocity: 86 },
      { id: "n4", pitch: 76, startTick: 1440, durationTicks: 480, velocity: 84 },
    ],
  }));
  value.tracks.push(createMidiTrack({
    id: "drums",
    name: "Drums",
    role: "drums",
    channel: 9,
    program: 0,
    notes: [{ id: "d1", pitch: 36, startTick: 0, durationTicks: 240, velocity: 100 }],
  }));
  return value;
}

describe("Skill 嵌套调用集成（真实 tool loop + 递归内核）", () => {
  it("@song-arranger → harmony-arranger → 合并统一候选", async () => {
    const result = await runPiKernel({
      requestId: "song-1",
      mode: "goal",
      objective: "把这段改成 JRPG 战斗音乐",
      project: project(),
      skills,
      skill: { name: "song-arranger", instructions: skills[0].instructions, depth: 0 },
      offlineScript: (faux) => faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("invoke_skill", { skillName: "harmony-arranger", task: "分析和声走向并给建议", context: { goal: "JRPG 战斗" } })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(
          [fauxToolCall("propose_midi_changes", {
            changeSet: {
              id: "parent-1",
              summary: "鼓组加花",
              operations: [{ type: "insert_notes", trackId: "drums", notes: [{ id: "d2", pitch: 38, startTick: 240, durationTicks: 120, velocity: 100 }] }],
              validation: [],
              estimatedAffectedNotes: 1,
            },
          })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(fauxText("已综合各 specialist 结果，生成统一候选。")),
      ]),
    });

    expect(result.provider).toBe("pi-offline");
    // 子 Skill（harmony）以真实递归内核运行并返回一个候选操作
    expect(result.skillTrace).toHaveLength(1);
    expect(result.skillTrace[0].childSkill).toBe("harmony-arranger");
    expect(result.skillTrace[0].status).toBe("ok");
    expect(result.skillTrace[0].depth).toBe(1);
    // 顶层合并成一个统一候选
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].id).toMatch(/^skill-merge-/);
    const types = result.candidates[0].operations.map((op) => op.type).sort();
    expect(types).toEqual(["insert_notes", "update_notes"]);
  });

  it("子 Skill 继承 goal 模式：其候选只作为结构化结果返回，不写工程", async () => {
    const result = await runPiKernel({
      requestId: "song-2",
      mode: "goal",
      objective: "编曲",
      project: project(),
      skills,
      skill: { name: "song-arranger", instructions: skills[0].instructions, depth: 0 },
      offlineScript: (faux) => faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("invoke_skill", { skillName: "harmony-arranger", task: "修和声" })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(fauxText("完成编排。")),
      ]),
    });
    // 父 Skill 未 propose，但子结果仍合并为统一候选
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].id).toMatch(/^skill-merge-/);
    expect(result.candidates[0].operations[0].type).toBe("update_notes");
  });
});
