# 🎹 M Agent

![Version](https://img.shields.io/badge/version-0.4.0-2b8a3e)
![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-4a9eda)
![Electron](https://img.shields.io/badge/Electron-43-47848f)
![React](https://img.shields.io/badge/React-19-61dafb)
![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6)
![Status](https://img.shields.io/badge/Status-Private-8a6d3b)

**[中文](README.md) · [English](README.en.md)**

> A desktop MIDI composing agent for indie game developers. It brings multi-track piano roll, non-destructive MIDI editing, and three permission-constrained Agent working modes into a single project.

## 📸 Preview

<!-- TODO: insert a screenshot of the app here (e.g. docs/screenshots/main.png) -->

<div align="center" style="border:1px dashed #3a4040;border-radius:8px;padding:48px;color:#6a706d;background:#16191a;">
  Screenshot pending
</div>

## ✨ Highlights

- **🎼 Multi-track MIDI editing**
  - Multi-track MIDI projects with the `.magent` project file format
  - Standard MIDI File import and export
  - Piano roll editing, playback, looping, undo and redo
- **🤖 Agent working modes**
  - Research, plan, and goal modes with candidate diff preview; changes are applied only after user confirmation
  - Bundled Pi Agent Core runtime — no global `pi` installation required
  - Falls back to the Pi faux Provider for offline demos when there is no online authentication
- **🎛 Provider management**
  - Startup environment diagnostics, plus provider management via subscription profiles: import from Pi / CC Switch, create new, or add from presets
  - Supports four API types: OpenAI Completions / Responses, Anthropic Messages, and Google Generative AI
- **⚙️ Settings center**
  - Five sections: General, Providers, Usage, Instruments, and Plugins
  - Collapsible theme list (Default, Nord, Tokyo Night, Warm Paper, High Contrast) with dark, light, and system modes
- **🎚 Instrument system**
  - Lightweight preview: import SoundFont (.sf2/.sf3) and assign sounds to tracks, with per-track volume
  - SFZ is registered only; VST3 is not yet wired up (see [IMPLEMENTED.md](doc/IMPLEMENTED.md))
- **🛡 Security**
  - Unified Shell configuration in the main process, with browsing, detection, and startup warnings for Bash, Windows PowerShell, and PowerShell 7

## 🚀 Quick start

```powershell
npm install
npm run dev
```

Tests and build:

```powershell
npm test
npm run build
npm run test:electron
```

`test:electron` launches the built desktop app and runs one environment diagnostic plus a Pi offline research pass through the real preload/IPC chain, then closes automatically.

## 📦 Packaging

```powershell
npm run package:win
npm run package:mac
npm run package:linux
```

Platform icons come from `build/icon.ico`, `build/icon.icns`, and `build/icons/`. macOS installers should be built on macOS; Linux installers are best built on Linux or a matching CI environment.

The installed app does not depend on a local `npm` or a global `pi` CLI; both are only used in source development or external Pi workflows. The installed build will not execute a `pi` command from `PATH`. On startup it checks the bundled Node, the bundled Pi SDK, dev-environment npm, secure storage, and provider authentication; without online authentication a red configuration notice appears at the top, but offline demos still work.

The app never writes API keys or OAuth tokens into project files or Renderer storage. Providers are managed as subscription profiles: metadata is stored locally and API keys are saved using Electron's system encryption. Subscriptions can be imported (read-only, without rewriting external files) from the standard Pi login file or the local CC Switch database, and `OPENAI_API_KEY` is honored. Without online authentication it automatically falls back to the offline demo generator.

## 🔐 Security model

| Mode | Permission | Description |
| --- | --- | --- |
| `research` | Read-only | Analysis only; write operations are rejected at the permission layer |
| `plan` | Preview | Can form structured edits and diff previews, but cannot apply them |
| `goal` | Candidates | Generates candidates within a limited budget; still needs user confirmation before writing to the project |

M Agent never lets the model rewrite MIDI binaries directly. All model calls are executed by Pi Agent Core in the Electron main process; Pi can only call the mode-authorized tools for reading, analysis, and candidate submission. Every change must be converted into Schema-validated domain operations, then applied as a single undoable transaction after user confirmation.

## 📚 Documentation

Environment detection, authentication sources, priority, and current limitations are described in [OVERVIEW](doc/OVERVIEW.md), [IMPLEMENTED](doc/IMPLEMENTED.md), and [INCOMPLETE](doc/INCOMPLETE.md).
