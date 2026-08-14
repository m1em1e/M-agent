import { describe, expect, it } from "vitest";
import {
  CONVERSATION_SETTINGS_STORAGE_KEY,
  DEFAULT_CONVERSATION_SETTINGS,
  PI_THINKING_LEVELS,
  loadConversationSettings,
  normalizeConversationSettings,
  parseConversationSettings,
  saveConversationSettings,
  type ConversationSettings,
} from "../../src/shared/conversation-settings";

describe("conversation settings", () => {
  it("uses the requested defaults and stable Pi thinking levels", () => {
    expect(DEFAULT_CONVERSATION_SETTINGS).toEqual({
      showThinking: true,
      thinkingLevel: "medium",
      goalMaxTurns: 20,
      goalMaxTokens: 500_000,
    });
    expect(PI_THINKING_LEVELS).toEqual(["low", "medium", "high"]);
  });

  it("normalizes partial, damaged, and out-of-range data", () => {
    expect(parseConversationSettings("not-json")).toEqual(DEFAULT_CONVERSATION_SETTINGS);
    expect(normalizeConversationSettings([])).toEqual(DEFAULT_CONVERSATION_SETTINGS);
    expect(normalizeConversationSettings({
      showThinking: false,
      thinkingLevel: "xhigh",
      goalMaxTurns: 500,
      goalMaxTokens: 10,
    })).toEqual({
      showThinking: false,
      thinkingLevel: "medium",
      goalMaxTurns: 100,
      goalMaxTokens: 1_024,
    });
  });

  it("round-trips through storage and tolerates storage failures", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const settings: ConversationSettings = {
      showThinking: false,
      thinkingLevel: "high",
      goalMaxTurns: 24,
      goalMaxTokens: 750_000,
    };
    saveConversationSettings(settings, storage);
    expect(values.has(CONVERSATION_SETTINGS_STORAGE_KEY)).toBe(true);
    expect(loadConversationSettings(storage)).toEqual(settings);
    expect(loadConversationSettings({ getItem: () => { throw new Error("denied"); } })).toEqual(DEFAULT_CONVERSATION_SETTINGS);
    expect(() => saveConversationSettings(settings, { setItem: () => { throw new Error("denied"); } })).not.toThrow();
  });
});
