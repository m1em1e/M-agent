# 环境检测与供应商认证

> 状态基线：2026-08-14  
> 适用版本：M Agent 0.1.0、Pi 0.84.1

## 1. Pi 的集成方式

M Agent 使用随应用一起打包的 Pi SDK，而不是调用远程“Pi API”：

- `@earendil-works/pi-agent-core`：负责 Agent 循环、工具调用和会话编排。
- `@earendil-works/pi-ai`：负责模型目录、供应商适配、API Key、OAuth 和模型请求。

因此正式安装版不要求用户另外安装：

- Node.js 或 npm。
- 全局 `pi` 命令。
- `@earendil-works/pi-coding-agent`。

全局 Pi CLI 只是可选的外部工具。开发模式可以探测它的版本；安装版不会执行 PATH 中的 `pi` 命令。

## 2. 启动检测项目

| 检测项 | 开发模式 | 正式安装版 | 是否影响运行 |
| --- | --- | --- | --- |
| Electron 运行时 | 检测 | 检测 | 必需 |
| Electron 内置 Node.js | 检测，要求至少 22.19.0 | 检测，要求至少 22.19.0 | 必需 |
| 内置 Pi Agent Core / Pi AI | 检测版本 | 检测版本 | 必需 |
| 统一 Shell（Bash/PowerShell） | 执行固定无副作用探针 | 执行固定无副作用探针 | 必需；不可用时提示配置 |
| npm | 执行固定的 `npm --version` 探测 | 跳过 | 仅源码开发必需 |
| 外部 Pi CLI | 执行固定的 `pi --version` 探测 | 不执行，只显示为可选项 | 非必需 |
| Electron `safeStorage` | 检测 | 检测 | 保存或导入凭据时必需 |
| 在线供应商认证 | 检测 | 检测 | 在线模型必需；离线演示不依赖 |

下列情况会在应用顶部显示红色提示：

- 必需运行环境不满足。
- 默认或已配置的 Bash、Windows PowerShell 或 PowerShell 7 无法执行固定兼容性探针。
- 没有可用的在线供应商认证。
- Renderer 无法读取主进程环境报告。

Shell 不可用时，红条会提供“配置 Shell”入口；没有在线认证时会提供“配置供应商”入口。两种情况均可重新检测。

Shell 路径由主进程持久化，Renderer 只拥有读取、原生浏览和检测白名单接口。候选路径必须是本机绝对路径，文件名为 `bash`/`bash.exe`、`powershell.exe` 或 `pwsh`/`pwsh.exe`，并成功执行固定 sentinel 命令后才会保存。Bash 使用 `-lc`，PowerShell 使用 `-NoLogo -NoProfile -NonInteractive -Command`。当前开发态 npm 与外部 Pi CLI 探测也通过该 Shell 运行。应用没有向 Renderer 或 Agent 暴露任意 Shell 命令接口。

## 3. 当前支持的供应商认证

### OpenAI API Key

支持以下来源：

1. 应用内设置页保存的 OpenAI API Key。
2. 从标准 Pi 登录文件复制到应用加密存储的 OpenAI API Key。
3. 主进程环境中的 `OPENAI_API_KEY`。

设置页显示“已配置”只代表本地凭据结构可以解析，并不代表服务端已经确认 Key 有效。Key 是否失效、额度不足或被限流，要到第一次真实模型请求时才能确定。

### OpenAI Codex 订阅 OAuth

Pi 0.84.1 提供 `openai-codex` Provider，可通过 ChatGPT Plus/Pro OAuth 使用 Codex 模型。当前应用内流程为：

1. 用户在设置页点击“使用浏览器登录订阅”。
2. 主进程调用 Pi Provider 的 OAuth 登录流程。
3. 主进程仅允许打开 `https://auth.openai.com`。
4. 浏览器完成登录后，Pi 通过本机回调地址接收授权结果。
5. access token 和 refresh token 经 Electron `safeStorage` 加密保存。

当前只实现浏览器回调登录，没有 Renderer 内的手动授权码输入或 device-code 界面。登录任务最多等待 5 分钟；窗口关闭或超时会中止。

## 4. 标准 Pi 凭据导入

启动时，应用会只读检查标准 Pi coding-agent 凭据文件：

```text
%PI_CODING_AGENT_DIR%/auth.json
```

未设置 `PI_CODING_AGENT_DIR` 时使用：

```text
~/.pi/agent/auth.json
```

只处理 `openai` 和 `openai-codex` 两个 Provider。处理规则：

- 只从外部 Pi 文件读取，不向它写入或删除内容。
- 将可识别凭据复制到 M Agent 自己的 `safeStorage` 加密存储。
- 已存在应用内凭据时不覆盖。
- 后续 OAuth 刷新只更新应用自己的加密副本。
- IPC 和 Renderer 只收到 Provider、认证类型、来源和可用状态，不会收到 Key、Token、授权 URL 或凭据文件路径。

旧版本保存在 `secure-settings` 中的 API Key 会迁移到新的 Provider 凭据存储；迁移成功后删除旧副本。清除 API Key 时会同时清理旧、新两处存储，避免旧值重新生效。

## 5. 运行时选择

当前 Agent 运行时按以下顺序选择可用认证：

1. 尚未迁移完成的旧版应用 API Key。
2. 应用加密存储中的 ChatGPT Plus/Pro OAuth。
3. 应用加密存储中的 OpenAI API Key，或 `OPENAI_API_KEY`。
4. Pi faux 离线 Provider。

设置页会同时显示两种 Provider 的状态和当前实际使用的 Provider。离线 Provider 只用于演示 Agent 编排与权限边界，不是本地大模型，也不会产生云端音乐生成质量。

## 6. 安全边界

- 所有认证操作只在 Electron 主进程执行。
- preload 只暴露严格白名单 IPC。
- Renderer 不保存、不读取和不记录任何凭据。
- API Key、OAuth Token 不会写入 `.magent` 或 MIDI 文件。
- 每个窗口同一时间只允许一个 OAuth 登录和一个 Agent 请求。
- OAuth 登录地址会校验协议与主机名。
- Agent 仍然没有直接应用 MIDI 修改、写文件或导出文件的工具。

## 7. 验证范围与限制

已经自动验证：

- 环境诊断数据结构和 Node 版本边界。
- 正式安装逻辑中 npm、全局 Pi CLI 均不是必需项。
- Provider 状态不会返回测试用密钥内容。
- Renderer → sandbox preload → IPC → 环境诊断和 Pi 离线 Agent 的真实 Electron 链路。

尚未自动验证：

- 真实 OpenAI API Key 请求。
- 真实 ChatGPT Plus/Pro 登录后的模型 entitlement。
- OAuth 回调端口被占用、网络代理和企业登录策略等现场环境。
- 真正 `win-unpacked` 或 NSIS 安装版在完全未安装 npm/Pi 的电脑上的启动行为。
- 内置 Pi 包严重损坏时的应用内红条。当前 Pi 是主进程静态依赖，模块完全无法加载时可能在窗口创建前退出，应由安装器完整性检查或修复流程覆盖。
