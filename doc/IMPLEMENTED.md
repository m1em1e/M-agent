# M Agent 已实现功能总结

> 本文件汇总原 `PROGRESS.md`、`SKILLS.md`、`ENVIRONMENT_AND_AUTH.md`、
> `AGENT_CONTEXT_PROMPT.md`、`INSTRUMENTS.md`（已完成部分）与 `PLAN.md`（已完成阶段）中的已实现内容。
> 仅记录已实现或实际验证过的内容。未完成部分见 [INCOMPLETE.md](INCOMPLETE.md)。

## 1. MIDI 核心

- MIDI 工程、轨道、音符、速度图、拍号和循环区数据模型（`.magent` JSON，2 空格缩进）。
- Standard MIDI File Type 0/1 导入、导出；Type 0 按 Channel 拆轨，Type 1 保留 Conductor 与轨道信息。
- 音高、力度、Tick、轨道 Channel、Program 等领域校验；结构化编辑、原子变更集与事务历史。
- 非 480 PPQ 工程支持，Tick 使用整数。
- 数值边界：tick 非负整数、durationTicks ≥ 1、pitch 0–127、velocity 1–127、轨道 ≤ 256、音符总量 ≤ 200,000。

## 2. 桌面编辑器

- 三栏桌面界面、轨道列表、Transport 与 Canvas 钢琴卷帘。
- 音符绘制、选择、移动、右缘缩放、删除、力度编辑；网格与横向缩放。
- 多轨 Mute、Solo、新建轨道、删除轨道（可撤销）；Web Audio 试听（SoundFont/SFZ/振荡器回退）。
- 撤销、重做与单事务候选应用；撤销栈为「完整编辑快照」（轨道 + tempo + 拍号 + 循环区），一次 Ctrl+Z 可整单撤销含工程级操作的候选。
- `.magent` 打开再保存保留工程 ID、Tempo Map、拍号、循环区、修订与 Agent 会话。
- 启动体验：新建项目为完全空工程（0 轨道，隐藏空检查器、时长随最长轨道 bar:beat + mm:ss、欢迎语）；
  启动自动打开最近一个工程，无最近工程则新建空工程。
- 播放：SoundFont 音符按 `durationMs` 定时 `noteOff` 释放；暂停/停止/开新工程 `stopAll()`（含 SFZ）；播放音符时长上限 300→8000ms。
- Agent 回复 Markdown 渲染（`react-markdown` + `remark-gfm`，安全剥离原始 HTML，支持表格/删除线/任务列表）。
- 对话模型选择器：切换当前激活订阅的模型并持久化到订阅档案（`activeModelId`）。
- macOS 无应用菜单下补回 Cmd/Ctrl+C/V/X/A 剪贴板快捷键（主进程 `before-input-event` 分发）。

## 3. Pi Agent

- Pi Agent 是当前真实运行路径的底层内核（`@earendil-works/pi-agent-core` + `@earendil-works/pi-ai`）。
- 受控工具：`inspect_midi_project`、`analyze_midi_project`、`propose_midi_changes`；
  `instrument_search`、`set_track_instrument`；Skill 作用域内 `list_skills` / `load_skill` / `invoke_skill`。
- `research` 不注册候选工具并在权限层再次阻止越权；`plan` 候选保持预览；`goal` 受预算约束且需用户确认。
- 候选经 Schema + MIDI 领域校验；最多三个，重复候选 ID 被拒绝。无 API Key 时使用 Pi faux Provider 离线演示。
- 三模式权限继承贯穿 Agent、Skill 子调用与候选应用（只读调研、计划预览、目标确认）。
- Agent 实时状态（2026-08-16）：`onAgentLive` 把工具开始/结束、轮次、Skill 调用实时推送到 Agent 面板状态条；
  思考增量流式写入对话，每段完成后自动收起（`agent-live` + 折叠 `<details>`）。
- Agent 取消（2026-08-16）：去掉 `agent:run` 固定墙钟超时（长任务不再被打断），新增 `agent:cancel` IPC 与「取消」按钮；
  中止/超时诊断附带工具调用计数与最近序列；子 Skill 超时可在「设置 → 通用 → 对话」配置（秒，留空不限时）；瞬时流/网络错误仍自动重试一次。
- Agent 请求超时不设固定墙钟：由用户取消、Token/轮次预算与（可配置的）子 Skill 超时兜底；`cleanAgentError` 剥离 IPC 封装并提取供应商错误 message。

## 4. 候选应用与撤销

- 界面候选可原子应用 MIDI 核心定义的全部 10 种操作：`insert_notes` / `delete_notes` / `update_notes` /
  `create_track` / `delete_track` / `update_track`（含 `instrument` 音色）/ `set_tempo` /
  `set_time_signature` / `set_loop` / `clear_loop`。
- 应用前在克隆工程上验证所有操作，任一失败则整个候选不提交；只允许应用 `goal` 模式生成且仍有效的候选；
  已应用/已忽略的候选不能重复应用；普通编辑、撤销、重做会清理过期候选状态。

## 5. Skill 系统（嵌套调用）

- `@skill-name` 触发顶层 Skill；输入框 `@` 弹出 Skill 选择列表（↑/↓ 选择、Enter 确认、Esc 关闭）。
- 运行时工具 `list_skills` / `load_skill` / `invoke_skill` 仅在 Skill 作用域注册；子 Skill 继承父模式递归运行，
  返回结构化 `SkillInvocationResult`。
- 防递归与预算：深度 ≤ 2、每父 ≤ 4、全局 ≤ 8；禁止 self 与环（visited 调用链检测）；子调用继承父 AbortSignal、可取消。
- 确定性合并引擎 `mergeSkillOperations`：先到先得、绝不 last-wins；冲突时保留先到者并告警；
  合并候选重新过 `validateChangeSet`。
- 7 份内置 SKILL.md：`song-arranger`（顶层编排）、`harmony-arranger`、`melody-arranger`、
  `rhythm-arranger`、`bass-arranger`、`orchestration-arranger`、`humanize-performance`。
- 用户自定义：在 Skill 目录（开发态仓库根 `skills/`，打包态 `resources/skills`）新建 `<name>/SKILL.md`
  （YAML frontmatter name/description + 正文）即生效，应用每次运行现读，可与内置 Skill 互委托。
- 可观测性：`AgentResponsePayload.skillTrace` 返回每次子调用记录，界面可折叠展示；`console.debug` 输出调用日志。

## 6. 音源系统（两级音源库）

- **抽象**：`src/core/audio/instrument.ts` 统一 `Instrument` 接口（load/noteOn/noteOff/controlChange/programChange/dispose），
  MIDI 编辑层只依赖该抽象；`src/core/audio/registry.ts` 纯逻辑可单测。
- **系统级音源库**：托管目录默认 `~/Documents/m-agent/Instruments`（可配置）；递归扫描 `.sf2/.sf3/.sfz`，
  解析结果按「路径+mtime」缓存（`src/main/audio/library-store.ts` + `system-scan.ts`）；「打开文件夹」自动建目录；
  路径变更时应用内确认面板询问是否迁移文件。
- **项目级音源库**：`.magent` 的 `instruments` 数组保存绝对路径 + presets/sfzRegions 完整快照；
  添加页 dropzone 绑定即生效；保存时按轨道引用自动快照（`buildProjectInstruments`，按 id 去重，工程级优先）。
- **SoundFont**：`spessasynth_core` 解析 SF2/SF3（bank/program/preset）；渲染进程 `WorkletSynthesizer`
  按库 → (bank, program) 路由发声（`src/renderer/audio/soundfont-engine.ts`）。
- **SFZ**：`src/core/audio/sfz-parser.ts` 纯文本解析（`<global>/<group>/<region>/<control>` 继承、注释、引号路径，
  opcode：sample/key/lokey/hikey/lovel/hivel/pitch_keycenter/tuning/volume/pan/loop*/amp_env_*）；
  `selectSfzRegions` 按音符与力度选区域（支持力度分层叠加）；采样走 Chromium `decodeAudioData`（WAV/FLAC/OGG）。
- **界面**：设置 → 音源 =「列表 / 新建音源库」两视图；列表含系统级条目（启用/禁用）、工程绑定条目（「工程」标记 + 移除绑定）、
  「扫描音源库」、右上角「添加」；空列表提供「下载推荐音源！」流式下载 GeneralUser GS（约 32MB）到系统目录；
  启动时两级音源均为空且未关闭时显示顶部黄色可关闭警告；轨道检查器提供音量滑块 + 音色选择（系统级 + 工程级合并）。
- **持久化与安全**：`toProjectPayload` / `projectToTracks` 串联 instrument/volume/instruments；
  主进程校验音源引用、音量与清单；CSP 增加 `wasm-unsafe-eval`；Vite 拷贝 `spessasynth_processor.min.js`；
  音源仅记录路径，不复制文件、不含凭据。

## 7. 环境检测与供应商认证

- **Pi 集成方式**：Pi SDK 随应用打包，正式安装版不要求用户安装 npm、全局 `pi` 命令或
  `@earendil-works/pi-coding-agent`；安装版不执行 PATH 中的外部 `pi`。
- **启动检测**：Electron、内置 Node（≥ 22.19）、内置 Pi SDK、统一 Shell（Bash/PowerShell，固定无副作用探针）、
  开发态 npm、可选外部 Pi CLI、`safeStorage`、在线供应商认证；不满足时顶部红色提示并提供「配置 Shell / 配置供应商」入口与重新检测。
- **Shell**：路径由主进程持久化，Renderer 只有读取、原生浏览与检测白名单；候选路径必须是本机绝对路径、
  文件名匹配 bash/powershell/pwsh 且通过固定 sentinel 命令后才保存；Bash 用 `-lc`、PowerShell 用 `-NoLogo -NoProfile -NonInteractive -Command`；
  `runConfiguredShellCommand` 统一入口（开发态 npm/Pi CLI 探测复用）；Renderer/Agent 无通用命令执行能力。
- **订阅档案**：显示名 / Provider ID / API 类型（openai-completions、openai-responses、anthropic-messages、google-generative-ai）/
  BaseURL / API Key（`safeStorage` 加密，不下发 Renderer）/ 模型列表（上下文默认 128k）/ 备注。
  支持「导入已有」（Pi auth.json + CC Switch `providers` 表，只读、去重、不覆盖不写回）、「新建」、「从预设添加」
  （OpenAI/Anthropic/Gemini/DeepSeek/Kimi/Groq/OpenRouter，不含密钥）、「拉取模型」。
- **运行时选择顺序**：激活订阅（含 API Key）→ 旧版应用 API Key → 加密存储的 OAuth → 加密存储的 OpenAI Key / `OPENAI_API_KEY` → Pi faux 离线 Provider。
- **安全边界**：认证/订阅操作只在主进程；preload 白名单 IPC；Renderer 不接触凭据；每个窗口单 OAuth 单 Agent 任务；
  OAuth 地址校验协议与主机名；Agent 无应用修改/写文件/导出工具。

## 8. 设置中心（五板块）

- **通用**：外观（默认/Nord/Tokyo Night/Warn Paper/High Contrast 主题 + 深色/浅色/跟随模式，本机持久化）；
  对话（思考摘要显隐、Pi thinking 默认 medium、目标最大轮次 20、目标累计 Token 预算 500000，IPC 运行时校验）；
  Shell 路径（浏览/检测/可用性）。插件主题贡献目录已预留合并与校验边界（`pluginId/themeId` 命名空间、白名单语义色、不可覆盖内置），尚未实际载入。
- **供应商**：OpenAI API Key 与 ChatGPT Plus/Pro OAuth 登录/退出（OAuth 用 `safeStorage` 加密且不暴露给 Renderer）。
- **用量**：本地会话概览展示（精确 Token/费用尚未接入，见 INCOMPLETE.md）。
- **音源**：两级音源库（见第 6 节）。
- **插件**：显示插件系统规划状态，不扫描/执行第三方插件。

## 9. 菜单、窗口与最近工程

- 菜单单一数据源 `src/shared/menu.ts`（`APP_MENU_GROUPS`）：macOS 原生 Menu Bar 与 Windows/Linux 应用内菜单共用。
- macOS 标题栏去掉 logo 与应用内菜单栏，红绿灯按钮垂直居中（`--titlebar-h: 40px`）；菜单动作经 `menu:action` IPC 转发执行。
- 「文件」菜单：新建项目 / 打开项目 / 最近打开项目（主进程 electron-store 持久化最近 8 个 .magent，原生与 in-app 同步）/
  保存项目（有路径免对话框直写）/ 项目另存为 / 导入（.magent / MIDI）/ 导出 MIDI / 导出 WAV / 导出 OGG / 关闭项目。
- 新建/打开/导入询问「当前窗口 or 新窗口」：新窗口经 `window:create-project` + `--magent-intent` 自动执行对应操作。

## 10. 音频导出（WAV / OGG）

- **渲染**（`src/renderer/audio/render-project.ts`，新增）：`renderProjectToBuffer` 用 `OfflineAudioContext` 离线渲染完整工程
  （tick 0 → 最长轨道末尾，追加 2s 释放尾音，遵守 mute/solo，与播放一致）；空工程输出 1s 静音。
  SoundFont 轨道按音源库分组，用子集 MIDI（`exportMidi` + `BasicMIDI.fromArrayBuffer`）经 SpessaSynth
  `WorkletSynthesizer.startOfflineRender` 按时间精确渲染；SFZ 采样（`selectSfzRegions` + AudioBufferSourceNode）
  与振荡器回退轨道用标准 Web Audio 节点按绝对时间排程；各层最后混音。渲染前校验时长上限（超限抛 `ExportTooLongError`）。
- **编码**：WAV 用 `spessasynth_lib` 的 `audioBufferToWav`（零新增依赖）；OGG(Vorbis) 用 `wasm-media-encoders`
  （新增依赖，WASM 内联为 `data:` URL 加载，故 CSP `connect-src` 需含 `data:`，`wasm-unsafe-eval` 亦已配置）。
- **落盘**：`audio:export` IPC（校验字节上限 → 保存对话框 → 写盘），bridge/preload 新增 `exportAudio`。
- **MIDI 导出增强**：`exportMidi` 对带 SoundFont 音色引用的轨道写出 CC0/CC32 bank select，保留音色 fidelity。
- **UI**：文件菜单「导出 WAV / 导出 OGG」打开导出弹窗（采样率 44100/48000 可选手动，范围=完整工程，导出/取消）；
  `exportBusy` 忙碌态与 toast。
- **设置**：通用 → 导出 → 渲染时长上限（默认 10 分钟，本机持久化 `magent.export.v1`）。

## 11. 验证记录

- `npm run typecheck`、`npm test`（35 文件 / 181 项通过）、`npm run build`、`npm run test:electron` 均通过。
- 音频导出专项验证：Phase 0 在真实 Electron 里验证 `WorkletSynthesizer` + `OfflineAudioContext` 时序正确
  （两音符 MIDI 分别在 0s/1s 起音）；端到端用真实代码渲染「SoundFont + 振荡器」工程，
  得到 WAV（RIFF/WAVE 魔数、~617KB）与 OGG（OggS 魔数、~25KB）均有效。
- 真实 Electron 烟测覆盖：页面渲染、sandbox preload、环境诊断 IPC、五板块设置导航、主题切换/持久化、
  对话设置持久化、Pi 思考摘要、Pi 离线调研链路。
- P0-1 大型工程分析栈溢出已修复（`pitchRange` 单次循环，130,000 音符回归测试）；P0-2 Electron 已升级到 43.4.0（`npm audit` 归零）。
- `package:win` 已生成 NSIS 安装包（约 96 MB，安装态图标与 `build/icon.ico` SHA-256 一致）；`package:mac` / `package:linux` 三端发布打包已验证。
