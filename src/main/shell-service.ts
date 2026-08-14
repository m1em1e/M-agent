import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import Store from "electron-store";
import {
  defaultShellPathForPlatform,
  type ShellCheckResult,
  type ShellKind,
  type ShellSettingsSnapshot,
} from "../shared/shell.js";

interface AppSettingsSchema {
  shellPath?: string;
}

interface ProcessOutput {
  stdout: string;
  stderr: string;
}

export type ShellCommand = string | Readonly<Record<ShellKind, string>>;

interface ShellRuntimeDependencies {
  platform: NodeJS.Platform;
  statFile(path: string): Promise<{ isFile(): boolean }>;
  accessFile(path: string, mode: number): Promise<void>;
  executeFile(path: string, args: readonly string[], options: ShellCommandOptions): Promise<ProcessOutput>;
}

export interface ShellCommandOptions {
  timeoutMs?: number;
  maximumOutputBytes?: number;
}

const SHELL_READY_MARKER = "M_AGENT_SHELL_READY_V1";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 64 * 1024;
const SHELL_PROBE_COMMAND: Readonly<Record<ShellKind, string>> = {
  bash: `printf '${SHELL_READY_MARKER}:%s\\n' "\${BASH_VERSION:-unknown}"`,
  powershell: `Write-Output ('${SHELL_READY_MARKER}:' + $PSVersionTable.PSVersion.ToString())`,
};

const defaultDependencies: ShellRuntimeDependencies = {
  platform: process.platform,
  statFile: stat,
  accessFile: access,
  executeFile: executeFileBounded,
};

let appSettingsStore: Store<AppSettingsSchema> | undefined;
const activeShellChecks = new Map<string, Promise<ShellCheckResult>>();

function settingsStore(): Store<AppSettingsSchema> {
  return appSettingsStore ??= new Store<AppSettingsSchema>({ name: "app-settings" });
}

export function getConfiguredShellSettings(): ShellSettingsSnapshot {
  const stored = settingsStore().get("shellPath");
  const path = typeof stored === "string" ? stored : defaultShellPathForPlatform(process.platform);
  return { path, configured: typeof stored === "string", kind: shellKindForPath(path, process.platform) };
}

export async function checkConfiguredShell(): Promise<ShellCheckResult> {
  return checkShellOnce(getConfiguredShellSettings().path);
}

export async function checkAndSaveConfiguredShell(candidate: unknown): Promise<ShellCheckResult> {
  const result = await checkShellOnce(candidate);
  if (result.usable) settingsStore().set("shellPath", result.path);
  return result;
}

async function checkShellOnce(candidate: unknown): Promise<ShellCheckResult> {
  let key: string;
  try {
    key = validateShellPath(candidate);
  } catch {
    return checkShellExecutable(candidate);
  }
  const running = activeShellChecks.get(key);
  if (running) return running;
  const check = checkShellExecutable(key).finally(() => activeShellChecks.delete(key));
  activeShellChecks.set(key, check);
  return check;
}

export async function runConfiguredShellCommand(
  command: ShellCommand,
  options: ShellCommandOptions = {},
): Promise<ProcessOutput> {
  return runShellCommand(getConfiguredShellSettings().path, command, options);
}

export async function runShellCommand(
  shellPath: unknown,
  command: ShellCommand,
  options: ShellCommandOptions = {},
  dependencies: ShellRuntimeDependencies = defaultDependencies,
): Promise<ProcessOutput> {
  const normalizedPath = validateShellPath(shellPath, dependencies.platform);
  const kind = shellKindForPath(normalizedPath, dependencies.platform);
  const resolvedCommand = resolveShellCommand(command, kind);
  await assertExecutableFile(normalizedPath, dependencies);
  return dependencies.executeFile(normalizedPath, shellArguments(kind, resolvedCommand), options);
}

export async function checkShellExecutable(
  candidate: unknown,
  dependencies: ShellRuntimeDependencies = defaultDependencies,
): Promise<ShellCheckResult> {
  const checkedAt = new Date().toISOString();
  let normalizedPath: string;
  let kind: ShellKind;
  try {
    normalizedPath = validateShellPath(candidate, dependencies.platform);
    kind = shellKindForPath(normalizedPath, dependencies.platform);
  } catch (error) {
    return {
      path: typeof candidate === "string" ? candidate.trim() : "",
      status: "invalid",
      usable: false,
      message: error instanceof Error ? error.message : "Shell 路径无效。",
      checkedAt,
    };
  }

  try {
    await assertExecutableFile(normalizedPath, dependencies);
  } catch (error) {
    return {
      path: normalizedPath,
      kind,
      status: errorCode(error) === "ENOENT" ? "missing" : "unusable",
      usable: false,
      message: errorCode(error) === "ENOENT" ? "未找到该 Shell 文件。" : "该路径不是可执行的普通文件。",
      checkedAt,
    };
  }

  try {
    const result = await dependencies.executeFile(normalizedPath, shellArguments(kind, SHELL_PROBE_COMMAND[kind]), {
      timeoutMs: DEFAULT_TIMEOUT_MS,
      maximumOutputBytes: DEFAULT_MAXIMUM_OUTPUT_BYTES,
    });
    const match = result.stdout.match(new RegExp(`${SHELL_READY_MARKER}:([^\\r\\n]+)`));
    if (!match) {
      return {
        path: normalizedPath,
        kind,
        status: "unusable",
        usable: false,
        message: "Shell 未通过兼容性检测。",
        checkedAt,
      };
    }
    return {
      path: normalizedPath,
      kind,
      status: "ready",
      usable: true,
      message: "Shell 可用，已设为应用统一 Shell。",
      checkedAt,
      version: match[1] === "unknown" ? undefined : match[1],
    };
  } catch (error) {
    const code = errorCode(error);
    const timedOut = isRecord(error) && (error.killed === true || error.signal === "SIGTERM" || error.signal === "SIGKILL");
    const outputLimit = code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
    return {
      path: normalizedPath,
      kind,
      status: outputLimit ? "output-limit" : timedOut ? "timeout" : code === "ENOENT" ? "missing" : "unusable",
      usable: false,
      message: outputLimit
        ? "Shell 检测输出超过安全上限。"
        : timedOut
          ? "Shell 检测超时。"
          : code === "ENOENT"
            ? "未找到该 Shell 文件。"
            : "Shell 无法执行固定检测命令，请检查安装或选择其他 Bash/PowerShell。",
      checkedAt,
    };
  }
}

export function validateShellPath(candidate: unknown, platform: NodeJS.Platform = process.platform): string {
  if (typeof candidate !== "string") throw new Error("Shell 路径必须是字符串。");
  const value = candidate.trim();
  if (!value) throw new Error("Shell 路径不能为空。");
  if (value.length > 2_048) throw new Error("Shell 路径长度超过上限。");
  if (/[\0\r\n\u0001-\u001f]/.test(value)) throw new Error("Shell 路径包含非法控制字符。");
  const pathApi = platform === "win32" ? win32 : posix;
  if (!pathApi.isAbsolute(value)) throw new Error("Shell 路径必须是绝对路径。");
  if (platform === "win32" && (/^(?:\\\\|\/\/)/.test(value) || /^\\\\[?.]\\/.test(value))) {
    throw new Error("Shell 路径不能使用网络路径或设备路径。");
  }
  shellKindForPath(value, platform);
  return pathApi.normalize(value);
}

export function shellKindForPath(path: string, platform: NodeJS.Platform = process.platform): ShellKind {
  const filename = (platform === "win32" ? win32 : posix).basename(path).toLowerCase();
  if (filename === "bash" || filename === "bash.exe") return "bash";
  if (filename === "pwsh" || filename === "pwsh.exe" || filename === "powershell" || filename === "powershell.exe") {
    return "powershell";
  }
  throw new Error("当前版本仅支持 Bash、Windows PowerShell 和 PowerShell 7。");
}

function resolveShellCommand(command: ShellCommand, kind: ShellKind): string {
  const value = typeof command === "string" ? command : command[kind];
  if (typeof value !== "string" || !value.trim() || value.length > 16_384 || value.includes("\0")) {
    throw new Error("Shell 命令无效。");
  }
  return value;
}

function shellArguments(kind: ShellKind, command: string): string[] {
  return kind === "bash"
    ? ["-lc", command]
    : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command];
}

async function assertExecutableFile(path: string, dependencies: ShellRuntimeDependencies): Promise<void> {
  const info = await dependencies.statFile(path);
  if (!info.isFile()) throw Object.assign(new Error("Shell 路径不是普通文件。"), { code: "EINVAL" });
  await dependencies.accessFile(path, dependencies.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
}

function executeFileBounded(
  path: string,
  args: readonly string[],
  options: ShellCommandOptions,
): Promise<ProcessOutput> {
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES;
  const environment = { ...process.env };
  delete environment.OPENAI_API_KEY;
  delete environment.BASH_ENV;
  delete environment.ENV;
  delete environment.PROMPT_COMMAND;
  return new Promise((resolve, reject) => {
    execFile(path, [...args], {
      cwd: homedir(),
      encoding: "utf8",
      env: environment,
      killSignal: "SIGTERM",
      maxBuffer,
      shell: false,
      timeout,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

function errorCode(error: unknown): string | number | undefined {
  return isRecord(error) && (typeof error.code === "string" || typeof error.code === "number") ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
