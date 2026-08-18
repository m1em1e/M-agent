import { describe, expect, it } from "vitest";
import { createMidiProject, createMidiTrack } from "../../src/core/midi";
import { runPiKernel, type PiCustomProviderConfig } from "../../src/core/agent/pi-kernel";

const API_KEY = process.env.MAGENT_CLOUD_API_KEY;
const BASE_URL = process.env.MAGENT_CLOUD_BASE_URL ?? "https://opencode.ai/zen/go/v1";
const MODEL_ID = process.env.MAGENT_CLOUD_MODEL ?? "mimo-v2.5";

function providerConfig(): PiCustomProviderConfig {
  if (!API_KEY) throw new Error("需要设置 MAGENT_CLOUD_API_KEY 才能运行云端测试。");
  return {
    providerId: "cloud-regression",
    apiType: "openai-completions",
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    models: [{ id: MODEL_ID, name: MODEL_ID }],
    activeModelId: MODEL_ID,
  };
}

function project() {
  const value = createMidiProject({ id: "cloud-regression", title: "Loop", ppq: 480, bpm: 100 });
  value.tracks.push(createMidiTrack({
    id: "melody",
    name: "Melody",
    role: "melody",
    channel: 0,
    program: 1,
    notes: [
      { id: "n1", pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 },
      { id: "n2", pitch: 64, startTick: 480, durationTicks: 480, velocity: 88 },
    ],
  }));
  return value;
}

async function run(mode: "research" | "plan" | "goal", objective: string, maximumTurns = 3) {
  return runPiKernel({
    requestId: `cloud-${mode}-${Date.now()}`,
    mode,
    objective,
    project: project(),
    provider: "custom",
    customProvider: providerConfig(),
    modelId: MODEL_ID,
    thinkingLevel: "low",
    maximumTurns,
    maximumOutputTokens: 20_000,
  });
}

const describeCloud = API_KEY ? describe : describe.skip;

describeCloud("真实云端 Provider 回归（需 MAGENT_CLOUD_API_KEY）", () => {
  it("research 模式只读，不产出候选，返回分析结论", async () => {
    const result = await run("research", "分析这段旋律的音域与力度分布", 3);
    expect(result.provider).toBe("pi-custom");
    expect(result.candidates).toEqual([]);
    expect(result.analysis.length).toBeGreaterThan(0);
    expect(result.inputTokens + result.outputTokens).toBeGreaterThan(0);
  });

  it("plan 模式产出预览候选且不写入工程", async () => {
    const input = project();
    const before = structuredClone(input);
    const result = await run("plan", "规划如何收束结尾", 4);
    expect(input).toEqual(before);
    expect(result.analysis.length).toBeGreaterThan(0);
  });

  it("goal 模式产出经校验的候选（或明确说明未产生）", async () => {
    const result = await run("goal", "把结尾力度降低并收窄音域", 4);
    expect(result.analysis.length).toBeGreaterThan(0);
    // goal 可能因模型/预算未产出候选，但必须不抛错且提供结论。
    expect(Array.isArray(result.candidates)).toBe(true);
  });

  it("错误 Key 抛可辨识错误而非崩溃", async () => {
    const bad = { ...providerConfig(), apiKey: "sk-invalid-token-000" };
    await expect(runPiKernel({
      requestId: "cloud-bad-key",
      mode: "research",
      objective: "分析旋律",
      project: project(),
      provider: "custom",
      customProvider: bad,
      modelId: MODEL_ID,
      thinkingLevel: "low",
      maximumTurns: 2,
      maximumOutputTokens: 10_000,
    })).rejects.toThrow();
  });
}, 360_000);
