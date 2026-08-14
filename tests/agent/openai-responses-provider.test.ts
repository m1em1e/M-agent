import { describe, expect, it, vi } from "vitest";
import {
  OpenAIResponsesProvider,
  OpenAIResponsesProviderError,
} from "../../src/core/agent";
import { createTestProject, validRawChangeSet } from "./fixtures";

function request() {
  return {
    requestId: "request-1",
    mode: "goal" as const,
    objective: "create a loop",
    project: createTestProject(),
    iteration: 1,
    maxCandidates: 2,
    previousCandidates: [],
  };
}

describe("OpenAIResponsesProvider", () => {
  it("calls the Responses endpoint with structured JSON output", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          output_text: JSON.stringify({
            analysis: "candidate",
            proposedChangeSets: [validRawChangeSet()],
          }),
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const provider = new OpenAIResponsesProvider({
      apiKey: async () => "secret",
      model: "test-model",
      fetch: fetchMock as typeof fetch,
    });

    const result = await provider.generate(request());

    expect(result.proposedChangeSets).toHaveLength(1);
    expect(result.usage).toMatchObject({ inputTokens: 100, outputTokens: 50 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer secret");
    const body = JSON.parse(String(init.body));
    expect(body.text.format.type).toBe("json_schema");
    expect(body.text.format.strict).toBe(true);
  });

  it("surfaces an HTTP error without leaking the key", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "private-key",
      fetch: (async () =>
        new Response(JSON.stringify({ error: { message: "rate limited" } }), {
          status: 429,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
    });
    await expect(provider.generate(request())).rejects.toMatchObject({
      code: "HTTP_ERROR",
      status: 429,
      message: "rate limited",
    });
    await expect(provider.generate(request())).rejects.not.toThrow("private-key");
  });

  it("rejects invalid model JSON", async () => {
    const provider = new OpenAIResponsesProvider({
      apiKey: "key",
      fetch: (async () =>
        new Response(JSON.stringify({ output_text: "not-json" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as typeof fetch,
    });
    await expect(provider.generate(request())).rejects.toBeInstanceOf(
      OpenAIResponsesProviderError,
    );
  });
});
