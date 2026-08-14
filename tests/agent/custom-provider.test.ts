import { describe, expect, it } from "vitest";
import {
  buildCustomProviderModels,
  createCustomProvider,
  type PiCustomProviderConfig,
} from "../../src/core/agent/pi-kernel";

const config: PiCustomProviderConfig = {
  providerId: "my-gateway",
  apiType: "openai-completions",
  baseUrl: "https://gateway.example.com/v1",
  apiKey: "sk-test",
  models: [
    { id: "fast-model", name: "Fast Model" },
    { id: "big-model", name: "Big Model", contextWindow: 262_144 },
  ],
  activeModelId: "big-model",
};

describe("custom provider model mapping", () => {
  it("builds pi-ai models with a 128k context default and per-model overrides", () => {
    const models = buildCustomProviderModels(config);
    expect(models).toHaveLength(2);
    expect(models[0]).toMatchObject({
      id: "fast-model",
      name: "Fast Model",
      api: "openai-completions",
      provider: "my-gateway",
      baseUrl: "https://gateway.example.com/v1",
      contextWindow: 128_000,
      maxTokens: 128_000,
      reasoning: false,
    });
    expect(models[1]).toMatchObject({ contextWindow: 262_144, maxTokens: 262_144 });
  });

  it("creates a runtime provider exposing the mapped models", () => {
    const provider = createCustomProvider(config);
    expect(provider.id).toBe("my-gateway");
    const models = provider.getModels();
    expect(models.map((model) => model.id)).toEqual(["fast-model", "big-model"]);
    expect(models[0].baseUrl).toBe("https://gateway.example.com/v1");
  });
});
