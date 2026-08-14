# M Agent 实施计划

> 文档基线：2026-08-13  
> 当前阶段：MVP 已可运行，正在进入大型工程可靠性与发布准备阶段。

## 1. 产品目标

M Agent 是面向游戏音乐创作的桌面 MIDI Agent 应用，目标是把以下能力放进同一工作流：

- 多轨 MIDI 工程管理与 Standard MIDI File 导入、导出。
- 钢琴卷帘中的音符创建、选择、移动、缩放、删除和力度编辑。
- Agent 对工程进行分析，并生成结构化、可校验、可撤销的 MIDI 修改。
- `research`、`plan`、`goal` 三种受权限约束的工作模式。
- Agent 不直接操作文件系统或覆盖 MIDI 二进制；所有修改先形成候选，再由用户确认并作为事务应用。

## 2. 技术方案

当前技术栈：

- 桌面外壳：Electron 37.10.3。
- 界面：React 19、TypeScript、Vite。
- Agent 内核：`@earendil-works/pi-agent-core` 0.84.1 和 `@earendil-works/pi-ai` 0.84.1。
- 测试：Vitest。
- 发布：electron-builder、Windows NSIS。

运行链路：

```text
React Renderer
  -> sandboxed CommonJS preload
  -> Electron IPC
  -> main agent service
  -> Pi Agent kernel
  -> 只读分析工具 / 结构化候选工具
  -> Schema 与 MIDI 领域校验
  -> 用户确认
  -> 单个可撤销事务
```

## 3. 分阶段计划

### 阶段 A：工程与 MIDI 领域层 — 已完成

- 建立 Electron、React、TypeScript、Vite 和 Vitest 工程。
- 定义 MIDI 工程、轨道、音符、速度图、拍号、循环区和修订数据结构。
- 实现 MIDI Type 0/1 导入、导出。
- 实现结构化编辑、领域校验和事务历史。

### 阶段 B：桌面编辑器 MVP — 已完成

- 建立三栏桌面界面、轨道列表、Transport 和钢琴卷帘。
- 完成音符基础编辑、力度、网格、缩放、播放、撤销与重做。
- 完成 `.magent` 工程文件打开和保存。
- 支持非 480 PPQ 工程，并保证 Tick 使用整数。

### 阶段 C：三模式 Agent — 已完成 MVP

- `research`：只允许读取和分析，不注册候选提交或写入工具。
- `plan`：允许生成结构化候选，但界面只提供预览。
- `goal`：最多运行三轮并生成候选，用户确认后才应用。
- 所有模式都禁止 Agent 直接应用修改、写文件或导出 MIDI。
- Pi Agent 同时支持 OpenAI Provider 和无需密钥的离线演示 Provider。

### 阶段 D：桌面集成与安全边界 — 已完成 MVP

- 打通 Renderer、preload、IPC、main service 和 Pi 内核。
- 使用系统安全存储保存 API Key，不写入工程文件。
- 增加 IPC 数据校验、文件大小限制、单窗口单任务和 60 秒中止。
- 限制每次 Agent 运行最多三个候选。
- 禁止新窗口及未授权页面导航。
- 使用 sandbox 兼容的 CommonJS preload。

### 阶段 D.1：环境与供应商配置 — 已完成

- 启动时检测 Electron、内置 Node、内置 Pi SDK、统一 Shell（Bash/PowerShell）、开发环境 npm、开发环境可选 Pi CLI 和系统凭据加密。
- 正式安装版使用内置 Pi 内核，不把全局 `pi` 或 npm 当作运行依赖，也不执行 PATH 中的 `pi` 命令。
- 检测应用安全存储、`OPENAI_API_KEY` 以及标准 Pi OpenAI/Codex 凭据。
- 无可用在线供应商时在应用顶部显示红色提示，并提供重新检测和供应商设置入口。
- 设置页可直接保存 OpenAI API Key，或在浏览器完成 ChatGPT Plus/Pro OAuth 登录。
- 标准 Pi 凭据只读复制到应用加密存储，不覆盖应用内配置、不回写外部 Pi 文件。
- API Key 和 OAuth Token 只保留在主进程的加密凭据存储中，不发送到 Renderer。
- 设置中心已拆分为通用、供应商、用量、音源、插件五个板块；通用页首项为外观，第二项为对话，第三项为 Shell 路径。对话默认值为是、medium、20、500000。Shell 由主进程持久化，支持原生浏览、Bash/Windows PowerShell/PowerShell 7 固定探针、启动警告和统一执行入口；Windows 默认路径为 `C:\Windows\system32\bash.exe`。当前 Agent 没有 Shell 执行工具，路径设置不会扩大模式权限。完整 Electron 回归仍列入阶段 E。

### 阶段 E：可靠性完善 — 下一阶段

按顺序处理：

1. 修复大型单轨工程的音高范围计算栈溢出，并增加 130,000 音符回归测试。
2. 修正在线 `research` 的工具调用后续轮次，确保模型能读取工具结果并输出结论。
3. 将全量工程分析工具改为按轨道、Tick 范围和数量分页的有界读取。
4. 将目标模式接入真实预算、评分、排序和诊断闭环。
5. 为候选绑定工程版本，避免在工程继续编辑后应用过期候选。
6. 运行已更新的 Shell Electron 烟测，并完成三平台真实 Bash 验证。旧 `magent.shell.v1` 已决定废弃并在启动时清除，不再安排迁移。

### 阶段 F：发布准备 — 尚未完成

1. 升级到仍受官方支持的 Electron 主版本并重新回归。
2. 固化 Windows 打包的 Electron 分发路径，完成 NSIS 安装、卸载测试。
3. 完成真实 OpenAI API 链路测试，包括错误、超时和额度场景。
4. 在没有 npm、全局 Pi CLI 的干净 Windows 安装环境验证启动诊断。
5. 增加代码签名、应用图标、版本信息和发布检查清单。
6. 收紧生产 CSP、Electron fuses 和默认权限策略。

## 4. MVP 验收标准

- [x] 能打开和导出 MIDI。
- [x] 能打开和保存 `.magent` 工程。
- [x] 钢琴卷帘能完成基本音符编辑。
- [x] Agent 能通过 Pi 内核读取工程并生成结构化候选。
- [x] 调研模式保持只读。
- [x] 计划模式不能应用候选。
- [x] 目标模式候选必须由用户确认，并可一次撤销。
- [x] 离线 Electron 端到端链路可自动验证。
- [x] 启动环境诊断与顶部配置提示可通过真实 preload/IPC 加载。
- [x] 应用内 OpenAI API Key 和 ChatGPT Plus/Pro OAuth 接口已接通。
- [ ] 真实云端 Provider 端到端验证通过。
- [ ] 大型工程可靠性回归通过。
- [ ] Windows NSIS 安装包生成、安装和卸载通过。
