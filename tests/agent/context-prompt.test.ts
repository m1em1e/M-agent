import { describe, expect, it } from "vitest";
import { AGENT_CONTEXT_PROMPT } from "../../src/core/agent/context-prompt";

describe("agent context prompt", () => {
  it("documents the project file format for the model", () => {
    for (const fragment of [
      "M Agent",
      "ppq",
      "tempoMap",
      "timeSignatures",
      "loopRegion",
      "tracks",
      "revisions",
      "agentSessions",
      "instruments",
      "volume",
      "instrument",
      "research",
      "plan",
      "goal",
      "insert_notes",
      "delete_notes",
      "update_notes",
      "create_track",
      "delete_track",
      "update_track",
      "set_tempo",
      "set_time_signature",
      "set_loop",
      "clear_loop",
      "propose_midi_changes",
      "500",
      "10,000",
      "3",
    ]) {
      expect(AGENT_CONTEXT_PROMPT).toContain(fragment);
    }
  });

  it("keeps the boundary language consistent with the kernel", () => {
    expect(AGENT_CONTEXT_PROMPT).toMatch(/永远不能直接改写工程/);
    expect(AGENT_CONTEXT_PROMPT).toMatch(/简体中文/);
    expect(AGENT_CONTEXT_PROMPT).toMatch(/禁止编造/);
  });

  it("marks instruments as read-only and not injected into the conversation", () => {
    expect(AGENT_CONTEXT_PROMPT).toMatch(/音源（instrument）是只读元数据/);
    expect(AGENT_CONTEXT_PROMPT).toMatch(/不会注入到对话上下文/);
  });
});
