import { describe, expect, it } from "vitest";
import {
  DEFAULT_SHELL_PATH,
  DEFAULT_SHELL_SETTINGS,
  SHELL_SETTINGS_STORAGE_KEY,
  clearLegacyShellSettings,
} from "../../src/renderer/shell-settings";

describe("shell settings", () => {
  it("uses the requested Windows bash path by default", () => {
    expect(DEFAULT_SHELL_PATH).toBe("C:\\Windows\\system32\\bash.exe");
    expect(DEFAULT_SHELL_SETTINGS).toEqual({ path: DEFAULT_SHELL_PATH });
  });

  it("discards the deprecated Renderer shell preference", () => {
    const values = new Map<string, string>([[SHELL_SETTINGS_STORAGE_KEY, JSON.stringify({ path: "D:\\Portable\\bash.exe" })]]);
    const storage = {
      removeItem: (key: string) => { values.delete(key); },
    };
    clearLegacyShellSettings(storage);
    expect(values.has(SHELL_SETTINGS_STORAGE_KEY)).toBe(false);
    expect(() => clearLegacyShellSettings({ removeItem: () => { throw new Error("denied"); } })).not.toThrow();
  });
});
