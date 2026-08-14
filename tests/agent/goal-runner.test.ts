import { describe, expect, it } from "vitest";
import {
  GoalRunner,
  MockAgentProvider,
  type AgentProvider,
} from "../../src/core/agent";
import { createTestProject, validRawChangeSet } from "./fixtures";

describe("GoalRunner", () => {
  it("returns validated and ranked candidates without modifying the project", async () => {
    const project = createTestProject();
    const original = JSON.stringify(project);
    const provider = new MockAgentProvider({
      responses: [
        {
          analysis: "two options",
          proposedChangeSets: [validRawChangeSet("b"), validRawChangeSet("a")],
          usage: { costUnits: 0.5 },
        },
      ],
    });
    const runner = new GoalRunner(provider, {
      budget: { maxIterations: 3, targetCandidateCount: 2 },
    });

    const result = await runner.run({ requestId: "run-1", objective: "create motif", project });

    expect(result.status).toBe("completed");
    expect(result.candidates.map((candidate) => candidate.changeSet.id)).toEqual(["a", "b"]);
    expect(result.candidates.every((candidate) => candidate.changeSet.validation.length > 0)).toBe(true);
    expect(result.usedCostUnits).toBe(0.5);
    expect(JSON.stringify(project)).toBe(original);
  });

  it("stops at iteration and cost budgets", async () => {
    const provider = new MockAgentProvider({
      responseFactory: (request) => ({
        analysis: "duplicate candidate",
        proposedChangeSets: [validRawChangeSet("same-id")],
        usage: { costUnits: 1 },
      }),
    });
    const runner = new GoalRunner(provider, {
      budget: { maxIterations: 10, maxCostUnits: 2, targetCandidateCount: 3 },
    });
    const result = await runner.run({
      requestId: "run-budget",
      objective: "make alternatives",
      project: createTestProject(),
    });

    expect(result.status).toBe("budget_exhausted");
    expect(result.iterations).toBe(2);
    expect(provider.requests).toHaveLength(2);
    expect(result.usedCostUnits).toBe(2);
  });

  it("filters malformed and domain-invalid provider output", async () => {
    const unknownTrack = validRawChangeSet("unknown-track");
    unknownTrack.operations = [
      {
        type: "insert_notes",
        trackId: "missing",
        notes: [{ pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 }],
      },
    ];
    const provider = new MockAgentProvider({
      responses: [
        {
          analysis: "bad output",
          proposedChangeSets: [{ id: "broken" }, unknownTrack],
          usage: { costUnits: 1 },
        },
      ],
    });
    const runner = new GoalRunner(provider, {
      budget: { maxIterations: 1, targetCandidateCount: 2 },
    });
    const result = await runner.run({
      requestId: "run-invalid",
      objective: "bad",
      project: createTestProject(),
    });

    expect(result.candidates).toEqual([]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual([
      "INVALID_CANDIDATE_SCHEMA",
      "INVALID_CANDIDATE_DOMAIN",
    ]);
  });

  it("reports cancellation without calling the provider", async () => {
    const provider = new MockAgentProvider();
    const controller = new AbortController();
    controller.abort();
    const result = await new GoalRunner(provider).run(
      { requestId: "cancelled", objective: "none", project: createTestProject() },
      controller.signal,
    );
    expect(result.status).toBe("cancelled");
    expect(provider.requests).toHaveLength(0);
  });

  it("contains provider errors and returns no partial write", async () => {
    const provider: AgentProvider = {
      id: "failing",
      generate: async () => {
        throw new Error("offline");
      },
    };
    const result = await new GoalRunner(provider).run({
      requestId: "fail",
      objective: "test",
      project: createTestProject(),
    });
    expect(result.status).toBe("provider_error");
    expect(result.diagnostics[0]?.code).toBe("PROVIDER_ERROR");
  });

  it("aborts a provider call at the duration budget", async () => {
    let providerSignal: AbortSignal | undefined;
    const provider: AgentProvider = {
      id: "slow",
      generate: (_request, signal) => {
        providerSignal = signal;
        return new Promise(() => undefined);
      },
    };
    const result = await new GoalRunner(provider, {
      budget: { maxDurationMs: 10, targetCandidateCount: 1 },
    }).run({
      requestId: "timeout",
      objective: "test",
      project: createTestProject(),
    });
    expect(result.status).toBe("budget_exhausted");
    expect(providerSignal?.aborted).toBe(true);
    expect(result.diagnostics[0]?.code).toBe("TIME_BUDGET_EXHAUSTED");
  });
});
