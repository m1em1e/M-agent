import { describe, expect, it, vi } from "vitest";
import {
  AgentToolExecutor,
  AgentToolPermissionError,
  allowedToolsForMode,
  canAgentUseTool,
} from "../../src/core/agent";

describe("agent tool permissions", () => {
  it("makes research strictly read-only", () => {
    expect(canAgentUseTool("research", "project.read")).toBe(true);
    expect(canAgentUseTool("research", "project.analyze")).toBe(true);
    expect(canAgentUseTool("research", "changes.propose")).toBe(false);
    expect(canAgentUseTool("research", "changes.apply")).toBe(false);
    expect(canAgentUseTool("research", "project.write")).toBe(false);
  });

  it("allows previews but no persisted mutation in plan and goal modes", () => {
    expect(allowedToolsForMode("plan")).toContain("changes.simulate");
    expect(allowedToolsForMode("goal")).toContain("candidate.score");
    for (const mode of ["plan", "goal"] as const) {
      expect(canAgentUseTool(mode, "changes.apply")).toBe(false);
      expect(canAgentUseTool(mode, "project.write")).toBe(false);
      expect(canAgentUseTool(mode, "midi.export")).toBe(false);
    }
  });

  it("blocks before invoking a registered mutation handler", async () => {
    const executor = new AgentToolExecutor();
    const handler = vi.fn(() => "mutated");
    executor.register("changes.apply", handler);

    await expect(
      executor.execute("goal", "changes.apply", {}),
    ).rejects.toBeInstanceOf(AgentToolPermissionError);
    expect(handler).not.toHaveBeenCalled();
  });

  it("executes an allowed handler", async () => {
    const executor = new AgentToolExecutor();
    executor.register("project.read", () => ({ title: "ok" }));
    await expect(executor.execute("research", "project.read", {})).resolves.toEqual({
      title: "ok",
    });
  });
});
