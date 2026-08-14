export const DEFAULT_WINDOWS_SHELL_PATH = "C:\\Windows\\system32\\bash.exe";
export const DEFAULT_POSIX_SHELL_PATH = "/bin/bash";

export type ShellCheckStatus = "ready" | "missing" | "invalid" | "unusable" | "timeout" | "output-limit";
export type ShellKind = "bash" | "powershell";

export interface ShellSettingsSnapshot {
  path: string;
  configured: boolean;
  kind: ShellKind;
}

export interface BrowseShellResult {
  canceled: boolean;
  filePath?: string;
}

export interface ShellCheckResult {
  path: string;
  kind?: ShellKind;
  status: ShellCheckStatus;
  usable: boolean;
  message: string;
  checkedAt: string;
  version?: string;
}

export function defaultShellPathForPlatform(platform: string): string {
  return platform === "win32" ? DEFAULT_WINDOWS_SHELL_PATH : DEFAULT_POSIX_SHELL_PATH;
}
