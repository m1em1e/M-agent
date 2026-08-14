export type BuiltInThemeId = "default" | "nord" | "tokyo-night" | "warn-paper" | "high-contrast";
export type ThemeId = string;
export type AppearanceMode = "dark" | "light" | "theme";
export type ResolvedColorMode = Exclude<AppearanceMode, "theme">;

export interface AppearancePreferences {
  theme: ThemeId;
  mode: AppearanceMode;
}

export const THEME_TOKEN_NAMES = [
  "--bg",
  "--panel",
  "--panel-2",
  "--panel-3",
  "--line",
  "--line-strong",
  "--text",
  "--muted",
  "--dim",
  "--accent",
  "--accent-soft",
  "--lime",
  "--blue",
  "--purple",
  "--accent-contrast",
  "--surface-title",
  "--surface-toolbar",
  "--surface-editor",
  "--surface-input",
  "--surface-hover",
  "--surface-selected",
  "--surface-modal",
  "--surface-modal-alt",
  "--surface-overlay",
  "--scroll-track",
  "--scroll-thumb",
  "--shadow",
  "--canvas-bg",
  "--canvas-ruler",
  "--canvas-key-bed",
  "--canvas-black-row",
  "--canvas-c-row",
  "--canvas-row",
  "--canvas-row-line",
  "--canvas-black-key",
  "--canvas-white-key",
  "--canvas-key-label",
  "--canvas-bar-line",
  "--canvas-beat-line",
  "--canvas-ruler-text",
  "--canvas-selection",
  "--canvas-selection-handle",
  "--canvas-playhead",
] as const;

export type ThemeTokenName = typeof THEME_TOKEN_NAMES[number];
export type ThemeTokens = Partial<Record<ThemeTokenName, string>>;

export type ThemeSource =
  | { kind: "built-in" }
  | { kind: "plugin"; pluginId: string; pluginName: string };

export interface ThemePreset {
  id: ThemeId;
  label: string;
  description: string;
  preferredMode: ResolvedColorMode;
  swatches: readonly [string, string, string];
  source: ThemeSource;
  tokens?: Readonly<Record<ResolvedColorMode, ThemeTokens>>;
}

export interface PluginThemeContribution extends ThemePreset {
  source: Extract<ThemeSource, { kind: "plugin" }>;
  tokens: Readonly<Record<ResolvedColorMode, ThemeTokens>>;
}

export const APPEARANCE_STORAGE_KEY = "magent.appearance.v1";

export const DEFAULT_APPEARANCE: AppearancePreferences = {
  theme: "default",
  mode: "theme",
};

export const BUILT_IN_THEME_PRESETS: readonly ThemePreset[] = [
  {
    id: "default",
    label: "默认",
    description: "M Agent 原生炭黑与珊瑚色",
    preferredMode: "dark",
    swatches: ["#0d0f10", "#ff8267", "#b8e36e"],
    source: { kind: "built-in" },
  },
  {
    id: "nord",
    label: "Nord",
    description: "极夜蓝灰与冰川青",
    preferredMode: "dark",
    swatches: ["#2e3440", "#88c0d0", "#a3be8c"],
    source: { kind: "built-in" },
  },
  {
    id: "tokyo-night",
    label: "Tokyo Night",
    description: "东京夜色与电光蓝紫",
    preferredMode: "dark",
    swatches: ["#1a1b26", "#7aa2f7", "#bb9af7"],
    source: { kind: "built-in" },
  },
  {
    id: "warn-paper",
    label: "Warn Paper",
    description: "暖纸张、墨色与砖红",
    preferredMode: "light",
    swatches: ["#f4ead7", "#b44d32", "#66724e"],
    source: { kind: "built-in" },
  },
  {
    id: "high-contrast",
    label: "High Contrast",
    description: "高辨识度纯色与清晰边界",
    preferredMode: "dark",
    swatches: ["#000000", "#00e5ff", "#baff00"],
    source: { kind: "built-in" },
  },
] as const;

// Kept as the public built-in list; plugin systems should use createThemeCatalog instead.
export const THEME_PRESETS = BUILT_IN_THEME_PRESETS;

export const APPEARANCE_MODES: readonly { id: AppearanceMode; label: string }[] = [
  { id: "dark", label: "深色" },
  { id: "light", label: "浅色" },
  { id: "theme", label: "跟随主题" },
] as const;

const appearanceModes = new Set<AppearanceMode>(APPEARANCE_MODES.map((mode) => mode.id));
const themeTokenNames = new Set<string>(THEME_TOKEN_NAMES);
const appliedInlineTokens = new WeakMap<HTMLElement, readonly ThemeTokenName[]>();
const pluginIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const pluginThemeIdPattern = /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/i;
const swatchPattern = /^#[0-9a-f]{6}$/i;

export function createThemeCatalog(
  pluginThemes: readonly PluginThemeContribution[] = [],
): readonly ThemePreset[] {
  const catalog = [...BUILT_IN_THEME_PRESETS];
  const ids = new Set(catalog.map((theme) => theme.id));
  for (const contribution of pluginThemes) {
    assertPluginThemeContribution(contribution, ids);
    ids.add(contribution.id);
    catalog.push(clonePluginTheme(contribution));
  }
  return Object.freeze(catalog);
}

export function parseAppearancePreferences(
  raw: string | null | undefined,
  themes: readonly ThemePreset[] = THEME_PRESETS,
): AppearancePreferences {
  if (!raw) return { ...DEFAULT_APPEARANCE };
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object") return { ...DEFAULT_APPEARANCE };
    const candidate = value as Partial<AppearancePreferences>;
    const themeIds = new Set(themes.map((theme) => theme.id));
    return {
      theme: typeof candidate.theme === "string" && themeIds.has(candidate.theme)
        ? candidate.theme
        : DEFAULT_APPEARANCE.theme,
      mode: typeof candidate.mode === "string" && appearanceModes.has(candidate.mode as AppearanceMode)
        ? candidate.mode as AppearanceMode
        : DEFAULT_APPEARANCE.mode,
    };
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function resolveColorMode(
  preferences: AppearancePreferences,
  themes: readonly ThemePreset[] = THEME_PRESETS,
): ResolvedColorMode {
  if (preferences.mode !== "theme") return preferences.mode;
  return themes.find((theme) => theme.id === preferences.theme)?.preferredMode ?? "dark";
}

export function loadAppearancePreferences(
  storage: Pick<Storage, "getItem"> = window.localStorage,
  themes: readonly ThemePreset[] = THEME_PRESETS,
): AppearancePreferences {
  try {
    return parseAppearancePreferences(storage.getItem(APPEARANCE_STORAGE_KEY), themes);
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function saveAppearancePreferences(
  preferences: AppearancePreferences,
  storage: Pick<Storage, "setItem"> = window.localStorage,
): void {
  try {
    storage.setItem(APPEARANCE_STORAGE_KEY, JSON.stringify(preferences));
  } catch {
    // Appearance preferences are non-critical; keep the applied in-memory value.
  }
}

export function applyAppearancePreferences(
  preferences: AppearancePreferences,
  themes: readonly ThemePreset[] = THEME_PRESETS,
  root: HTMLElement = document.documentElement,
): void {
  const theme = themes.find((candidate) => candidate.id === preferences.theme) ?? themes[0] ?? BUILT_IN_THEME_PRESETS[0];
  const safePreferences = { ...preferences, theme: theme.id };
  const colorMode = resolveColorMode(safePreferences, themes);
  root.dataset.theme = theme.id;
  root.dataset.themeSource = theme.source.kind;
  root.dataset.appearanceMode = preferences.mode;
  root.dataset.colorMode = colorMode;
  root.style.colorScheme = colorMode;

  for (const tokenName of appliedInlineTokens.get(root) ?? []) root.style.removeProperty(tokenName);
  const entries = Object.entries(theme.tokens?.[colorMode] ?? {}) as Array<[ThemeTokenName, string]>;
  for (const [tokenName, value] of entries) root.style.setProperty(tokenName, value);
  appliedInlineTokens.set(root, entries.map(([tokenName]) => tokenName));
}

function assertPluginThemeContribution(
  contribution: PluginThemeContribution,
  existingIds: ReadonlySet<string>,
): void {
  if (!pluginIdPattern.test(contribution.source.pluginId)) throw new Error("插件主题的 pluginId 无效。");
  if (!pluginThemeIdPattern.test(contribution.id) || !contribution.id.startsWith(`${contribution.source.pluginId}/`)) {
    throw new Error("插件主题 ID 必须使用 pluginId/themeId 命名空间。");
  }
  if (existingIds.has(contribution.id)) throw new Error(`主题 ID 重复：${contribution.id}`);
  if (!contribution.label.trim() || contribution.label.length > 64) throw new Error("插件主题名称长度无效。");
  if (contribution.description.length > 160) throw new Error("插件主题描述过长。");
  if (contribution.swatches.length !== 3 || contribution.swatches.some((color) => !swatchPattern.test(color))) {
    throw new Error("插件主题预览色必须是三个六位十六进制颜色。");
  }
  for (const mode of ["dark", "light"] as const) {
    for (const [tokenName, value] of Object.entries(contribution.tokens[mode])) {
      if (!themeTokenNames.has(tokenName)) throw new Error(`插件主题包含不允许的颜色变量：${tokenName}`);
      if (typeof value !== "string" || !value.trim() || value.length > 128 || /url\s*\(|expression\s*\(|@import|;/i.test(value)) {
        throw new Error(`插件主题颜色值无效：${tokenName}`);
      }
    }
  }
}

function clonePluginTheme(contribution: PluginThemeContribution): ThemePreset {
  return Object.freeze({
    ...contribution,
    swatches: Object.freeze([...contribution.swatches]) as unknown as readonly [string, string, string],
    source: Object.freeze({ ...contribution.source }),
    tokens: Object.freeze({
      dark: Object.freeze({ ...contribution.tokens.dark }),
      light: Object.freeze({ ...contribution.tokens.light }),
    }),
  });
}
