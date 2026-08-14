import { describe, expect, it } from "vitest";
import {
  DEFAULT_WORKSPACE_LAYOUT,
  WORKSPACE_LAYOUT_STORAGE_KEY,
  constrainWorkspaceLayout,
  loadWorkspaceLayoutPreferences,
  normalizeWorkspaceLayout,
  resizeWorkspacePane,
  saveWorkspaceLayoutPreferences,
  type WorkspaceLayoutPreferences,
} from "../../src/renderer/workspace-layout";

describe("workspace layout preferences", () => {
  it("uses stable defaults and safely normalizes damaged values", () => {
    expect(normalizeWorkspaceLayout(null)).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(normalizeWorkspaceLayout({ tracksWidth: -20, agentWidth: 9_000, agentHidden: true })).toEqual({
      tracksWidth: 180,
      agentWidth: 560,
      agentHidden: true,
    });
    expect(normalizeWorkspaceLayout({ tracksWidth: Number.NaN, agentWidth: "wide", agentHidden: "yes" })).toEqual(
      DEFAULT_WORKSPACE_LAYOUT,
    );
  });

  it("keeps the editor usable while resizing either side panel", () => {
    const base: WorkspaceLayoutPreferences = { tracksWidth: 242, agentWidth: 354, agentHidden: false };
    expect(resizeWorkspacePane(base, "tracks", 900, 1_120).tracksWidth).toBe(294);
    expect(resizeWorkspacePane(base, "agent", 900, 1_120).agentWidth).toBe(406);
    expect(resizeWorkspacePane(base, "tracks", 100, 1_120).tracksWidth).toBe(180);
    expect(resizeWorkspacePane(base, "agent", 100, 1_120).agentWidth).toBe(280);
  });

  it("allows the editor to reclaim the agent column without forgetting its width", () => {
    const hidden = constrainWorkspaceLayout({ tracksWidth: 420, agentWidth: 512, agentHidden: true }, 1_120);
    expect(hidden).toEqual({ tracksWidth: 420, agentWidth: 512, agentHidden: true });

    const restored = constrainWorkspaceLayout({ ...hidden, agentHidden: false }, 1_120);
    expect(restored.tracksWidth).toBe(368);
    expect(restored.agentWidth).toBe(280);
    expect(restored.agentHidden).toBe(false);
  });

  it("round-trips layout state and tolerates unavailable storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const layout: WorkspaceLayoutPreferences = { tracksWidth: 320, agentWidth: 430, agentHidden: true };
    saveWorkspaceLayoutPreferences(layout, storage);
    expect(values.has(WORKSPACE_LAYOUT_STORAGE_KEY)).toBe(true);
    expect(loadWorkspaceLayoutPreferences(storage)).toEqual(layout);

    expect(loadWorkspaceLayoutPreferences({ getItem: () => { throw new Error("denied"); } })).toEqual(DEFAULT_WORKSPACE_LAYOUT);
    expect(() => saveWorkspaceLayoutPreferences(layout, { setItem: () => { throw new Error("denied"); } })).not.toThrow();
  });
});
