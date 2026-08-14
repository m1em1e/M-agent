import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import electronPath from "electron";

const projectRoot = resolve(import.meta.dirname, "..");
const port = await availablePort();
const userDataDir = await mkdtemp(join(tmpdir(), "magent-electron-smoke-"));
const packagedExecutable = process.env.MAGENT_SMOKE_EXECUTABLE?.trim();
const output = [];
const errors = [];
const electron = spawn(packagedExecutable || electronPath, [
  ...(packagedExecutable ? [] : ["."]),
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${userDataDir}`,
  "--no-first-run",
], {
  cwd: projectRoot,
  env: { ...process.env, MAGENT_FORCE_OFFLINE: "1" },
  stdio: ["ignore", "pipe", "pipe"],
  windowsHide: true,
});
electron.stdout.on("data", (chunk) => output.push(chunk.toString()));
electron.stderr.on("data", (chunk) => errors.push(chunk.toString()));

try {
  const page = await pageTarget(port, 20_000);
  const value = await evaluate(page.webSocketDebuggerUrl, `(async () => {
    const deadline = Date.now() + 10000;
    while ((typeof window.magent?.runAgent !== "function"
      || typeof window.magent?.getStartupEnvironment !== "function"
      || typeof window.magent?.getShellSettings !== "function"
      || typeof window.magent?.browseShell !== "function"
      || typeof window.magent?.checkShell !== "function"
      || !document.getElementById("root")?.childElementCount) && Date.now() < deadline) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
    const bridgeType = typeof window.magent?.runAgent;
    const environment = await window.magent.getStartupEnvironment();
    const shellBridgeTypes = {
      get: typeof window.magent?.getShellSettings,
      browse: typeof window.magent?.browseShell,
      check: typeof window.magent?.checkShell
    };
    const shellSettings = await window.magent.getShellSettings();
    const invalidShellPath = navigator.userAgent.includes('Windows')
      ? 'C:\\\\__magent_missing_shell__\\\\bash.exe'
      : '/__magent_missing_shell__/bash';
    const invalidShellCheck = await window.magent.checkShell(invalidShellPath);
    const shellSettingsAfterInvalidCheck = await window.magent.getShellSettings();
    const shellIssue = environment.issues.some((issue) => issue.action === 'open-shell-settings');
    const shellAlertButton = [...document.querySelectorAll('.environment-alert-actions button')]
      .find((button) => button.textContent?.trim() === '配置 Shell');
    let shellAlertJump = !shellIssue && !shellAlertButton;
    if (shellIssue && shellAlertButton) {
      shellAlertButton.click();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 80));
      shellAlertJump = document.getElementById('settings-title')?.textContent === '通用'
        && document.activeElement?.matches('[data-shell-setting="path"]') === true;
      document.querySelector('.modal-close')?.click();
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    }
    const settingsButton = document.querySelector('button[aria-label="设置"]');
    settingsButton?.click();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    const settingsSections = [...document.querySelectorAll('.settings-sidebar nav button')].map((button) => button.textContent?.trim());
    const appearanceHeading = document.querySelector('.appearance-settings .settings-group-heading strong')?.textContent;
    const generalGroupHeadings = [...document.querySelectorAll('.settings-pane .settings-group-heading strong')].map((element) => element.textContent?.trim());
    const conversationDefaults = {
      showThinking: document.querySelector('[data-conversation-setting="show-thinking"]')?.getAttribute('aria-checked'),
      thinkingLevel: document.querySelector('[data-conversation-setting="thinking-level"]')?.value,
      goalMaxTurns: document.querySelector('[data-conversation-setting="goal-max-turns"]')?.value,
      goalMaxTokens: document.querySelector('[data-conversation-setting="goal-max-tokens"]')?.value
    };
    const shellPathInput = document.querySelector('[data-shell-setting="path"]')?.value;
    const shellBrowseButton = Boolean(document.querySelector('[data-shell-action="browse"]'));
    const shellDetectButton = Boolean(document.querySelector('[data-shell-action="detect"]'));
    const themeCollapsedInitially = !document.getElementById('theme-preset-list');
    const themeToggle = document.querySelector('.theme-list-toggle');
    themeToggle?.click();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    const themeExpanded = themeToggle?.getAttribute('aria-expanded') === 'true' && Boolean(document.getElementById('theme-preset-list'));
    const themeLabels = [...document.querySelectorAll('#theme-preset-list .theme-preset-copy strong')].map((element) => element.textContent?.trim());
    document.querySelector('[data-theme-id="warn-paper"]')?.click();
    document.querySelector('[data-appearance-mode="theme"]')?.click();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    const appearanceState = {
      theme: document.documentElement.dataset.theme,
      mode: document.documentElement.dataset.appearanceMode,
      colorMode: document.documentElement.dataset.colorMode,
      background: getComputedStyle(document.documentElement).getPropertyValue('--bg').trim(),
      stored: JSON.parse(localStorage.getItem('magent.appearance.v1') ?? 'null')
    };
    const workspace = document.querySelector('.workspace');
    const tracksSeparator = document.querySelector('[role="separator"][aria-controls="tracks-panel"]');
    const agentSeparator = document.querySelector('[role="separator"][aria-controls="agent-panel"]');
    const tracksWidthBefore = Number.parseInt(workspace?.style.getPropertyValue('--tracks-width') ?? '0', 10);
    tracksSeparator?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    agentSeparator?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    const tracksWidthAfter = Number.parseInt(workspace?.style.getPropertyValue('--tracks-width') ?? '0', 10);
    const toggleAgent = document.querySelector('.agent-panel-toggle');
    toggleAgent?.click();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    const agentHidden = workspace?.classList.contains('agent-hidden') === true
      && document.getElementById('agent-panel')?.hidden === true
      && toggleAgent?.getAttribute('aria-expanded') === 'false';
    toggleAgent?.click();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    const agentRestored = workspace?.classList.contains('agent-hidden') === false
      && document.getElementById('agent-panel')?.hidden === false
      && toggleAgent?.getAttribute('aria-expanded') === 'true';
    const workspaceLayoutStored = JSON.parse(localStorage.getItem('magent.workspace-layout.v1') ?? 'null');
    themeToggle?.click();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    const themeCollapsedAfterToggle = themeToggle?.getAttribute('aria-expanded') === 'false' && !document.getElementById('theme-preset-list');
    const pluginsButton = [...document.querySelectorAll('.settings-sidebar nav button')].find((button) => button.textContent?.trim() === '插件');
    pluginsButton?.click();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 20));
    const settingsTitle = document.getElementById('settings-title')?.textContent;
    document.querySelector('.modal-close')?.click();
    const result = await window.magent.runAgent({
      mode: "research",
      objective: "Analyze this smoke-test MIDI loop without modifying it.",
      conversation: { showThinking: true, thinkingLevel: "medium", goalMaxTurns: 20, goalMaxTokens: 500000 },
      project: {
        title: "Electron Smoke",
        ppq: 480,
        tempo: 120,
        tracks: [{
          id: "melody",
          name: "Melody",
          role: "melody",
          channel: 0,
          program: 1,
          muted: false,
          solo: false,
          notes: [{ id: "n1", pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 }]
        }]
      }
    });
    return {
      title: document.title,
      rootChildren: document.getElementById("root")?.childElementCount ?? 0,
      bridgeType,
      kernel: result.kernel,
      provider: result.provider,
      candidateCount: result.candidates.length,
      analysisLength: result.analysis.length,
      environmentSchema: environment.schemaVersion,
      piCoreStatus: environment.checks.find((check) => check.id === "pi-core")?.status,
      shellCheckStatus: environment.checks.find((check) => check.id === "shell")?.status,
      shellBridgeTypes,
      shellSettings,
      invalidShellCheck,
      shellSettingsAfterInvalidCheck,
      shellAlertJump,
      settingsSections,
      settingsTitle,
      appearanceHeading,
      generalGroupHeadings,
      conversationDefaults,
      conversationStored: JSON.parse(localStorage.getItem('magent.conversation.v1') ?? 'null'),
      shellPathInput,
      shellBrowseButton,
      shellDetectButton,
      legacyShellStored: localStorage.getItem('magent.shell.v1'),
      thinkingCount: result.thinking.length,
      effectiveThinkingLevel: result.effectiveThinkingLevel,
      themeCollapsedInitially,
      themeExpanded,
      themeCollapsedAfterToggle,
      themeLabels,
      appearanceState,
      separatorCount: document.querySelectorAll('[role="separator"]').length,
      tracksWidthBefore,
      tracksWidthAfter,
      agentHidden,
      agentRestored,
      workspaceLayoutStored
    };
  })()`);
  if (value.title !== "Ruins After Rain · M Agent" || value.rootChildren < 1 || value.bridgeType !== "function"
    || value.kernel !== "pi" || value.provider !== "pi-offline"
    || value.candidateCount !== 0 || value.analysisLength < 1
    || value.environmentSchema !== 1 || value.piCoreStatus !== "ready"
    || !["ready", "missing"].includes(value.shellCheckStatus)
    || value.shellBridgeTypes.get !== "function"
    || value.shellBridgeTypes.browse !== "function"
    || value.shellBridgeTypes.check !== "function"
    || typeof value.shellSettings?.path !== "string" || !value.shellSettings.path
    || value.invalidShellCheck?.usable !== false
    || value.invalidShellCheck?.status !== "missing"
    || value.shellSettingsAfterInvalidCheck?.path !== value.shellSettings.path
    || value.shellSettingsAfterInvalidCheck?.configured !== value.shellSettings.configured
    || !value.shellAlertJump
    || JSON.stringify(value.settingsSections) !== JSON.stringify(["通用", "供应商", "用量", "音源", "插件"])
    || value.settingsTitle !== "插件"
    || value.appearanceHeading !== "外观"
    || value.generalGroupHeadings[0] !== "外观"
    || value.generalGroupHeadings[1] !== "对话"
    || value.generalGroupHeadings[2] !== "Shell 路径"
    || value.conversationDefaults.showThinking !== "true"
    || value.conversationDefaults.thinkingLevel !== "medium"
    || value.conversationDefaults.goalMaxTurns !== "20"
    || value.conversationDefaults.goalMaxTokens !== "500000"
    || value.conversationStored?.showThinking !== true
    || value.conversationStored?.thinkingLevel !== "medium"
    || value.conversationStored?.goalMaxTurns !== 20
    || value.conversationStored?.goalMaxTokens !== 500000
    || value.shellPathInput !== value.shellSettings.path
    || !value.shellBrowseButton || !value.shellDetectButton
    || value.legacyShellStored !== null
    || value.thinkingCount !== 1
    || value.effectiveThinkingLevel !== "medium"
    || !value.themeCollapsedInitially
    || !value.themeExpanded
    || !value.themeCollapsedAfterToggle
    || JSON.stringify(value.themeLabels) !== JSON.stringify(["默认", "Nord", "Tokyo Night", "Warn Paper", "High Contrast"])
    || value.appearanceState.theme !== "warn-paper"
    || value.appearanceState.mode !== "theme"
    || value.appearanceState.colorMode !== "light"
    || value.appearanceState.background.toLowerCase() !== "#e8dcc7"
    || value.appearanceState.stored?.theme !== "warn-paper"
    || value.appearanceState.stored?.mode !== "theme"
    || value.separatorCount !== 2
    || value.tracksWidthAfter !== value.tracksWidthBefore + 8
    || !value.agentHidden
    || !value.agentRestored
    || value.workspaceLayoutStored?.tracksWidth !== value.tracksWidthAfter
    || value.workspaceLayoutStored?.agentHidden !== false) {
    throw new Error(`Unexpected smoke result: ${JSON.stringify(value)}`);
  }
  console.log(JSON.stringify(value));
} catch (error) {
  const diagnostics = [...output, ...errors].join("").trim();
  if (diagnostics) console.error(diagnostics);
  throw error;
} finally {
  electron.kill();
  await Promise.race([
    new Promise((complete) => electron.once("exit", complete)),
    new Promise((complete) => setTimeout(complete, 5_000)),
  ]);
  await rm(userDataDir, { recursive: true, force: true });
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a debugging port.");
  await new Promise((resolveClose) => server.close(resolveClose));
  return address.port;
}

async function pageTarget(debugPort, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (electron.exitCode !== null) throw new Error(`Electron exited early with code ${electron.exitCode}.`);
    try {
      const response = await fetch(`http://127.0.0.1:${debugPort}/json/list`);
      const targets = await response.json();
      const page = targets.find((target) => target.type === "page" && target.url.startsWith("file:"));
      if (page) return page;
    } catch {
      // The debugging endpoint is unavailable while Electron is starting.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }
  throw new Error("Electron page did not become ready before the smoke-test timeout.");
}

async function evaluate(webSocketUrl, expression) {
  return new Promise((resolveValue, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Electron evaluation timed out."));
    }, 20_000);
    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.exception?.description ?? "Electron evaluation failed."));
      } else {
        resolveValue(message.result?.result?.value);
      }
    });
    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("Could not connect to Electron's debugging endpoint."));
    });
  });
}
