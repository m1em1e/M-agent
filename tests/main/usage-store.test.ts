import { beforeEach, describe, expect, it, vi } from "vitest";

const backing = new Map<string, Record<string, unknown>>();

vi.mock("electron-store", () => {
  class MockStore {
    constructor(private readonly options: { name?: string; defaults?: Record<string, unknown> }) {
      const key = this.options.name ?? "default";
      if (!backing.has(key) && this.options.defaults) backing.set(key, { ...this.options.defaults });
    }
    get(key: string): unknown {
      return (backing.get(this.options.name ?? "default") ?? {})[key];
    }
    set(key: string, value: unknown): void {
      const data = backing.get(this.options.name ?? "default") ?? {};
      data[key] = value;
      backing.set(this.options.name ?? "default", data);
    }
  }
  return { default: MockStore };
});

vi.mock("electron", () => ({}));

import {
  clearUsage,
  getUsageByDay,
  getUsageByModel,
  getUsageSummary,
  recordUsage,
} from "../../src/main/usage-store";

beforeEach(() => {
  backing.clear();
  backing.set("usage", { records: [] });
});

function entry(overrides: Partial<Parameters<typeof recordUsage>[0]> = {}) {
  return {
    timestamp: Date.now(),
    day: "2026-08-14",
    modelId: "gpt-5-mini",
    modelName: "gpt-5-mini",
    turns: 2,
    inputTokens: 100,
    outputTokens: 50,
    cacheReadTokens: 10,
    cacheWriteTokens: 5,
    cost: 0.0123,
    ...overrides,
  };
}

describe("usage store", () => {
  it("aggregates a summary across all records", () => {
    recordUsage(entry({ turns: 2, inputTokens: 100, outputTokens: 50, cacheReadTokens: 10, cost: 0.0123 }));
    recordUsage(entry({ turns: 3, inputTokens: 200, outputTokens: 30, cacheReadTokens: 20, cost: 0.0077 }));
    const summary = getUsageSummary();
    expect(summary.runCount).toBe(2);
    expect(summary.turns).toBe(5);
    expect(summary.tokens).toBe(380); // 150 + 230
    expect(summary.cacheRead).toBe(30);
    expect(summary.cost).toBeCloseTo(0.02, 4);
  });

  it("groups usage by day", () => {
    recordUsage(entry({ day: "2026-08-13", inputTokens: 10, outputTokens: 10, cost: 0.001 }));
    recordUsage(entry({ day: "2026-08-14", inputTokens: 100, outputTokens: 100, cost: 0.01 }));
    recordUsage(entry({ day: "2026-08-14", inputTokens: 50, outputTokens: 50, cost: 0.005 }));
    const page = getUsageByDay(1);
    expect(page.total).toBe(2);
    expect(page.rows[0].key).toBe("2026-08-14");
    expect(page.rows[0].runCount).toBe(2);
    expect(page.rows[0].tokens).toBe(300);
    expect(page.rows[1].key).toBe("2026-08-13");
  });

  it("groups usage by model sorted by tokens descending", () => {
    recordUsage(entry({ modelId: "gpt-5-mini", modelName: "GPT-5 mini", inputTokens: 100, outputTokens: 100 }));
    recordUsage(entry({ modelId: "claude-sonnet-4-5", modelName: "Claude Sonnet 4.5", inputTokens: 400, outputTokens: 200 }));
    recordUsage(entry({ modelId: "gpt-5-mini", modelName: "GPT-5 mini", inputTokens: 50, outputTokens: 50 }));
    const page = getUsageByModel(1);
    expect(page.total).toBe(2);
    expect(page.rows[0].label).toBe("Claude Sonnet 4.5");
    expect(page.rows[0].tokens).toBe(600);
    expect(page.rows[1].label).toBe("GPT-5 mini");
    expect(page.rows[1].tokens).toBe(300);
  });

  it("paginates 10 rows per page", () => {
    for (let index = 0; index < 25; index += 1) {
      recordUsage(entry({ day: `2026-08-${String((index % 28) + 1).padStart(2, "0")}` }));
    }
    const first = getUsageByDay(1);
    expect(first.rows).toHaveLength(10);
    expect(first.total).toBe(25);
    expect(first.totalPages).toBe(3);
    const third = getUsageByDay(3);
    expect(third.rows).toHaveLength(5);
    // Page beyond bounds clamps to the last page.
    const beyond = getUsageByDay(99);
    expect(beyond.page).toBe(3);
  });

  it("clears all usage", () => {
    recordUsage(entry());
    clearUsage();
    expect(getUsageSummary().runCount).toBe(0);
    expect(getUsageByDay(1).total).toBe(0);
  });
});
