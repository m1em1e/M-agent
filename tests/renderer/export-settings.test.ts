import { describe, expect, it } from "vitest";
import {
  DEFAULT_EXPORT_SETTINGS,
  EXPORT_MAX_MINUTES_RANGE,
  loadExportSettings,
  normalizeExportSettings,
  parseExportSettings,
  saveExportSettings,
} from "../../src/shared/export-settings";

describe("export settings", () => {
  it("normalizes invalid or missing values to defaults", () => {
    expect(normalizeExportSettings(null)).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(normalizeExportSettings("nope")).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(normalizeExportSettings([])).toEqual(DEFAULT_EXPORT_SETTINGS);
    expect(normalizeExportSettings({ maxMinutes: "10" })).toEqual(DEFAULT_EXPORT_SETTINGS);
  });

  it("clamps maxMinutes to the allowed range", () => {
    expect(normalizeExportSettings({ maxMinutes: 0 }).maxMinutes).toBe(EXPORT_MAX_MINUTES_RANGE.minimum);
    expect(normalizeExportSettings({ maxMinutes: 999 }).maxMinutes).toBe(EXPORT_MAX_MINUTES_RANGE.maximum);
    expect(normalizeExportSettings({ maxMinutes: 7.4 }).maxMinutes).toBe(7);
  });

  it("round trips through parse/save/load", () => {
    const settings = { maxMinutes: 15 };
    expect(parseExportSettings(JSON.stringify(settings))).toEqual(settings);
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };
    saveExportSettings(settings, storage);
    expect(loadExportSettings(storage)).toEqual(settings);
  });

  it("falls back to defaults for an empty store", () => {
    const storage = { getItem: () => null, setItem: () => undefined };
    expect(loadExportSettings(storage)).toEqual(DEFAULT_EXPORT_SETTINGS);
  });
});
