export const EXPORT_SETTINGS_STORAGE_KEY = "magent.export.v1";
/** 导出渲染时长上限（分钟）。 */
export const EXPORT_MAX_MINUTES_RANGE = { minimum: 1, maximum: 60 } as const;
/** 可选的导出采样率。 */
export const EXPORT_SAMPLE_RATES = [44100, 48000] as const;
export type ExportSampleRate = typeof EXPORT_SAMPLE_RATES[number];
export const DEFAULT_EXPORT_SAMPLE_RATE: ExportSampleRate = 44100;

export interface ExportSettings {
  /** 渲染时长上限（分钟）。 */
  maxMinutes: number;
}

export const DEFAULT_EXPORT_SETTINGS: ExportSettings = {
  maxMinutes: 10,
};

const clampMinutes = (value: number) =>
  Math.min(EXPORT_MAX_MINUTES_RANGE.maximum, Math.max(EXPORT_MAX_MINUTES_RANGE.minimum, Math.round(value)));

export function normalizeExportSettings(value: unknown): ExportSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_EXPORT_SETTINGS };
  const candidate = value as Partial<ExportSettings>;
  return {
    maxMinutes: typeof candidate.maxMinutes === "number" && Number.isFinite(candidate.maxMinutes)
      ? clampMinutes(candidate.maxMinutes)
      : DEFAULT_EXPORT_SETTINGS.maxMinutes,
  };
}

export function parseExportSettings(raw: string | null | undefined): ExportSettings {
  if (!raw) return { ...DEFAULT_EXPORT_SETTINGS };
  try {
    return normalizeExportSettings(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_EXPORT_SETTINGS };
  }
}

export function loadExportSettings(
  storage: Pick<Storage, "getItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage,
): ExportSettings {
  if (!storage) return { ...DEFAULT_EXPORT_SETTINGS };
  return parseExportSettings(storage.getItem(EXPORT_SETTINGS_STORAGE_KEY));
}

export function saveExportSettings(
  settings: ExportSettings,
  storage: Pick<Storage, "setItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage,
): void {
  if (!storage) return;
  storage.setItem(EXPORT_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
}
