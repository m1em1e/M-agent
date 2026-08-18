import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createMidiProject, createMidiTrack } from "../../src/core/midi";
import { PI_MODE_TOOLS, runPiKernel } from "../../src/core/agent/pi-kernel";

function project() {
  const value = createMidiProject({ id: "project-1", title: "Loop", ppq: 480, bpm: 100 });
  value.tracks.push(createMidiTrack({
    id: "melody",
    name: "Melody",
    role: "melody",
    channel: 0,
    program: 1,
    notes: [
      { id: "n1", pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 },
      { id: "n2", pitch: 64, startTick: 480, durationTicks: 480, velocity: 88 },
      { id: "n3", pitch: 67, startTick: 960, durationTicks: 480, velocity: 86 },
      { id: "n4", pitch: 72, startTick: 1440, durationTicks: 480, velocity: 84 },
    ],
  }));
  return value;
}

function hugeProject() {
  const value = createMidiProject({ id: "project-huge", title: "Huge", ppq: 480, bpm: 120 });
  value.tracks.push(createMidiTrack({
    id: "massive",
    name: "Massive",
    role: "melody",
    channel: 0,
    program: 1,
    notes: Array.from({ length: 130_000 }, (_, index) => ({
      id: `n${index}`,
      pitch: 36 + (index % 48),
      startTick: (index % 960) * 4,
      durationTicks: 240,
      velocity: 80,
    })),
  }));
  return value;
}

describe("Pi agent kernel", () => {
  it("enforces a read-only research tool set", async () => {
    expect([...PI_MODE_TOOLS.research]).not.toContain("propose_midi_changes");
    const result = await runPiKernel({
      requestId: "research-1",
      mode: "research",
      objective: "分析循环",
      project: project(),
    });
    expect(result.provider).toBe("pi-offline");
    expect(result.candidates).toEqual([]);
    expect(result.analysis).toContain("未产生任何修改");
    expect(result.thinking).toHaveLength(1);
    expect(result.thinking[0].text).toContain("只读边界");
    expect(result.thinking[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(result.effectiveThinkingLevel).toBe("medium");
  });

  it("runs tool calls through Pi and returns an unapplied goal candidate", async () => {
    const result = await runPiKernel({
      requestId: "goal-1",
      mode: "goal",
      objective: "让结尾更克制",
      project: project(),
    });
    expect(result.provider).toBe("pi-offline");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].operations[0]).toMatchObject({ type: "update_notes", trackId: "melody" });
    expect(result.events.some((event) => event.type === "tool_start" && event.name === "propose_midi_changes")).toBe(true);
  });

  it("keeps plan candidates as previews", async () => {
    const input = project();
    const before = structuredClone(input);
    const result = await runPiKernel({
      requestId: "plan-1",
      mode: "plan",
      objective: "规划动态调整",
      project: input,
    });
    expect(result.candidates).toHaveLength(1);
    expect(input).toEqual(before);
    expect(result.analysis).toContain("预览");
  });

  it("handles a 130,000-note single track without stack overflow", async () => {
    const result = await runPiKernel({
      requestId: "huge-1",
      mode: "research",
      objective: "分析大工程",
      project: hugeProject(),
    });
    expect(result.provider).toBe("pi-offline");
    expect(result.candidates).toEqual([]);
    expect(result.analysis.length).toBeGreaterThan(0);
  });

  it("coerces a stringified changeSet argument back into an object (prepareArguments)", async () => {
    const input = project();
    const stringifiedChangeSet = JSON.stringify({
      id: "coerce-1",
      summary: "字符串化候选",
      operations: [{
        type: "update_notes",
        trackId: "melody",
        changes: [{ noteId: "n1", velocity: 60 }],
      }],
      validation: [],
      estimatedAffectedNotes: 1,
    });
    const result = await runPiKernel({
      requestId: "coerce-1",
      mode: "goal",
      objective: "调整力度",
      project: input,
      offlineScript: (faux) => faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("propose_midi_changes", { changeSet: stringifiedChangeSet })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(fauxText("已提交候选。")),
      ]),
    });
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].id).toBe("coerce-1");
    expect(result.candidates[0].operations[0].type).toBe("update_notes");
  });

  it("passes an invalid changeSet through for the validator to reject", async () => {
    const input = project();
    const result = await runPiKernel({
      requestId: "coerce-2",
      mode: "goal",
      objective: "调整力度",
      project: input,
      offlineScript: (faux) => faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("propose_midi_changes", { changeSet: "{ not-valid-json" })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(fauxText("工具报错。")),
      ]),
    });
    // 非法字符串原样透传：不产生候选；工具执行以错误结束。
    expect(result.candidates).toHaveLength(0);
    const failedTool = result.events.find(
      (event) => event.type === "tool_end" && event.name === "propose_midi_changes" && event.isError,
    );
    expect(failedTool).toBeDefined();
  });

  it("research 首轮工具调用后续跑一轮读取结果并输出结论", async () => {
    const result = await runPiKernel({
      requestId: "research-loop-1",
      mode: "research",
      objective: "分析旋律",
      project: project(),
      offlineScript: (faux) => faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("inspect_midi_project", {})],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(fauxText("结论：旋律音域稳定，适合收束结尾。")),
      ]),
    });
    expect(result.turns).toBeGreaterThanOrEqual(2);
    expect(result.analysis).toContain("结论");
  });

  it("research 无工具调用时第一轮即停", async () => {
    const result = await runPiKernel({
      requestId: "research-stop-1",
      mode: "research",
      objective: "分析旋律",
      project: project(),
      offlineScript: (faux) => faux.setResponses([
        fauxAssistantMessage(fauxText("直接给出结论。")),
      ]),
    });
    expect(result.turns).toBe(1);
  });

  it("analyze_midi_project 无分页参数时返回紧凑摘要而非全量工程", async () => {
    const result = await runPiKernel({
      requestId: "analyze-summary-1",
      mode: "research",
      objective: "分析旋律",
      project: project(),
      offlineScript: (faux) => faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("analyze_midi_project", {})],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(fauxText("完成。")),
      ]),
    });
    // 摘要路径不抛错；事件中包含 analyze 工具调用。
    expect(result.events.some((event) => event.type === "tool_start" && event.name === "analyze_midi_project")).toBe(true);
  });

  it("analyze_midi_project 按 trackId/cursor/limit 分页返回音符切片", async () => {
    const result = await runPiKernel({
      requestId: "analyze-page-1",
      mode: "research",
      objective: "分页读取旋律轨",
      project: project(),
      offlineScript: (faux) => faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("analyze_midi_project", { trackId: "melody", cursor: 0, limit: 2 })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(fauxText("完成。")),
      ]),
    });
    expect(result.events.some((event) => event.type === "tool_end" && event.name === "analyze_midi_project" && !event.isError)).toBe(true);
  });
});
