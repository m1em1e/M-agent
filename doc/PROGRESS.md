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
  - 音源：已支持 SoundFont（.sf2/.sf3）导入、音色分配与轻量试听；SFZ 仅登记、VST 未接入。
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

### 单元与集成测试

```text
npm test
14 个测试文件通过
62 项测试通过
```

覆盖范围包括 MIDI 工程、SMF 导入导出、Agent 权限、Schema、GoalRunner、Pi kernel、main service、启动环境诊断和工程载荷边界。

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

- 当前分支：`master`。
- 项目文件仍全部处于未跟踪状态。
- 尚未创建 Git 提交、分支、远程推送或 PR。
- `dist/`、`dist-electron/`、`release/` 和 `node_modules/` 均由 `.gitignore` 排除。
