# 尚未完成与已知问题

> 状态快照：2026-08-13  
> 优先级含义：P0 为发布或可靠性阻塞，P1 为主要功能缺口，P2 为后续完善。
> 换机/换人续接：每项未完成任务的入口文件与实施建议见 [CONTINUATION.md](CONTINUATION.md)。

## P0：发布前必须处理

### 1. 大型工程会导致 Pi 分析栈溢出

当前 `analysisSnapshot` 使用展开参数计算单轨音高最小值和最大值：

```ts
Math.min(...track.notes.map(...))
Math.max(...track.notes.map(...))
```

主进程允许最多 200,000 个音符，但单轨 130,000 个音符已经实际复现：

```text
RangeError: Maximum call stack size exceeded
```

待办：

- 改成单次循环或 `reduce` 计算音高范围和结束 Tick。
- 增加 130,000 音符的回归测试。
- 评估 Agent 工程输入的合理音符上限。

### 2. Electron 版本需要升级

当前固定为 Electron 37.10.3。它与 Pi 0.84.1 的 Node 要求兼容，但截至当前日期已经不在 Electron 官方支持的最新三个主版本范围内。

待办：

- 升级到仍受支持的 Electron 主版本。
- 重新执行类型检查、完整测试、桌面烟测和打包验证。
- 重点验证 preload sandbox、`safeStorage`、electron-store 和 Pi 的 Node 版本兼容性。

### 3. Windows 安装器尚未生成

默认 `npm run package:win` 在当前环境的 Electron 分发下载或解包阶段失败。虽然复用本地 Electron 的 unpacked 构建已经成功，但 NSIS 安装、卸载仍未验证。

待办：

- 让 `package:win` 复用 `node_modules/electron/dist`，或在 CI 中提供可靠缓存。
- 生成 NSIS 安装器。
- 验证安装、首次启动、升级覆盖和卸载。
- 增加应用图标、版本信息和代码签名方案。
- 在没有 npm、Node.js 和全局 Pi CLI 的干净 Windows 环境验证：应用仍正常启动，且不会误报这些可选外部工具。

## P1：主要功能与正确性缺口

### 1. 在线调研模式的工具闭环

当前 `research` 在第一轮后无条件停止。真实模型若第一轮只调用分析工具，可能没有第二轮读取工具结果并输出自然语言结论。

待办：允许工具调用后再运行一轮，并增加“首轮工具调用、次轮结论”的模拟测试。

### 2. 大工程分析工具缺少分页

`analyze_midi_project` 当前会把完整工程 JSON 交给模型。大工程可能超过上下文窗口、产生高费用或造成大量内存分配。

待办：改为按 `trackId`、Tick 范围、游标和数量限制读取，默认只返回摘要。

### 3. 目标模式评估闭环未完成

当前目标模式具备轮次、时间和候选数量限制，但真实 Pi 运行路径没有复用已有 `GoalRunner` 的成本预算、确定性评分、排序和诊断。界面候选分数目前按候选顺序生成，不是模型或确定性评估结果。

待办：统一 Pi 编排和 GoalRunner，或把预算与评估能力迁入 Pi 运行层。

### 4. 工程级候选尚不能在界面应用

MIDI 核心已定义轨道、速度、拍号和循环区操作，但当前 Renderer 只应用音符插入、更新和删除。

待办：为其余领域操作增加预览、原子应用和撤销支持。

### 5. 候选缺少工程版本绑定

候选生成后如果工程继续变化，旧候选可能在音乐语义已经过期时被应用。当前 ID 和数值校验只能阻止结构错误。

待办：在请求和候选中加入工程版本或内容哈希，应用前比对。

### 6. 真实云端 Provider 尚未验证

当前只自动验证了 Pi 离线 Provider。尚未使用真实 API Key 验证：

- OpenAI Responses 请求和工具调用。
- 认证失败、限流、网络错误和 60 秒中止。
- 实际 Token、费用和模型输出质量。
- 在线 `research`、`plan`、`goal` 三模式行为。
- ChatGPT Plus/Pro OAuth 登录已接入并能检测已有 Pi 登录，但尚未在自动测试中发起真实模型请求验证账号 entitlement。

### 7. 认证交互仍是最小实现

当前应用内 Codex OAuth 仅实现浏览器回调登录。尚未提供：

- device-code 登录界面。
- 浏览器回调失败后的手动授权码输入。
- 可见的登录取消按钮和分阶段进度事件。
- OpenAI 以外的供应商配置界面。

另外，API Key 的“已配置”状态只是本地可解析，不代表服务端已经验证其有效性；后续应提供不泄露凭据的连接测试与明确错误分类。

### 8. 设置板块后端能力尚未补齐

五板块设置导航已经完成，但以下板块目前主要用于展示真实状态和后续入口：

- 通用：主题与外观模式已经在 Renderer 本地持久化，主题列表支持折叠；已预留经过校验的插件主题贡献目录，但尚未实现插件发现、安装、授权与主题贡献载入，也未实现多设备偏好同步。
- 用量：尚未持久化 Pi 的 Token、费用、模型和按日统计。
- 音源：已支持 SoundFont（.sf2/.sf3）导入、bank/program 选择与轻量 Web Audio 试听（SpessaSynth）；SFZ 仅登记路径与名称，尚未实现采样映射；VST3 host 未接入（见 [音源系统状态](INSTRUMENTS.md)）。
- 插件：尚无插件清单、Manifest、权限模型、安装、启停和隔离执行机制。

在相应后端完成前，界面不得显示伪造的费用、设备或插件数据。

## P2：数据契约、安全和体验完善

### Shell 设置本轮剩余验证与迁移

- 运行完整 `npm test`、`npm run build` 和 `npm run test:electron`。smoke 脚本现已更新，但按用户要求尚未执行。
- 在 Windows 的 Git Bash、WSL Bash，以及 macOS/Linux `/bin/bash` 上分别做真实检测；当前机器只有不可用的 WSL `bash.exe`，没有验证成功路径的桌面交互。
- 在 Windows PowerShell 5.1、PowerShell 7，以及 macOS/Linux 的 `pwsh` 上验证固定探针、npm/Pi `.cmd`/命令解析和错误显示。
- 自动化覆盖原生文件选择器取消/选择流程，以及超时、输出上限和并发 IPC 边界的真实主进程集成测试。
- 评估把手输路径改为主进程原生选择并确认后再执行，进一步收紧“受损 Renderer 指向同名恶意 `bash.exe`”的风险。
- 后续任何需要 Shell 的主进程功能必须复用 `runConfiguredShellCommand`，不得重新使用 `cmd.exe`、`shell: true` 或向 Renderer/Agent 暴露任意命令 IPC。

旧版 `magent.shell.v1` 已明确废弃：启动时直接清除，不迁移为主进程可执行路径。

- 严格限制 `Revision.source` 和 `AgentSession.mode` 的枚举值。
- 明确空 `tempoMap`、空 `timeSignatures` 的兼容或规范化策略。
- 限制工程标题长度，并清理 Windows 文件名非法字符。
- 生产 CSP 移除开发用 `ws://127.0.0.1:5173`。
- 增加默认拒绝的 Electron Session 权限处理器。
- 配置 Electron fuses，关闭生产环境不需要的 Node/调试入口并启用 ASAR 完整性保护。
- 增加可见的取消 Agent 操作、流式输出和会话管理。
- 为钢琴卷帘增加框选、复制粘贴、多音符批量编辑和更完整的播放控制。
- 增加真实 MIDI 文件样本、超大工程、损坏工程和安装包自动化测试。
- 将 Pi 主进程依赖改为可捕获的动态加载边界，或由安装器提供完整性修复；当前内置 Pi 包完全缺失时，主进程可能在红色提示渲染前退出。

## 当前明确不应宣称完成的事项

- Windows、macOS、Linux 三端安装包均已完成签名和发布验证。
- 真实 OpenAI 云端链路已经通过端到端测试。
- 大型 MIDI 工程已经稳定支持。
- 目标模式已经具有完整的成本预算和音乐评分系统。
- Renderer 已能应用 MIDI 核心定义的所有操作类型。
