export const SHELL_SETTINGS_STORAGE_KEY = "magent.shell.v1";
export const DEFAULT_SHELL_PATH = "C:\\Windows\\system32\\bash.exe";
export const DEFAULT_SHELL_SETTINGS = { path: DEFAULT_SHELL_PATH };

/**
 * Shell execution settings moved to the main-process app-settings store.
 * Old Renderer values are deliberately discarded instead of being promoted
 * to executable paths without a native, bounded compatibility check.
 */
export function clearLegacyShellSettings(
  storage: Pick<Storage, "removeItem"> | undefined = typeof window === "undefined" ? undefined : window.localStorage,
): void {
  if (!storage) return;
  try {
    storage.removeItem(SHELL_SETTINGS_STORAGE_KEY);
  } catch {
    // A blocked preference store must not prevent the desktop editor from loading.
  }
}
