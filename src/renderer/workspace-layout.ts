export type WorkspacePane = "tracks" | "agent";

export interface WorkspaceLayoutPreferences {
  tracksWidth: number;
  agentWidth: number;
  agentHidden: boolean;
}

export const WORKSPACE_LAYOUT_STORAGE_KEY = "magent.workspace-layout.v1";

export const WORKSPACE_LAYOUT_LIMITS = {
  tracksMin: 180,
  tracksMax: 420,
  agentMin: 280,
  agentMax: 560,
  editorMin: 460,
  splitterSize: 6,
} as const;

export const DEFAULT_WORKSPACE_LAYOUT: WorkspaceLayoutPreferences = {
  tracksWidth: 242,
  agentWidth: 354,
  agentHidden: false,
};

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

const finiteWidth = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback;

export function normalizeWorkspaceLayout(value: unknown): WorkspaceLayoutPreferences {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...DEFAULT_WORKSPACE_LAYOUT };
  const candidate = value as Partial<WorkspaceLayoutPreferences>;
  return {
    tracksWidth: clamp(
      finiteWidth(candidate.tracksWidth, DEFAULT_WORKSPACE_LAYOUT.tracksWidth),
      WORKSPACE_LAYOUT_LIMITS.tracksMin,
      WORKSPACE_LAYOUT_LIMITS.tracksMax,
    ),
    agentWidth: clamp(
      finiteWidth(candidate.agentWidth, DEFAULT_WORKSPACE_LAYOUT.agentWidth),
      WORKSPACE_LAYOUT_LIMITS.agentMin,
      WORKSPACE_LAYOUT_LIMITS.agentMax,
    ),
    agentHidden: typeof candidate.agentHidden === "boolean"
      ? candidate.agentHidden
      : DEFAULT_WORKSPACE_LAYOUT.agentHidden,
  };
}

export function constrainWorkspaceLayout(
  value: WorkspaceLayoutPreferences,
  availableWidth: number,
): WorkspaceLayoutPreferences {
  const layout = normalizeWorkspaceLayout(value);
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return layout;

  const splitterCount = layout.agentHidden ? 1 : 2;
  const availableForSidebars = Math.max(
    0,
    Math.floor(availableWidth) - WORKSPACE_LAYOUT_LIMITS.editorMin - splitterCount * WORKSPACE_LAYOUT_LIMITS.splitterSize,
  );
  const tracksMax = Math.max(
    WORKSPACE_LAYOUT_LIMITS.tracksMin,
    Math.min(
      WORKSPACE_LAYOUT_LIMITS.tracksMax,
      availableForSidebars - (layout.agentHidden ? 0 : WORKSPACE_LAYOUT_LIMITS.agentMin),
    ),
  );
  const tracksWidth = clamp(layout.tracksWidth, WORKSPACE_LAYOUT_LIMITS.tracksMin, tracksMax);

  if (layout.agentHidden) return { ...layout, tracksWidth };

  const agentMax = Math.max(
    WORKSPACE_LAYOUT_LIMITS.agentMin,
    Math.min(WORKSPACE_LAYOUT_LIMITS.agentMax, availableForSidebars - tracksWidth),
  );
  return {
    ...layout,
    tracksWidth,
    agentWidth: clamp(layout.agentWidth, WORKSPACE_LAYOUT_LIMITS.agentMin, agentMax),
  };
}

export function resizeWorkspacePane(
  value: WorkspaceLayoutPreferences,
  pane: WorkspacePane,
  desiredWidth: number,
  availableWidth: number,
): WorkspaceLayoutPreferences {
  const layout = normalizeWorkspaceLayout(value);
  const splitters = layout.agentHidden ? 1 : 2;
  const availableForSidebars = Math.max(
    0,
    Math.floor(availableWidth) - WORKSPACE_LAYOUT_LIMITS.editorMin - splitters * WORKSPACE_LAYOUT_LIMITS.splitterSize,
  );

  if (pane === "tracks") {
    const maximum = Math.max(
      WORKSPACE_LAYOUT_LIMITS.tracksMin,
      Math.min(
        WORKSPACE_LAYOUT_LIMITS.tracksMax,
        availableForSidebars - (layout.agentHidden ? 0 : layout.agentWidth),
      ),
    );
    return {
      ...layout,
      tracksWidth: clamp(Math.round(desiredWidth), WORKSPACE_LAYOUT_LIMITS.tracksMin, maximum),
    };
  }

  const maximum = Math.max(
    WORKSPACE_LAYOUT_LIMITS.agentMin,
    Math.min(WORKSPACE_LAYOUT_LIMITS.agentMax, availableForSidebars - layout.tracksWidth),
  );
  return {
    ...layout,
    agentWidth: clamp(Math.round(desiredWidth), WORKSPACE_LAYOUT_LIMITS.agentMin, maximum),
  };
}

export function loadWorkspaceLayoutPreferences(
  storage: Pick<Storage, "getItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage,
): WorkspaceLayoutPreferences {
  if (!storage) return { ...DEFAULT_WORKSPACE_LAYOUT };
  try {
    const stored = storage.getItem(WORKSPACE_LAYOUT_STORAGE_KEY);
    return stored ? normalizeWorkspaceLayout(JSON.parse(stored) as unknown) : { ...DEFAULT_WORKSPACE_LAYOUT };
  } catch {
    return { ...DEFAULT_WORKSPACE_LAYOUT };
  }
}

export function saveWorkspaceLayoutPreferences(
  value: WorkspaceLayoutPreferences,
  storage: Pick<Storage, "setItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage,
): void {
  if (!storage) return;
  try {
    storage.setItem(WORKSPACE_LAYOUT_STORAGE_KEY, JSON.stringify(normalizeWorkspaceLayout(value)));
  } catch {
    // Layout preferences are non-critical; storage failures must not block editing.
  }
}
