# 换机续接指南（CONTINUATION）

> 用途：在另一台电脑上继续 M/agent 开发时，按本文档恢复环境并接着未完成的计划。
> 基线提交：`adec0cb`（feat: 轻量音源系统）

## 1. 环境准备（新电脑）

```powershell
git clone https://github.com/m1em1e/M-agent.git
cd M-agent
npm install
npm run typecheck
npm test
npm run build
```

- Node 版本：仓库 CI 前建议 ≥ 22.19（Pi 内核要求；本机开发用 24.x 通过）。
- Electron 37.10.3 会由 `npm install` 拉取；`package:win` 依赖
  `node_modules/electron/dist`（本机曾因下载/解包失败改用 `--config.electronDist`）。
- 换机后若本地无 `~/.pi/agent/auth.json` 或 `~/.cc-switch/cc-switch.db`，
  供应商「导入已有」会安静地返回 0 个结果（预期行为，不阻塞）。

## 2. 仓库结构速览

- `src/main/`：Electron 主进程（窗口、IPC、环境诊断、订阅、用量、Shell、音源库）
- `src/preload/`：白名单 IPC 桥
- `src/renderer/`：React UI（钢琴卷帘、轨道、设置五板块、菜单栏）
- `src/core/`：纯逻辑（midi 数据/编辑、agent pi-kernel、audio 抽象）
- `src/shared/`：跨进程类型契约（midi / bridge / instrument / subscriptions 等）
- `doc/`：设计、进展、待办、音源状态、认证、提示词
- `tests/`：vitest 单测（22 文件 / 100 用例）

## 3. 未完成计划与下一步入口

按优先级列出，每项都给出**入口文件**和**验证方式**。

### 3.1 SFZ 采样实现（未完成，推荐先做）
现状：`addInstrument("sfz", ...)` 只登记路径与 `presetName`（
`src/main/audio/library-store.ts` 的 `sfzPresetName`），**没有**解析和发声。

入口：
- 解析器：`src/main/soundfont-parser.ts`（现只处理 SF2，可加 `parseSfz` 返回区域映射）
- 引擎：`src/renderer/audio/` 下新增 `sfz-engine.ts`，实现 `Instrument` 接口
- 路由：`src/renderer/audio/audio-engine.ts` 的 `noteOn` 增加 sfz 分支
- 数据流：`src/shared/instrument.ts` 的 `InstrumentReference` 已有 `sfz` 分支

调研结论（已确认，勿重复调研）：
- **没有**维护良好的「直接播放 .sfz」的 Web 库。两个可行路线：
  - A：自研 ~100 行解析器（覆盖 `sample/key/lokey/hikey/velocity/lovel/hivel/tuning/volume/pan/envelope`），
    用 `smplr` `Sampler`（MIT、活跃、TS）驱动，或 Tone.js `Sampler`。
  - B：离线用 Polyphone 把 SFZ 转 SF2，统一走 SpessaSynth（省事，但丢 SFZ 原生编辑）。
- 可参考 `sfz-parser`（MIT，解析用，2020 后未维护）或 `@sfz-tools/core`（CC0，维护中）。
- 采样音频解码用 Chromium 内置 `decodeAudioData`（WAV/FLAC/OGG 均可）。

验证：导入 SFZ → 轨道选择器出现 SFZ 音色 → 试听发声；单测解析器区域映射。

### 3.2 音源库体验完善（P2）
- 设置 → 音源 页（`src/renderer/App.tsx` 的 `settingsSection === "sound"`）无搜索；
  轨道选择器平铺全部 preset，大型音源库下拉很长。可加 `presetSearch` 过滤（复用供应商预设搜索模式）。
- 音源库文件路径变更后工程引用失效：可加「路径失效提示」或「库条目缺失时轨道回退振荡器并提示」。

### 3.3 VST3（未接入，暂缓）
结论（已调研，勿重复）：`nvst3-host`（npm）当前不适合生产——
约 1 月龄、1 star、无 Release、**无进程隔离**（插件 DLL 直接进宿主进程，segfault 拖垮整个应用）、
**无音频设备 I/O**、Intel Mac（darwin-x64）无预编译、Linux 需 glibc≥2.28。
替代方向（若日后要做）：
- 独立原生音频服务（JUCE `AudioProcessorGraph` 或 Rust `rack`），Electron 只做 UI，走本地 socket/IPC。
- 或先做 PoC：纯 Node 里用 nvst3-host 验证扫描/加载/State 往返后再决定。
当前 M/agent 定位轻量试听，高级处理由用户导出 MIDI 到专业 DAW 完成，不建议近期投入。

### 3.4 Agent 音源集成（原计划 Phase 4）
现状：`src/core/agent/permissions.ts` 无音源工具；Agent 只能分析/提议 MIDI 操作。
若要「把第三轨换成 Rhodes」：
- `permissions.ts` 增加工具集（如 `instrument.search`、`track.set-instrument`），三模式授权。
- `src/core/agent/pi-kernel.ts` 的 `createTools` 注册对应工具，走 `AgentToolExecutor` 权限校验。
- 工程注入上下文（`AGENT_CONTEXT_PROMPT.ts` 与 `buildProjectContext`）增加音源摘要。
- 验证：单测权限 + 离线假模型对话。

### 3.5 播放调度（P2，可选）
当前 rAF 驱动逐音符触发（`src/renderer/App.tsx` 的播放 `useEffect`）。
轻量试听够用；若要采样级精确，改用 AudioContext 时钟调度。非紧急。

## 4. 已知环境问题（非代码缺陷）

- `npm run test:electron` 的 smoke 中 `shellAlertJump:false` 是本机 shell 探针报
  「missing」导致（本机 `bash.exe` 不可用）；在 shell 可用的机器上应通过。
- smoke 已改为通过「帮助 → 设置」菜单打开设置面板（原 `aria-label="设置"` 按钮已移除）。

## 5. 换机后建议的首次动作

1. `npm run typecheck && npm test && npm run build` 确认基线干净。
2. 在「音源」设置导入一个真实 `.sf2`，验证 SoundFont 试听（换机后这是最快的手工冒烟）。
3. 接着 3.1 SFZ，或按你的优先级挑一项。

## 6. 关键文档索引

- 音源系统完成/未完成清单：`doc/INSTRUMENTS.md`
- 全局待办与已知问题：`doc/TODO.md`
- 项目路线与阶段：`doc/PLAN.md`
- 当前进展：`doc/PROGRESS.md`
- 认证/供应商：`doc/ENVIRONMENT_AND_AUTH.md`
- Agent 提示词（对话注入）：`doc/AGENT_CONTEXT_PROMPT.md`
