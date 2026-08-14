export const PI_THINKING_LEVELS = ["low", "medium", "high"] as const;
export type PiThinkingLevel = typeof PI_THINKING_LEVELS[number];

export type ProjectInjectionMode = "all" | "selected";
export const PROJECT_INJECTION_MODES: ReadonlyArray<{ id: ProjectInjectionMode; label: string }> = [
  { id: "selected", label: "注入选中轨道" },
  { id: "all", label: "注入全部轨道" },
];

export interface ConversationSettings {
  showThinking: boolean;
  thinkingLevel: PiThinkingLevel;
  goalMaxTurns: number;
  goalMaxTokens: number;
  /** 工程注入方式：selected 注入概览 + 选中轨道音符明细；all 注入完整工程 JSON。 */
  projectInjection: ProjectInjectionMode;
}

export const CONVERSATION_SETTINGS_STORAGE_KEY = "magent.conversation.v1";
export const GOAL_MAX_TURNS_RANGE = { minimum: 1, maximum: 100 } as const;
export const GOAL_MAX_TOKENS_RANGE = { minimum: 1_024, maximum: 2_000_000 } as const;

export const DEFAULT_CONVERSATION_SETTINGS: ConversationSettings = {
  showThinking: true,
  thinkingLevel: "medium",
  goalMaxTurns: 20,
  goalMaxTokens: 500_000,
  projectInjection: "all",
};

const thinkingLevels = new Set<string>(PI_THINKING_LEVELS);
const injectionModes = new Set<string>(PROJECT_INJECTION_MODES.map((mode) => mode.id));
const clampInteger = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, Math.round(value)));

export function normalizeConversationSettings(value: unknown): ConversationSettings {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_CONVERSATION_SETTINGS };
  const candidate = value as Partial<ConversationSettings>;
  return {
    showThinking: typeof candidate.showThinking === "boolean"
      ? candidate.showThinking
      : DEFAULT_CONVERSATION_SETTINGS.showThinking,
    thinkingLevel: typeof candidate.thinkingLevel === "string" && thinkingLevels.has(candidate.thinkingLevel)
      ? candidate.thinkingLevel as PiThinkingLevel
      : DEFAULT_CONVERSATION_SETTINGS.thinkingLevel,
    goalMaxTurns: typeof candidate.goalMaxTurns === "number" && Number.isFinite(candidate.goalMaxTurns)
      ? clampInteger(candidate.goalMaxTurns, GOAL_MAX_TURNS_RANGE.minimum, GOAL_MAX_TURNS_RANGE.maximum)
      : DEFAULT_CONVERSATION_SETTINGS.goalMaxTurns,
    goalMaxTokens: typeof candidate.goalMaxTokens === "number" && Number.isFinite(candidate.goalMaxTokens)
      ? clampInteger(candidate.goalMaxTokens, GOAL_MAX_TOKENS_RANGE.minimum, GOAL_MAX_TOKENS_RANGE.maximum)
      : DEFAULT_CONVERSATION_SETTINGS.goalMaxTokens,
    projectInjection: typeof candidate.projectInjection === "string" && injectionModes.has(candidate.projectInjection)
      ? candidate.projectInjection as ProjectInjectionMode
      : DEFAULT_CONVERSATION_SETTINGS.projectInjection,
  };
}

export function parseConversationSettings(raw: string | null | undefined): ConversationSettings {
  if (!raw) return { ...DEFAULT_CONVERSATION_SETTINGS };
  try {
    return normalizeConversationSettings(JSON.parse(raw) as unknown);
  } catch {
    return { ...DEFAULT_CONVERSATION_SETTINGS };
  }
}

export function loadConversationSettings(
  storage: Pick<Storage, "getItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage,
): ConversationSettings {
  if (!storage) return { ...DEFAULT_CONVERSATION_SETTINGS };
  try {
    return parseConversationSettings(storage.getItem(CONVERSATION_SETTINGS_STORAGE_KEY));
  } catch {
    return { ...DEFAULT_CONVERSATION_SETTINGS };
  }
}

export function saveConversationSettings(
  settings: ConversationSettings,
  storage: Pick<Storage, "setItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(CONVERSATION_SETTINGS_STORAGE_KEY, JSON.stringify(normalizeConversationSettings(settings)));
  } catch {
    // Conversation preferences are non-critical; keep the in-memory values.
  }
}
