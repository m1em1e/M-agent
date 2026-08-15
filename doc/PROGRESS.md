# 当前进展

> 状态快照：2026-08-13  
> 说明：本文只记录已经实现或实际验证过的内容。

## 1. 已实现功能

### MIDI 核心

- MIDI 工程、轨道、音符、速度图、拍号和循环区数据模型。
- Standard MIDI File Type 0/1 导入、导出。
- Type 0 按 Channel 拆轨，Type 1 保留 Conductor 与轨道信息。
- 音高、力度、Tick、轨道 Channel、Program 等领域校验。
- 插入、更新、删除音符及轨道、速度、拍号、循环区等结构化操作。
- 原子变更集和事务历史。

### 桌面编辑器

- 三栏桌面界面、轨道列表、Transport 和 Canvas 钢琴卷帘。
- 音符绘制、选择、移动、右缘缩放、删除和力度编辑。
- 网格与横向缩放。
- 多轨 Mute、Solo、新建轨道和基础 Web Audio 试听。
- 撤销、重做和单事务候选应用。
- 非 480 PPQ 工程的绘制、命中、播放、拖动和位置显示。
- `.magent` 打开再保存时保留工程 ID、Tempo Map、拍号、循环区、修订和 Agent 会话。
- 对话界面新增模型选择器：向上展开的下拉菜单，可切换当前激活订阅使用的模型，选择会持久化到订阅档案（`activeModelId`）。
- Agent 运行失败的错误信息已可读化：去除 IPC 封装前缀与错误 JSON 噪音，直接显示供应商返回的 message。
- Agent 回复采用 Markdown 渲染（`react-markdown` + `remark-gfm`，安全剥离原始 HTML，支持 GFM 表格、删除线、任务列表等）。
- 启动时若音源库为空，顶部显示黄色可关闭警告，引导进入「设置 → 音源」配置；可与环境红色警告同时出现。
- macOS 无应用菜单场景下补回 Cmd/Ctrl+C/V/X/A 剪贴板快捷键（主进程 `before-input-event` 分发）。
- macOS 标题栏优化：去掉左上角 logo 与应用内菜单栏，标题栏保留给系统红绿灯按钮并居中（`--titlebar-h: 40px`）；「文件/编辑/视图/窗口/音源/插件/帮助」菜单移到 macOS 原生 Menu Bar，点击经 `menu:action` IPC 转发到渲染进程执行；Cmd+Z/Y 由原生菜单处理避免重复触发，剪贴板由菜单编辑角色处理。Windows/Linux 仍使用应用内菜单栏与 logo。
- 菜单项已解耦为单一数据源 `src/shared/menu.ts`（`APP_MENU_GROUPS`）：macOS 原生菜单与 Windows/Linux 应用内菜单都从它生成，改菜单只需改一处（角色/分隔线仅原生菜单渲染，应用内菜单自动忽略）。
- 「文件」菜单重构：新建项目 / 打开项目 / 最近打开项目（子菜单，主进程 electron-store 持久化最近 8 个 .magent，macOS 原生与 in-app 同步）/ 保存项目（有当前路径免对话框直写，路径需经对话框/打开确认）/ 项目另存为 / 导入（子菜单：.magent 工程 / MIDI 文件）/ 导出 MIDI / 关闭项目；应用内菜单支持 hover 次级菜单。
- 新建 / 打开项目 / 导入 MIDI 会先询问「当前窗口 or 新窗口」：新窗口经 `window:create-project` 创建，`--magent-intent` 经 `additionalArguments` 传给新窗口自动执行对应操作。

### Pi Agent

- Pi Agent 是当前真实运行路径的底层内核；主进程不再直接调用 OpenAI HTTP API。
- 已注册以下受控工具：
  - `inspect_midi_project`
  - `analyze_midi_project`
  - `propose_midi_changes`
- `research` 不注册候选工具，并在权限层再次阻止越权调用。
- `plan` 可以产生候选，但候选保持预览状态。
- `goal` 可以产生候选，但 Pi 没有应用、写盘或导出工具。
- 候选经过 Schema 和 MIDI 领域校验后才返回界面。
- 候选最多三个，重复候选 ID 会被拒绝。
- 没有 API Key 时使用 Pi faux Provider 完成离线演示。
- **Skill 嵌套调用（2026-08-15）**：`@skill-name` 触发顶层 Skill；`list_skills`/`load_skill`/
  `invoke_skill` 仅在 Skill 作用域注册；子 Skill 继承父模式递归运行，深度 ≤2、每父 ≤4、全局 ≤8，
  禁止 self/环；子结果按 `SkillInvocationResult` 返回，顶层经确定性合并引擎（`mergeSkillOperations`，
  先到先得、绝不 last-wins）合成统一候选，走现有 Diff Preview 与用户确认。7 份 SKILL.md
  位于仓库根 `skills/`（打包进 `resources/skills`），支持用户自定义；`skillTrace` 可观测。
- **Agent 音色切换（2026-08-15）**：新增 `instrument_search`（系统音源库 + 工程绑定音源检索，
  返回 SoundFont bank/program）与 `set_track_instrument`（提出 `update_track` 音色更换候选，
  `instrument` 引用或 null 清除）；research 只能搜索，plan/goal 可提出候选；`update_track.changes`
  支持 `instrument`，界面候选已可应用 `update_track`（含音色）。
- **播放与工程体验（2026-08-15）**：新建项目为完全空工程（0 轨道）；SoundFont 音符按 `durationMs`
  定时 `noteOff` 释放、暂停/停止/开新工程时 `stopAll()`（同时停 SFZ），杜绝延音残留；播放音符时长上限
  300→8000ms；轨道检查器新增「删除轨道」（可撤销）；`agent:run` 超时统一 300s 且中止带清晰原因
  （「Agent 请求超时，已中止。」），瞬时流/网络错误仍自动重试一次。
- **Agent 编排与取消（2026-08-16）**：去掉 `agent:run` 固定墙钟超时（长任务不再被打断），新增
  `agent:cancel` IPC 与 Agent 面板「取消」按钮（忙碌时替换发送按钮）；中止/超时诊断附带工具调用计数
  （inspect/analyze/invoke_skill/propose 各几次 + 最近序列）；子 Skill 调用超时 45s→300s（避免误杀慢供应商的正常子调用）。
- **候选可应用全部操作（2026-08-16）**：界面候选现可应用 MIDI 核心定义的全部 10 种操作（音符/轨道/
  速度/拍号/循环）；撤销/重做栈从「轨道快照」升级为「完整编辑快照」（轨道 + tempo + 拍号 + 循环区），
  一次 Ctrl+Z 可整单撤销含工程级操作的候选。

### 候选应用

- 当前界面可原子应用 `insert_notes`、`update_notes` 和 `delete_notes`。
- 应用前会在克隆工程上验证所有操作；任一操作失败则整个候选不提交。
- 只允许应用由 `goal` 模式生成且仍有效的候选。
- 已应用或已忽略的候选不能重复应用。
- 普通编辑、撤销或重做会清理已经过期的候选状态。
- 轨道、速度、拍号和循环区等工程级候选目前只显示为“不支持应用”。

### Electron 集成与安全

- Renderer → preload → IPC → main service → Pi kernel 链路已接通。
- preload 使用 `.cts` 编译为 sandbox 可加载的 `.cjs`。
- 生产 Vite 资源使用相对路径，可从 `file://` 加载。
- API Key 使用 Electron `safeStorage` 加密后保存。
- IPC 会验证 Agent 模式、目标长度和 MIDI 工程结构。
- 打开文件前限制 MIDI 和工程文件大小。
- 每个窗口同时只允许一个 Agent 任务，并设置 60 秒中止。
- 禁止未授权页面导航及新窗口。
- 构建前会清理旧 `dist-electron`，避免打包残留 preload。

### 启动环境与供应商认证

- Pi Agent Core 与 Pi AI 已内置进应用；正式安装版不要求用户安装 npm 或全局 Pi CLI。
- 启动诊断覆盖 Electron、内置 Node、内置 Pi、开发环境 npm、开发环境可选 Pi CLI 和系统加密能力。
- 正式安装版不会执行 PATH 中的外部 `pi` 命令，只会读取标准 Pi 凭据文件。
- 没有在线认证或必要环境损坏时，顶部显示红色提示，并可直接打开供应商配置或重新检测。
- OpenAI API Key 支持应用安全存储、标准 Pi 凭据和 `OPENAI_API_KEY` 环境变量。
- OpenAI Codex Provider 支持应用内 ChatGPT Plus/Pro 浏览器 OAuth。
- 首次启动会只读复制标准 Pi OpenAI/Codex 凭据到应用自己的系统加密存储；后续刷新不会改写外部 Pi 文件，且不会覆盖应用内已配置的凭据。
- 旧版 API Key 会迁移到新的 Provider 凭据存储；清除操作同时覆盖新旧存储，避免旧值重新生效。
- 设置页支持应用内安全保存 API Key，以及通过浏览器完成 ChatGPT Plus/Pro OAuth 登录和退出。
- 应用内 OAuth token 使用 `safeStorage` 加密，且不会通过 IPC 暴露给 Renderer。
- 在线 Provider 不可用时，Agent 继续使用内置 Pi faux Provider 离线演示。
- 设置中心包含五个板块：
  - 通用：首项为外观设置，主题列表默认折叠并显示当前主题摘要，展开后可即时切换并在本机持久化默认、Nord、Tokyo Night、Warn Paper、High Contrast 主题，以及深色、浅色、跟随主题模式。
  - 通用第二项为对话设置：可控制思考摘要显隐、Pi 默认 thinking（low/medium/high）、目标最大轮次和目标累计输出 Token 预算；默认值依次为是、medium、20、500000，并保存在本机。
  - 对话设置经 IPC 运行时校验后进入 Pi 内核；目标轮次和累计输出 Token 预算只放宽/约束目标模式，不改变调研只读或计划预览权限。
  - 通用第三项为 Shell 路径设置。Windows 默认 `C:\Windows\system32\bash.exe`，macOS/Linux 默认 `/bin/bash`；设置页已提供原生“浏览”和“检测”按钮，并显示可用性结果。
  - Shell 配置已从 Renderer `localStorage` 提升为主进程 `electron-store` 权威配置。候选路径只有通过固定 Bash 兼容性探针后才会保存，输入失败不会覆盖原有可用配置。
  - 应用每次启动和手动重新检测环境时都会检测统一 Shell；不可用时顶部红色警告会提示配置，并可直接打开“通用 > Shell 路径”。
  - 主进程已提供统一的 `runConfiguredShellCommand` 入口，当前开发态 npm 和外部 Pi CLI 版本探测已改用所选 Shell。Renderer 和 Agent 均未获得通用命令执行能力，三种模式权限不变。
  - 主题目录已提供插件主题贡献的合并与校验边界：插件主题必须使用 `pluginId/themeId` 命名空间，只能提供白名单内的语义颜色变量，且不能覆盖内置主题。当前尚未从插件系统实际载入贡献。
  - 供应商：OpenAI API Key 与 ChatGPT Plus/Pro OAuth。
  - 用量：当前只显示本地会话概览，明确标记精确 Token/费用尚未接入。
  - 音源：两级音源库——系统级（托管目录，默认 ~/Documents/m-agent/Instruments，递归扫描 .sf2/.sf3/.sfz）与项目级（随 .magent 保存的 instruments 绝对路径快照，绑定即生效）；音源栏为「列表 / 新建音源库」两视图，支持打开文件夹、路径配置与迁移确认；SFZ 已实现解析与发声；VST 未接入。
  - 插件：显示插件系统规划状态，不扫描或执行第三方插件。

认证和环境行为的完整说明见 [ENVIRONMENT_AND_AUTH.md](ENVIRONMENT_AND_AUTH.md)。

## 2. 已执行验证

### 2026-08-14 Shell 浏览、检测与启动诊断

- `npm run typecheck`：通过。
- Shell、环境诊断及旧 Shell 偏好相关定向测试：3 个测试文件、14 项测试通过。
- 本机默认 `C:\Windows\system32\bash.exe` 文件存在，但固定 Shell 探针返回不可用（系统未配置 WSL 默认发行版）；启动红条应据此提示配置，而不是仅凭文件存在误判可用。用户可改选可用的 Bash、Windows PowerShell 或 PowerShell 7。
- 由于本轮按用户要求提前结束，修改后的完整测试套件、生产构建和 Electron 桌面烟测尚未执行，不能宣称已完成端到端验证。

### 2026-08-14 Shell 收尾（按要求跳过测试）

- 已更新 `scripts/electron-smoke.mjs`：覆盖 Shell 三个 preload/IPC 方法、主进程配置快照、无效候选不会覆盖有效配置、浏览/检测按钮，以及 Shell 异常时顶部“配置 Shell”跳转。
- 已移除 smoke 对旧 `magent.shell.v1` 路径值的依赖，改为断言旧 Renderer 缓存已不存在。
- 已明确采用废弃而非迁移策略：应用启动会删除旧 `magent.shell.v1`，不会把历史 Renderer 路径提升为主进程可执行配置；用户需要通过原生浏览或输入后重新检测。
- 本次收尾按用户要求没有运行测试、类型检查、构建或 Electron smoke；上述脚本与废弃逻辑尚未执行验证。
- 统一 Shell 随后扩展为支持 Bash、Windows PowerShell (`powershell.exe`) 和 PowerShell 7 (`pwsh`/`pwsh.exe`)；检测与实际执行会按类型使用 `-lc` 或无配置、非交互的 `-Command` 参数。开发态 npm/Pi 探测在 Windows PowerShell 下显式使用 `.cmd` shim。
- PowerShell 扩展同样按用户要求未执行测试、类型检查、构建或 Electron smoke。

### 2026-08-15 音源与对话体验收尾

- SFZ 采样：实现最小 opcode 集解析（`src/core/audio/sfz-parser.ts`）与发声引擎（`src/renderer/audio/sfz-engine.ts`），轨道可选用 SFZ 音色并试听。
- 音源导入交互：移除「添加 SoundFont / 添加 SFZ」按钮，改为虚线放置区——点击弹多选对话框，或直接拖入 .sf2/.sf3/.sfz 文件；主进程按扩展名推断类型（`inferInstrumentTypeFromPath`），新增 `instrument-library:add-files` IPC；preload 用 `webUtils.getPathForFile` 获取拖入文件的绝对路径。
- 对话模型选择：Agent 面板底部向上展开的模型下拉，切换当前激活订阅的模型并持久化。
- 错误可读化：`cleanAgentError` 剥离 IPC 封装并提取供应商错误 message。
- Markdown 渲染：改用 `react-markdown@10.1.0` + `remark-gfm@4.0.1`（新增依赖），替换手写解析器。
- 启动音源警告：音源库为空且未关闭时，顶部显示黄色可关闭横幅，直达「设置 → 音源」。
- 剪贴板快捷键：macOS 移除应用菜单后补回 Cmd/Ctrl+C/V/X/A。
- 验证：`npm run typecheck`、`npm test`（25 文件 / 125 用例）、`npm run build` 均通过；桌面手工冒烟（拖入音源、模型切换、MD 表格、黄色警告）需在 `npm run dev` 下执行。

### 2026-08-15 音源系统重构（两级音源库）

- **系统级音源库（托管目录）**：默认 `~/Documents/m-agent/Instruments`（`app.getPath('documents')/m-agent/Instruments`，可配置）。递归扫描目录下 .sf2/.sf3/.sfz，解析结果按「路径+mtime」缓存（`src/main/audio/library-store.ts` + `system-scan.ts`），禁用状态按路径持久化；「打开文件夹」自动创建目录；修改路径时应用内确认面板询问是否迁移文件（`cp` + `rm`）。
- **项目级音源库（随工程）**：`.magent` 新增 `instruments` 数组，保存绝对路径 + presets/sfzRegions 完整快照；添加页项目级 dropzone 绑定即生效；保存时按轨道引用自动快照（`buildProjectInstruments`，按 id 去重，工程级优先）。
- **UI 重构**：设置 → 音源 改为「列表 / 新建音源库」两视图（镜像供应商栏）。列表 = 系统级条目（启用/禁用）+ 工程绑定条目（「工程」标记 + 移除绑定）+ 「扫描音源库」+ 右上角「添加」；新建页 = 项目级 dropzone（含迁移注意事项）+ 系统级（打开文件夹）+ 路径配置（含迁移确认面板）。轨道检查器合并系统级 + 工程级音源（工程带标记）。
- 启动音源警告改为「系统级与工程级均为空」时提示。
- 新增 IPC：pick-files / bind-instrument / get-set-system-path / open-system-folder / set-enabled；停用 add-files 与 update/remove。
- 验证：`npm run typecheck`、`npm test`（26 文件 / 133 用例）、`npm run build` 通过；桌面手工冒烟需在 `npm run dev` 下执行。

### 2026-08-15 macOS 原生菜单与标题栏

- macOS 使用原生 Menu Bar（文件/编辑/视图/窗口/音源/插件/帮助），标题栏去掉 logo 与应用内菜单栏，高度调整使系统红绿灯按钮垂直居中。
- 原生菜单动作经 `menu:action` IPC → preload `onMenuAction` → 渲染进程 `runMenuAction` 执行；剪贴板与窗口操作使用原生 role。
- `npm run test:electron` 冒烟已重跑并通过（含原生菜单模式下用 `magent:menu-action` 事件打开设置的分支）；本机 Shell 探针现为 ready，`shellAlertJump: true`。

### 2026-08-15 P0-1 / P0-2 关闭

- **P0-1 大型工程分析栈溢出**：`src/core/agent/pi-kernel.ts` 的 `analysisSnapshot` 音高范围计算
  由 `Math.min/max(...spread)` 改为 `pitchRange` 单次循环；新增 130,000 音符单轨回归测试
  （`tests/agent/pi-kernel.test.ts`）。结论：200,000 音符上限下分析不再栈溢出，快照为 O(n)。
- **P0-2 Electron 升级**：37.10.3 → 43.4.0（`npm install electron@43.4.0 --save-exact`）。
  内置 Node 24.18.1（满足 Pi ≥22.19）；`npm audit` 归零。二进制下载需走
  `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`（GitHub 直连 fetch 失败）。
  回归：`npm run typecheck`、`npm test`（26 文件 / 134 用例）、`npm run build`、`npm run test:electron`
  （Electron 43 下 smoke 需 `--remote-allow-origins=*`，已加入 `scripts/electron-smoke.mjs`）全部通过，
  覆盖 preload sandbox、electron-store、Pi 离线内核、原生菜单与音源系统。
- 打包链路（macOS/Windows/Linux）在 Electron 43 下尚未重跑，见 `doc/TODO.md` P2「发布与打包验证」。

### 单元与集成测试

```text
npm test
31 个测试文件通过
168 项测试通过
```

覆盖范围包括 MIDI 工程、SMF 导入导出、Agent 权限、Schema、GoalRunner、Pi kernel、main service、启动环境诊断、工程载荷边界、SFZ 解析/区域选择、音源类型推断、项目级音源快照、系统级目录扫描、Markdown 渲染，以及 Skill 解析/加载/合并/嵌套调用守卫/真实递归内核集成与 Agent 音色切换（instrument_search / set_track_instrument / update_track 领域应用）。

### 完整构建

```text
npm run build
TypeScript 类型检查通过
Vite Renderer 构建通过
Electron main/preload 构建通过
```

干净构建后的 preload 目录只包含 `index.cjs` 及 Source Map，不再包含旧的 `index.js`。

### 真实 Electron 烟测

```text
npm run test:electron
```

实际验证结果：

```json
{
  "title": "M/Agent",
  "rootChildren": 1,
  "bridgeType": "function",
  "kernel": "pi",
  "provider": "pi-offline",
  "candidateCount": 0,
  "analysisLength": 30,
  "environmentSchema": 1,
  "piCoreStatus": "ready",
  "settingsSections": ["通用", "供应商", "用量", "音源", "插件"],
  "settingsTitle": "插件",
  "appearanceHeading": "外观",
  "generalGroupHeadings": ["外观", "对话", "Shell 路径", "运行环境", "Agent 默认状态"],
  "conversationDefaults": {
    "showThinking": "true",
    "thinkingLevel": "medium",
    "goalMaxTurns": "20",
    "goalMaxTokens": "500000"
  },
  "thinkingCount": 1,
  "effectiveThinkingLevel": "medium",
  "themeCollapsedInitially": true,
  "themeExpanded": true,
  "themeCollapsedAfterToggle": true,
  "themeLabels": ["默认", "Nord", "Tokyo Night", "Warn Paper", "High Contrast"]
}
```

这项测试实际启动构建后的 `file://` Electron 页面，确认页面渲染、sandbox preload、环境诊断 IPC、五板块设置导航、主题列表展开/收起、外观与对话设置持久化、Pi 思考摘要，以及 Pi 离线调研链路，然后自动关闭。它不是 NSIS 安装流程测试。

### 打包链路

- 三端图标资源已放入 `build/` 并接入 Electron Builder：Windows 使用 `icon.ico`，macOS 使用 `icon.icns`，Linux 使用 `icons/` 多尺寸 PNG。
- 已新增 `package:mac` 和 `package:linux` 脚本；当前主机只能完整验证 Windows 构建，macOS/Linux 产物仍需在对应系统或 CI 验证。
- `package:win` 已固定复用本地 `node_modules/electron/dist`，避免当前网络环境在 Electron Builder 重复下载/解包阶段失败。
- `npm run package:win` 已成功生成 `release/M Agent Setup 0.1.0.exe`（NSIS x64，约 96 MB）及 blockmap；安装器和应用 EXE 均可提取自定义图标。
- 生成的 unpacked 应用已通过真实生产页面、sandbox preload、环境诊断 IPC 和 Pi 离线调研冒烟测试；安装态窗口图标与 `build/icon.ico` 的 SHA-256 一致。
- Windows 产物尚未代码签名；Windows 可能显示未知发布者警告。macOS 的签名、公证和 Linux 产物尚未验证。

## 3. 当前仓库状态

- 当前分支：`master`，已有历史提交；最近改动（音源两级库、模型选择、Markdown 渲染、剪贴板快捷键等）尚未提交。
- 工作区包含本轮未提交的修改与新增文件；未创建新分支、远程推送或 PR。
- `dist/`、`dist-electron/`、`release/` 和 `node_modules/` 均由 `.gitignore` 排除。
