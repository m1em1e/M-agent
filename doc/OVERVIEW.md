# M Agent 项目介绍与说明

> 本文件汇总原 `PLAN.md`（产品目标/技术方案/验收标准）与 `CONTINUATION.md`（换机续接）
> 中的项目介绍性内容，作为项目总览入口。
> 功能实现清单见 [IMPLEMENTED.md](IMPLEMENTED.md)；尚未完成与已知限制见 [INCOMPLETE.md](INCOMPLETE.md)。

## 1. 产品目标

M Agent 是面向独立游戏音乐创作者的桌面 MIDI Agent 应用，把以下能力放进同一工作流：

- 多轨 MIDI 工程管理与 Standard MIDI File 导入、导出。
- 钢琴卷帘中的音符创建、选择、移动、缩放、删除和力度编辑。
- Agent 对工程进行分析，并生成结构化、可校验、可撤销的 MIDI 修改。
- `research`、`plan`、`goal` 三种受权限约束的工作模式。
- Agent 不直接操作文件系统或覆盖 MIDI 二进制；所有修改先形成候选，再由用户确认并作为事务应用。

## 2. 技术栈与运行链路

当前技术栈：

- 桌面外壳：Electron 43.4.0（内置 Node 24.18.1）。
- 界面：React 19、TypeScript、Vite。
- Agent 内核：`@earendil-works/pi-agent-core` 0.84.1 与 `@earendil-works/pi-ai` 0.84.1。
- 测试：Vitest。发布：electron-builder（Windows NSIS / macOS DMG+zip / Linux AppImage）。

运行链路：

```text
React Renderer
  -> sandboxed CommonJS preload（.cts -> .cjs，白名单 IPC）
  -> Electron IPC
  -> main agent service
  -> Pi Agent kernel（pi-kernel）
  -> 只读分析工具 / 结构化候选工具
  -> Schema 与 MIDI 领域校验
  -> 用户确认
  -> 单个可撤销事务
```

## 3. 模式与权限模型

| 模式 | 权限 | 说明 |
| --- | --- | --- |
| `research` | 只读 | 只允许 inspect / analyze，不注册候选工具并在权限层再次拦截越权 |
| `plan` | 可提候选 | 生成经校验的修改方案供预览，不得应用 |
| `goal` | 预算内候选 | 在轮次/Token 预算内生成 1–3 个候选，仍需用户确认才能应用 |

任何模式下 Agent 都不能：应用修改、写文件、导出文件、执行 Shell。音源引用必须来自
`instrument_search` 结果，不得编造 libraryId/bank/program。

## 4. 安全边界

- 所有认证与订阅操作只在 Electron 主进程执行；preload 只暴露严格白名单 IPC。
- Renderer 不保存、不读取、不记录任何凭据；订阅摘要只含「是否已配置 Key」的布尔值。
- API Key / OAuth Token 经 Electron `safeStorage` 加密，不下发 Renderer，不写入 `.magent` 或 MIDI 文件。
- IPC 校验 Agent 模式、目标长度与 MIDI 工程结构；打开文件前限制文件大小。
- 禁止未授权页面导航及新窗口；每个窗口同一时间只允许一个 OAuth 登录和一个 Agent 请求。
- 生产 CSP 使用 `wasm-unsafe-eval`（SpessaSynth 需要）；开发用 `ws://127.0.0.1:5173` 待收紧。

## 5. 仓库结构

- `src/main/`：Electron 主进程（窗口、IPC、环境诊断、订阅、用量、Shell、两级音源库、macOS 原生菜单、最近项目）。
- `src/preload/`：白名单 IPC 桥（.cts 编译为 sandbox 可加载的 .cjs）。
- `src/renderer/`：React UI（钢琴卷帘、轨道、设置五板块、Agent 面板、音源栏）。
- `src/core/`：纯逻辑（midi 数据/编辑、agent pi-kernel、skills、audio 抽象、sfz-parser）。
- `src/shared/`：跨进程类型契约（midi / bridge / instrument / menu / subscriptions 等）。
- `skills/`：4 份内置 SKILL.md（打包经 `extraResources` 放入 `resources/skills`）。
- `tests/`：Vitest 单元/集成测试。
- `doc/`：总览、已实现、未完成与音频导出计划。

## 6. 环境准备（新电脑续接）

```powershell
git clone https://github.com/m1em1e/M-agent.git
cd M-agent
npm install
npm run typecheck
npm test
npm run build
```

- Node 版本：仓库 CI 前建议 ≥ 22.19（Pi 内核要求；开发用 24.x 通过）。
- Electron 43.4.0 由 `npm install` 拉取二进制；若 GitHub 直连失败，用
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/` 重跑 `node node_modules/electron/install.js`。
- 换机后若本地无 `~/.pi/agent/auth.json` 或 `~/.cc-switch/cc-switch.db`，供应商「导入已有」会安静返回 0 个结果（预期行为）。
- 换机后系统级音源目录（默认 `~/Documents/m-agent/Instruments`）可能为空，音源栏扫描结果为空是预期行为；放入音源文件后点击「扫描音源库」即可。

## 7. 验证命令

- `npm run typecheck`：TS 类型检查（renderer + electron）。
- `npm test`：Vitest 单测/集成测试（170 项通过）。
- `npm run build`：类型检查 + Vite 构建 + Electron main/preload 构建。
- `npm run test:electron`：构建后真实 Electron 桌面烟测（`scripts/electron-smoke.mjs`，自动连接 CDP 校验页面/preload/IPC/设置/离线 Agent）。
- `npm run package:mac` / `package:win` / `package:linux`：三端打包。

## 8. 已知环境说明（非代码缺陷）

- smoke 的 `shellAlertJump` 在 Shell 探针报「missing」的机器上为 false（预期）；Shell 可用机器上应通过。
- macOS 使用原生菜单栏（smoke 经 `magent:menu-action` 事件打开设置）；Windows/Linux 使用应用内菜单栏。
