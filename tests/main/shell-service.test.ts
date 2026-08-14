import { describe, expect, it, vi } from "vitest";
import { checkShellExecutable, runShellCommand, shellKindForPath, validateShellPath } from "../../src/main/shell-service";

const windowsPath = "C:\\Tools\\Git\\bin\\bash.exe";

function dependencies(overrides: Partial<Parameters<typeof checkShellExecutable>[1]> = {}) {
  return {
    platform: "win32" as const,
    statFile: vi.fn(async () => ({ isFile: () => true })),
    accessFile: vi.fn(async () => undefined),
    executeFile: vi.fn(async () => ({ stdout: "M_AGENT_SHELL_READY_V1:5.2.37\n", stderr: "" })),
    ...overrides,
  };
}

describe("shell service", () => {
  it("accepts absolute local Bash and PowerShell executable paths", () => {
    expect(validateShellPath(`  ${windowsPath}  `, "win32")).toBe(windowsPath);
    expect(shellKindForPath("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", "win32")).toBe("powershell");
    expect(shellKindForPath("C:\\Program Files\\PowerShell\\7\\pwsh.exe", "win32")).toBe("powershell");
    expect(() => validateShellPath("bash.exe", "win32")).toThrow(/绝对路径/);
    expect(() => validateShellPath("\\\\server\\share\\bash.exe", "win32")).toThrow(/网络路径/);
    expect(() => validateShellPath("C:\\Windows\\System32\\cmd.exe", "win32")).toThrow(/仅支持 Bash.*PowerShell/);
    expect(() => validateShellPath("C:\\bad\npath\\bash.exe", "win32")).toThrow(/控制字符/);
  });

  it("runs a fixed Bash compatibility probe and reports its version", async () => {
    const deps = dependencies();
    const result = await checkShellExecutable(windowsPath, deps);
    expect(result).toMatchObject({ usable: true, status: "ready", version: "5.2.37", path: windowsPath });
    expect(deps.executeFile).toHaveBeenCalledWith(windowsPath, ["-lc", expect.stringContaining("M_AGENT_SHELL_READY_V1")], {
      timeoutMs: 5_000,
      maximumOutputBytes: 65_536,
    });
  });

  it("does not accept a process that cannot prove Bash compatibility", async () => {
    const result = await checkShellExecutable(windowsPath, dependencies({
      executeFile: vi.fn(async () => ({ stdout: "unexpected", stderr: "" })),
    }));
    expect(result).toMatchObject({ usable: false, status: "unusable" });
  });

  it("distinguishes missing files and timeouts without exposing process output", async () => {
    const missing = Object.assign(new Error("not found"), { code: "ENOENT" });
    const missingResult = await checkShellExecutable(windowsPath, dependencies({
      statFile: vi.fn(async () => { throw missing; }),
    }));
    expect(missingResult).toMatchObject({ usable: false, status: "missing", message: "未找到该 Shell 文件。" });

    const timedOut = Object.assign(new Error("timed out secret-output"), { killed: true, signal: "SIGTERM" });
    const timeoutResult = await checkShellExecutable(windowsPath, dependencies({
      executeFile: vi.fn(async () => { throw timedOut; }),
    }));
    expect(timeoutResult).toMatchObject({ usable: false, status: "timeout", message: "Shell 检测超时。" });
    expect(JSON.stringify(timeoutResult)).not.toContain("secret-output");
  });

  it("uses the configured executable with -lc and never a process shell", async () => {
    const deps = dependencies();
    const result = await runShellCommand(windowsPath, "npm --version", { timeoutMs: 3_000 }, deps);
    expect(result.stdout).toContain("M_AGENT_SHELL_READY_V1");
    expect(deps.executeFile).toHaveBeenCalledWith(windowsPath, ["-lc", "npm --version"], { timeoutMs: 3_000 });
  });

  it("uses the fixed non-interactive PowerShell protocol", async () => {
    const powershellPath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
    const deps = dependencies({
      executeFile: vi.fn(async () => ({ stdout: "M_AGENT_SHELL_READY_V1:5.1.26100.4652\n", stderr: "" })),
    });
    const result = await checkShellExecutable(powershellPath, deps);
    expect(result).toMatchObject({ usable: true, kind: "powershell", version: "5.1.26100.4652" });
    expect(deps.executeFile).toHaveBeenCalledWith(powershellPath, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", expect.stringContaining("$PSVersionTable"),
    ], { timeoutMs: 5_000, maximumOutputBytes: 65_536 });
  });
});
