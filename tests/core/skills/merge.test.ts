import { describe, expect, it } from "vitest";
import { mergeSkillOperations } from "../../../src/core/agent/skills/merge";
import type { MidiEditOperation } from "../../../src/shared/midi";

const source = (name: string, operations: MidiEditOperation[]) => ({ source: name, operations });

describe("mergeSkillOperations", () => {
  it("非冲突操作可合并", () => {
    const result = mergeSkillOperations([
      source("harmony-arranger", [{ type: "update_notes", trackId: "t1", changes: [{ noteId: "n1", velocity: 100 }] }]),
      source("rhythm-arranger", [{ type: "insert_notes", trackId: "t2", notes: [{ id: "n9", pitch: 60, startTick: 0, durationTicks: 240, velocity: 90 }] }]),
    ]);
    expect(result.operations).toHaveLength(2);
    expect(result.warnings).toEqual([]);
  });

  it("同 noteId 的 update/delete 冲突只保留先到者", () => {
    const result = mergeSkillOperations([
      source("a", [{ type: "update_notes", trackId: "t1", changes: [{ noteId: "n1", velocity: 100 }] }]),
      source("b", [{ type: "delete_notes", trackId: "t1", noteIds: ["n1"] }]),
    ]);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].type).toBe("update_notes");
    expect(result.warnings.some((warning) => warning.includes("n1"))).toBe(true);
  });

  it("同位置重复 insert 保留先到者", () => {
    const result = mergeSkillOperations([
      source("a", [{ type: "insert_notes", trackId: "t1", notes: [{ id: "n1", pitch: 60, startTick: 480, durationTicks: 240, velocity: 90 }] }]),
      source("b", [{ type: "insert_notes", trackId: "t1", notes: [{ id: "n2", pitch: 60, startTick: 480, durationTicks: 240, velocity: 90 }] }]),
    ]);
    expect(result.operations[0].type).toBe("insert_notes");
    expect((result.operations[0] as { notes: unknown[] }).notes).toHaveLength(1);
    expect(result.warnings.some((warning) => warning.includes("重复"))).toBe(true);
  });

  it("track 删除会移除该轨道的音符操作", () => {
    const result = mergeSkillOperations([
      source("a", [{ type: "update_notes", trackId: "t1", changes: [{ noteId: "n1", velocity: 90 }] }]),
      source("b", [{ type: "delete_track", trackId: "t1" }]),
    ]);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].type).toBe("delete_track");
    expect(result.warnings.some((warning) => warning.includes("移除"))).toBe(true);
  });

  it("track 删除后针对该轨道的音符操作被忽略", () => {
    const result = mergeSkillOperations([
      source("a", [{ type: "delete_track", trackId: "t1" }]),
      source("b", [{ type: "insert_notes", trackId: "t1", notes: [{ id: "n5", pitch: 60, startTick: 0, durationTicks: 240, velocity: 90 }] }]),
    ]);
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0].type).toBe("delete_track");
  });

  it("重复 set_tempo 保留先到者", () => {
    const result = mergeSkillOperations([
      source("a", [{ type: "set_tempo", tick: 0, bpm: 120 }]),
      source("b", [{ type: "set_tempo", tick: 0, bpm: 140 }]),
    ]);
    expect(result.operations).toHaveLength(1);
    expect((result.operations[0] as { bpm: number }).bpm).toBe(120);
  });

  it("重叠 set_loop 被拒绝并告警", () => {
    const result = mergeSkillOperations([
      source("a", [{ type: "set_loop", startTick: 0, endTick: 960 }]),
      source("b", [{ type: "set_loop", startTick: 480, endTick: 1440 }]),
    ]);
    expect(result.operations).toHaveLength(1);
    expect(result.warnings.some((warning) => warning.includes("重叠"))).toBe(true);
  });

  it("超过操作数上限时截断并告警", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ type: "set_tempo", tick: i, bpm: 100 })) as MidiEditOperation[];
    const result = mergeSkillOperations([source("a", many)], undefined, { maximumOperations: 5 });
    expect(result.operations).toHaveLength(5);
    expect(result.warnings.some((warning) => warning.includes("上限"))).toBe(true);
  });

  it("受影响音符超限时告警", () => {
    const result = mergeSkillOperations(
      [source("a", [{ type: "insert_notes", trackId: "t1", notes: Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, pitch: 60, startTick: i, durationTicks: 1, velocity: 90 })) }])],
      undefined,
      { maximumAffectedNotes: 10 },
    );
    expect(result.affectedNotes).toBe(12);
    expect(result.warnings.some((warning) => warning.includes("受影响"))).toBe(true);
  });
});
