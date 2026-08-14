import { describe, expect, it } from "vitest";
import { assertAgentRequestPayload, runAgent } from "../../src/main/agent-service";

const project = {
  title: "Service Loop",
  ppq: 480,
  tempo: 100,
  tracks: [{
    id: "melody",
    name: "Melody",
    role: "melody" as const,
    channel: 0,
    program: 1,
    muted: false,
    solo: false,
    notes: [
      { id: "n1", pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 },
      { id: "n2", pitch: 64, startTick: 480, durationTicks: 480, velocity: 88 },
    ],
  }],
};

describe("Pi-backed main agent service", () => {
  it("rejects malformed modes and empty objectives at the main-process boundary", () => {
    expect(() => assertAgentRequestPayload({ mode: "write", objective: "改写", project })).toThrow(/模式/);
    expect(() => assertAgentRequestPayload({ mode: "research", objective: " ", project })).toThrow(/目标/);
    const conversation = { showThinking: true, thinkingLevel: "medium", goalMaxTurns: 20, goalMaxTokens: 500_000 };
    expect(() => assertAgentRequestPayload({ mode: "goal", objective: "改写", project, conversation: { ...conversation, thinkingLevel: "ultra" } })).toThrow(/thinking/);
    expect(() => assertAgentRequestPayload({ mode: "goal", objective: "改写", project, conversation: { ...conversation, goalMaxTurns: 20.5 } })).toThrow(/轮次/);
    expect(() => assertAgentRequestPayload({ mode: "goal", objective: "改写", project, conversation: { ...conversation, goalMaxTokens: Number.NaN } })).toThrow(/Token/);
  });

  it("routes offline research through Pi and returns no candidates", async () => {
    const result = await runAgent({ mode: "research", objective: "分析旋律", project }, null);
    expect(result.kernel).toBe("pi");
    expect(result.provider).toBe("pi-offline");
    expect(result.candidates).toEqual([]);
  });

  it("routes goal requests through Pi and returns validated previews", async () => {
    const result = await runAgent({
      mode: "goal",
      objective: "收束结尾",
      project,
      conversation: { showThinking: true, thinkingLevel: "medium", goalMaxTurns: 20, goalMaxTokens: 500_000 },
    }, null);
    expect(result.kernel).toBe("pi");
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0].validation?.every((item) => item.valid)).toBe(true);
    expect(result.effectiveThinkingLevel).toBe("medium");
    expect(result.outputTokens).toBeGreaterThanOrEqual(0);
  });
});
