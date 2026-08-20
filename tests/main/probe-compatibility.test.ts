import { describe, expect, it, vi } from "vitest";
import { classifyProbeStatus } from "../../src/main/probe-compatibility";
import { detectCompatibilitySuggestion } from "../../src/main/probe-compatibility";

describe("probe compatibility", () => {
  it("classifies probe status codes", () => {
    expect(classifyProbeStatus(200)).toBe("ok");
    expect(classifyProbeStatus(204)).toBe("ok");
    expect(classifyProbeStatus(400)).toBe("ok");
    expect(classifyProbeStatus(401)).toBe("ok");
    expect(classifyProbeStatus(404)).toBe("notfound");
    expect(classifyProbeStatus(500)).toBe("server-error");
    expect(classifyProbeStatus(503)).toBe("server-error");
  });

  it("returns null when both endpoints are healthy", async () => {
    const fetchStub = viFetchMock(200, 200);
    const result = await runDetect(fetchStub);
    expect(result).toBeNull();
  });

  it("suggests switching when the current endpoint is 404 and the alternative works", async () => {
    const fetchStub = viFetchMock(404, 200, "responses");
    const result = await runDetect(fetchStub, "openai-responses");
    expect(result).not.toBeNull();
    expect(result?.recommendedApiType).toBe("openai-completions");
  });

  it("suggests switching when the current endpoint is 5xx and the alternative works", async () => {
    const fetchStub = viFetchMock(500, 200);
    const result = await runDetect(fetchStub, "openai-completions");
    expect(result?.recommendedApiType).toBe("openai-responses");
  });

  it("returns null when both endpoints are broken (server-wide failure)", async () => {
    const fetchStub = viFetchMock(500, 503);
    const result = await runDetect(fetchStub);
    expect(result).toBeNull();
  });

  it("returns null when the alternative endpoint is unreachable", async () => {
    const fetchStub = viFetchMock(404, Promise.reject(new Error("network down")));
    const result = await runDetect(fetchStub);
    expect(result).toBeNull();
  });

  it("skips non-openai api types", async () => {
    const fetchStub = viFetchMock(404, 200);
    const result = await detectCompatibilitySuggestion({
      baseUrl: "https://example.com",
      apiKey: "k",
      currentApiType: "anthropic-messages",
    });
    expect(result).toBeNull();
    expect(fetchStub).toHaveBeenCalledTimes(0);
  });
});

function viFetchMock(
  currentStatus: number | Promise<never>,
  altStatus: number | Promise<never>,
  currentEndpoint: "chat/completions" | "responses" = "chat/completions",
): ReturnType<typeof vi.fn> {
  const altEndpoint = currentEndpoint === "chat/completions" ? "responses" : "chat/completions";
  const stub = (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith(`/${currentEndpoint}`)) return respond(currentStatus);
    if (url.endsWith(`/${altEndpoint}`)) return respond(altStatus);
    return respond(altStatus);
  };
  return vi.fn(stub) as ReturnType<typeof vi.fn>;
}

function respond(status: number | Promise<never>) {
  if (status instanceof Promise) return status;
  return Promise.resolve({ status, ok: status >= 200 && status < 300 } as Response);
}

async function runDetect(fetchStub: ReturnType<typeof vi.fn>, currentApiType: "openai-completions" | "openai-responses" = "openai-completions") {
  const original = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = fetchStub;
  try {
    return await detectCompatibilitySuggestion({
      baseUrl: "https://example.com/v1",
      apiKey: "k",
      currentApiType,
    });
  } finally {
    (globalThis as { fetch: unknown }).fetch = original;
  }
}
