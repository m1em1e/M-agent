import { describe, expect, it } from "vitest";
import {
  APPEARANCE_STORAGE_KEY,
  DEFAULT_APPEARANCE,
  THEME_PRESETS,
  createThemeCatalog,
  loadAppearancePreferences,
  parseAppearancePreferences,
  resolveColorMode,
  saveAppearancePreferences,
  type AppearancePreferences,
  type PluginThemeContribution,
} from "../../src/renderer/theme";

describe("appearance preferences", () => {
  it("exposes the requested theme presets in a stable order", () => {
    expect(THEME_PRESETS.map((theme) => [theme.id, theme.label])).toEqual([
      ["default", "默认"],
      ["nord", "Nord"],
      ["tokyo-night", "Tokyo Night"],
      ["warn-paper", "Warn Paper"],
      ["high-contrast", "High Contrast"],
    ]);
  });

  it("uses each theme recommendation when following the theme", () => {
    const followedModes = Object.fromEntries(THEME_PRESETS.map((theme) => [
      theme.id,
      resolveColorMode({ theme: theme.id, mode: "theme" }),
    ]));
    expect(followedModes).toEqual({
      default: "dark",
      nord: "dark",
      "tokyo-night": "dark",
      "warn-paper": "light",
      "high-contrast": "dark",
    });
  });

  it("lets an explicit appearance mode override the preset recommendation", () => {
    expect(resolveColorMode({ theme: "warn-paper", mode: "dark" })).toBe("dark");
    expect(resolveColorMode({ theme: "tokyo-night", mode: "light" })).toBe("light");
  });

  it("falls back safely when persisted data is damaged or unsupported", () => {
    expect(parseAppearancePreferences("not-json")).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearancePreferences(JSON.stringify({ theme: "unknown", mode: "system" }))).toEqual(DEFAULT_APPEARANCE);
    expect(parseAppearancePreferences(JSON.stringify({ theme: "nord", mode: "light" }))).toEqual({
      theme: "nord",
      mode: "light",
    });
  });

  it("round-trips preferences through storage", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
    };
    const preferences: AppearancePreferences = { theme: "high-contrast", mode: "light" };
    saveAppearancePreferences(preferences, storage);
    expect(values.has(APPEARANCE_STORAGE_KEY)).toBe(true);
    expect(loadAppearancePreferences(storage)).toEqual(preferences);
  });

  it("merges namespaced plugin themes without allowing built-in overrides", () => {
    const contribution: PluginThemeContribution = {
      id: "studio.example/aurora",
      label: "Aurora",
      description: "Plugin theme",
      preferredMode: "dark",
      swatches: ["#102030", "#40a0c0", "#80d090"],
      source: { kind: "plugin", pluginId: "studio.example", pluginName: "Example Themes" },
      tokens: {
        dark: { "--bg": "#102030", "--accent": "#40a0c0" },
        light: { "--bg": "#eef8fa", "--accent": "#267080" },
      },
    };
    const catalog = createThemeCatalog([contribution]);
    expect(catalog).toHaveLength(6);
    expect(catalog.at(-1)?.source).toEqual({ kind: "plugin", pluginId: "studio.example", pluginName: "Example Themes" });
    expect(parseAppearancePreferences(JSON.stringify({ theme: contribution.id, mode: "theme" }), catalog)).toEqual({
      theme: contribution.id,
      mode: "theme",
    });
    expect(() => createThemeCatalog([{ ...contribution, id: "default" }])).toThrow(/命名空间/);
  });

  it("rejects plugin themes with unsafe or unknown style tokens", () => {
    const unsafeTheme = {
      id: "studio.example/unsafe",
      label: "Unsafe",
      description: "",
      preferredMode: "dark",
      swatches: ["#102030", "#40a0c0", "#80d090"],
      source: { kind: "plugin", pluginId: "studio.example", pluginName: "Example Themes" },
      tokens: {
        dark: { "--bg": "url(https://example.com/image.png)" },
        light: { "--not-allowed": "red" },
      },
    } as unknown as PluginThemeContribution;
    expect(() => createThemeCatalog([unsafeTheme])).toThrow(/颜色值无效|不允许的颜色变量/);
  });
});
