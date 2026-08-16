import { describe, expect, it } from "vitest";
import { createMidiProject } from "../../../src/core/midi";
import { invokeSkill, type ChildKernelRequest, type ChildKernelResult } from "../../../src/core/agent/skills/invoke";
import { createInvocationState, type InvocationState, type SkillDefinition, type SkillTraceEntry } from "../../../src/core/agent/skills/types";

const skills: SkillDefinition[] = [
  { name: "song-arranger", description: "orchestrator", instructions: "top" },
  { name: "harmony-arranger", description: "harmony", instructions: "harmony" },
  { name: "melody-arranger", description: "melody", instructions: "melody" },
  { name: "bass-arranger", description: "bass", instructions: "bass" },
];

const project = createMidiProject({ id: "p1", title: "Loop", ppq: 480, bpm: 100 });

function cannedRun(): (request: ChildKernelRequest) => Promise<ChildKernelResult> {
  return async () => ({
    analysis: "子任务分析",
    candidates: [{
      id: "c1",
      summary: "s",
      operations: [{ type: "update_notes", trackId: "melody", changes: [{ noteId: "n1", velocity: 100 }] }],
      validation: [],
      estimatedAffectedNotes: 1,
    }],
  });
}

async function call(state: InvocationState, targetSkill: string, runKernel = cannedRun()) {
  const traces: SkillTraceEntry[] = [];
  return invokeSkill({
    skills,
    project,
    targetSkill,
    task: "子任务",
    context: { goal: "测试" },
    state,
    parent: { requestId: "r1", mode: "goal" },
    runKernel,
    childTimeoutMs: 5_000,
    recordTrace: (entry) => traces.push(entry),
  });
}

describe("invokeSkill guards", () => {
  it("拒绝自我调用", async () => {
    const state = createInvocationState();
    state.parentSkill = "song-arranger";
    state.visited = ["song-arranger"];
    const result = await call(state, "song-arranger");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/self-invocation/);
  });

  it("拒绝 A → B → A 环", async () => {
    const state = createInvocationState();
    state.parentSkill = "harmony-arranger";
    state.visited = ["song-arranger", "harmony-arranger"];
    const result = await call(state, "song-arranger");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/cycle/);
  });

  it("拒绝超过最大深度", async () => {
    const state = createInvocationState();
    state.parentSkill = "melody-arranger";
    state.visited = ["song-arranger", "harmony-arranger", "melody-arranger"];
    state.depth = 2;
    const result = await call(state, "bass-arranger");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/max-depth/);
  });

  it("拒绝超过单父子调用上限", async () => {
    const state = createInvocationState();
    state.parentSkill = "song-arranger";
    state.visited = ["song-arranger"];
    state.childCounts["song-arranger"] = 4;
    const result = await call(state, "harmony-arranger");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/max-children/);
  });

  it("拒绝超过全局调用上限", async () => {
    const state = createInvocationState();
    state.parentSkill = "song-arranger";
    state.visited = ["song-arranger"];
    state.totalCalls = 8;
    const result = await call(state, "harmony-arranger");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/max-total/);
  });

  it("拒绝未知 Skill", async () => {
    const state = createInvocationState();
    state.parentSkill = "song-arranger";
    state.visited = ["song-arranger"];
    const result = await call(state, "missing-skill");
    expect(result.status).toBe("error");
    expect(result.error).toMatch(/unknown-skill/);
  });
});

describe("invokeSkill success path", () => {
  it("子调用成功并收拢结构化结果", async () => {
    const state = createInvocationState();
    state.parentSkill = "song-arranger";
    state.visited = ["song-arranger"];
    const traces: SkillTraceEntry[] = [];
    const result = await invokeSkill({
      skills,
      project,
      targetSkill: "harmony-arranger",
      task: "修和声",
      state,
      parent: { requestId: "r1", mode: "goal" },
      runKernel: cannedRun(),
      childTimeoutMs: 5_000,
      recordTrace: (entry) => traces.push(entry),
    });
    expect(result.status).toBe("ok");
    expect(result.skill).toBe("harmony-arranger");
    expect(result.operations).toHaveLength(1);
    expect(result.affectedTracks).toEqual(["melody"]);
    expect(result.affectedNotes).toEqual(["n1"]);
    expect(result.depth).toBe(1);
    expect(state.totalCalls).toBe(1);
    expect(state.childCounts["song-arranger"]).toBe(1);
    expect(traces).toHaveLength(1);
    expect(traces[0].childSkill).toBe("harmony-arranger");
  });

  it("子内核抛错时返回 error 而非抛出", async () => {
    const state = createInvocationState();
    state.parentSkill = "song-arranger";
    state.visited = ["song-arranger"];
    const result = await call(state, "harmony-arranger", async () => { throw new Error("boom"); });
    expect(result.status).toBe("error");
    expect(result.error).toContain("boom");
  });

  it("未设置 childTimeoutMs 时不附加超时信号", async () => {
    const state = createInvocationState();
    state.parentSkill = "song-arranger";
    state.visited = ["song-arranger"];
    const traces: SkillTraceEntry[] = [];
    const result = await invokeSkill({
      skills,
      project,
      targetSkill: "harmony-arranger",
      task: "修和声",
      state,
      parent: { requestId: "r1", mode: "goal" },
      runKernel: cannedRun(),
      recordTrace: (entry) => traces.push(entry),
    });
    expect(result.status).toBe("ok");
    expect(result.depth).toBe(1);
  });
});
