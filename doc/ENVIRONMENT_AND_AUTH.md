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
- 没有可用的在线供应商认证（包括没有任何带 API Key 的激活订阅）。
- Renderer 无法读取主进程环境报告。

Shell 不可用时，红条会提供“配置 Shell”入口；没有在线认证时会提供“配置供应商”入口。两种情况均可重新检测。

Shell 路径由主进程持久化，Renderer 只拥有读取、原生浏览和检测白名单接口。候选路径必须是本机绝对路径，文件名为 `bash`/`bash.exe`、`powershell.exe` 或 `pwsh`/`pwsh.exe`，并成功执行固定 sentinel 命令后才会保存。Bash 使用 `-lc`，PowerShell 使用 `-NoLogo -NoProfile -NonInteractive -Command`。当前开发态 npm 与外部 Pi CLI 探测也通过该 Shell 运行。应用没有向 Renderer 或 Agent 暴露任意 Shell 命令接口。

## 3. 订阅档案体系

“供应商”设置页使用**订阅档案**来管理在线模型供应商。每份档案是一组可以真正发起模型请求的配置：

- 显示名称
- Provider ID（同时作为 Pi 运行时 provider id 与凭据存储键）
- API 类型，可选其一：
  - `openai-completions`（OpenAI Completions）
  - `openai-responses`（OpenAI Responses）
  - `anthropic-messages`（Anthropic Messages）
  - `google-generative-ai`（Google Generative AI）
- BaseURL
- API Key（由主进程 `safeStorage` 加密保存，绝不下发 Renderer）
- 模型列表，每项包含模型 ID、显示名、上下文窗口（留空按 128k 处理）
- 备注

### 3.1 空状态与入口

- 没有任何订阅档案时，供应商页显示：“暂无订阅档案。可点击「导入已有」从 Pi / cc-switch 同步，或新建 / 从预设添加。”
- 右上角有三个按钮：
  - **导入已有**：自动检测 Pi auth/models 与 CC Switch 本机可用的订阅并导入。
  - **新建**：打开新建供应商页，逐项配置。
  - **从预设添加**：从内置常用预设清单选择，用预设值预填表单。

### 3.2 新建供应商页

字段与校验：

- 显示名称、Provider ID、API 类型、BaseURL、API key 为必填（BaseURL 会去除尾部 `/`）。
- 模型列表：每行含模型 ID、显示名、上下文（留空按 128k）。模型列表上方有**拉取模型**按钮，会根据 BaseURL/API key/API 类型向供应商的 `/models` 接口拉取模型列表并回填。
- 备注为可选，上限 2000 字符。

### 3.3 预设清单

内置常用预设对齐 CC Switch 常见供应商，包括 OpenAI（Responses）、OpenAI（Completions）、Anthropic、Google Gemini、DeepSeek、Moonshot/Kimi、Groq、OpenRouter。预设只提供参数与常用模型，不包含任何密钥。

## 4. 导入已有

“导入已有”会执行以下只读检测并生成订阅档案（去重：Provider ID + BaseURL 相同则跳过）：

### 4.1 Pi 登录状态

- 读取标准 Pi coding-agent `auth.json`（`%PI_CODING_AGENT_DIR%/auth.json`，未设置时 `~/.pi/agent/auth.json`）。
- `openai` 的 `api_key` 凭据 → 生成 OpenAI（Responses，`https://api.openai.com/v1`）订阅。
- `openai-codex` OAuth 订阅暂不迁移为档案，仅保留旧运行时通道（界面已隐藏）。
- 会把标准 Pi 凭据只读复制到应用自己的加密存储（`importPiCliCredentials`），不覆盖应用内已配置凭据，不回写外部文件。

### 4.2 CC Switch

- 使用 Electron 内置 Node 的 `node:sqlite` 以只读方式打开 `~/.cc-switch/cc-switch.db`。
- 读取 `providers` 表并按 `settings_config` 映射：
  - `codex`：解析 config TOML 中 `[model_providers.<id>]` 的 `base_url`/`wire_api`/`name` 与顶层 `model`，从 `auth.OPENAI_API_KEY` 取密钥 → OpenAI Completions 或 Responses。
  - `claude` / `claude-desktop`：从 `env.ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`（或 `ANTHROPIC_API_KEY`）→ Anthropic Messages。
  - `gemini`：从 `env.GOOGLE_GEMINI_BASE_URL` + `GEMINI_API_KEY`（或 `GOOGLE_API_KEY`）→ Google Generative AI。
  - `grokbuild`：解析 `[model.<id>]` TOML 的 `base_url`/`api_key`/`api_backend` → OpenAI Completions 或 Responses。
- 跳过 `category = "official"` 的官方种子以及无法映射的条目，并在结果中报告跳过数量。
- CC Switch 数据库缺失、被占用或损坏时静默降级，不会阻塞导入。

## 5. 运行时选择

Agent 请求时按以下顺序选择认证：

1. **激活订阅**：存在激活订阅且有 API Key 时，使用该档案的 Provider ID、API 类型、BaseURL、API Key 与默认模型动态构建 Pi provider。
2. 尚未迁移完成的旧版应用 API Key。
3. 应用加密存储中的 ChatGPT Plus/Pro OAuth。
4. 应用加密存储中的 OpenAI API Key，或 `OPENAI_API_KEY`。
5. Pi faux 离线 Provider。

激活订阅通过 `createProvider` 在运行时装配：`api` 按 API 类型选择对应的 lazy adapter（OpenAI Completions / Responses、Anthropic Messages、Google Generative AI），模型由档案中的模型列表映射（上下文默认 128k，BaseURL 直接写入每个模型）。离线 Provider 只用于演示 Agent 编排与权限边界，不是本地大模型，也不会产生云端音乐生成质量。

## 6. 安全边界

- 所有认证与订阅操作只在 Electron 主进程执行。
- preload 只暴露严格白名单 IPC。
- Renderer 不保存、不读取和不记录任何凭据；订阅摘要只包含“是否已配置 Key”的布尔值。
- API Key、OAuth Token 不会写入 `.magent` 或 MIDI 文件。
- 订阅档案元数据（不含 Key）存于 `subscriptions` 配置；API Key 经 Electron `safeStorage` 加密后单独保存。
- 每个窗口同一时间只允许一个 OAuth 登录和一个 Agent 请求。
- OAuth 登录地址会校验协议与主机名。
- Agent 仍然没有直接应用 MIDI 修改、写文件或导出文件的工具。

## 7. 验证范围与限制

已经自动验证：

- 环境诊断数据结构和 Node 版本边界。
- 正式安装逻辑中 npm、全局 Pi CLI 均不是必需项。
- 订阅档案 CRUD、激活、导入去重、Key 加密往返与删除；摘要不泄露 Key。
- CC Switch 数据库读取与各类 provider 的 best-effort 映射。
- 订阅 → pi-ai 模型映射与自定义 provider 构建。
- Provider 状态不会返回测试用密钥内容。
- Renderer → sandbox preload → IPC → 环境诊断和 Pi 离线 Agent 的真实 Electron 链路。

尚未自动验证：

- 真实 API Key 请求（各订阅 API 类型的真实模型调用）。
- 拉取模型接口对各类供应商 `/models` 返回结构的兼容性。
- 真实 ChatGPT Plus/Pro 登录后的模型 entitlement。
- OAuth 回调端口被占用、网络代理和企业登录策略等现场环境。
- 真正 `win-unpacked` 或 NSIS 安装版在完全未安装 npm/Pi 的电脑上的启动行为。
- 内置 Pi 包严重损坏时的应用内红条。当前 Pi 是主进程静态依赖，模块完全无法加载时可能在窗口创建前退出，应由安装器完整性检查或修复流程覆盖。
