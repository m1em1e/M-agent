# M Agent 尚未完成与已知限制

> 本文件汇总原 `TODO.md`、`INSTRUMENTS.md`（未完成/限制部分）、`PLAN.md`（阶段 E/F）、
> `CONTINUATION.md`（待办项）中的未完成内容。
> 优先级含义：P1 为主要功能缺口，P2 为后续完善。已实现内容见 [IMPLEMENTED.md](IMPLEMENTED.md)。

## P1：主要功能与正确性缺口

1. **目标模式评估闭环未完成**：真实 Pi 路径未复用 `GoalRunner` 的成本预算、确定性评分、排序与诊断；界面候选分数按候选顺序生成，不是模型或确定性评估结果。待办：统一 Pi 编排与 GoalRunner，或把预算与评估能力迁入 Pi 运行层。
2. **设置板块后端能力尚未补齐**（**已移至长期**，独立大功能）：用量（Pi Token/费用/模型/按日统计未持久化）、插件（无清单/Manifest/权限/安装/启停/隔离执行）、插件主题贡献尚未实际载入、多设备偏好同步未实现。在相应后端完成前不得显示伪造的费用/设备/插件数据。

## P2：跨平台、数据契约、安全与体验完善

### 真实云端 Provider 测试（由 P1 移入 P2）
- 自定义供应商（OpenAI Responses 等）已实现并可在应用中实际添加与使用；`tests/agent/cloud-provider.test.ts`（`MAGENT_CLOUD_API_KEY` 门控）已用真实 Key 验证 research/plan/goal 三模式与错误 Key 可辨识报错。**剩余**：ChatGPT Plus/Pro OAuth entitlement 真实请求验证（需真实账号现场登录）。

### Shell 与跨平台桌面验证
- 未在 Windows / Linux 验证真实 Bash/PowerShell 探针成功路径、应用内菜单栏与标题栏（非 macOS）、smoke 全量断言。
- 未在 Windows Git Bash、WSL Bash、PowerShell 5.1/7、macOS/Linux `pwsh` 上做真实交互验证。
- 原生文件选择器取消/选择、超时、输出上限与并发 IPC 边界的真实主进程集成测试未覆盖。
- 后续需要 Shell 的主进程功能必须复用 `runConfiguredShellCommand`，不得用 `cmd.exe`、`shell: true` 或向 Renderer/Agent 暴露任意命令 IPC。

### 发布与打包验证
- 无 npm/Node/Pi CLI 的干净 Windows 环境验证未做。
- 代码签名（Windows/macOS 公证）与三端发布验证未完成。

### 音源系统完善
- **预设搜索**：设置 → 音源 列表与轨道选择器平铺全部 preset，大型音源库下拉较长；可复用供应商预设搜索模式。
- **项目级音源路径失效提示**：`instruments` 存绝对路径快照，换机/移动后绑定失效（新建页已提示；轨道级「缺失回退振荡器并提示」未实现）。
- **系统级目录扫描性能**：首次进入大目录全量解析可能卡顿；可加后台扫描、进度提示或缓存预热。
- **迁移健壮性**：`setSystemInstrumentPath(migrate=true)` 跨设备复制中途失败会留半迁移状态；可先复制、校验成功后删旧目录，失败回滚清理。
- **真实音源文件解析未纳入自动测试**（本机无测试音源文件）；可增加小型样本与损坏文件用例。
- 可选：系统级条目「带二次确认的删除文件」入口（当前移除=仅禁用）。

### 数据契约、安全与编辑器
- 严格限制 `Revision.source` 与 `AgentSession.mode` 枚举值；明确空 `tempoMap` / `timeSignatures` 规范化策略；限制工程标题长度并清理 Windows 非法字符。
- 钢琴卷帘：框选、复制粘贴、多音符批量编辑与更完整的播放控制（当前 rAF 驱动，非采样级时钟）。
- 增加真实 MIDI 文件、超大工程、损坏工程、音源文件与安装包自动化测试。
- 增加可见的取消 Agent 操作、流式输出与会话管理（取消与实时状态已实现；会话管理未做）。

## 音源系统已知限制

- **SFZ 简化边界**：已支持完整 ADSR 包络（`amp_env_*`/`ampeg_*` 两前缀，含 decay/sustain/hold）、采样 `offset`/`end` 截取、力度曲线 `amp_veltrack`、
  `tune`/`pitch` 别名与 `delay`/`pitch_keytrack`/`pitch_offset`、滤波器（`fil_type`/`cutoff`/`resonance`）、分组行为（`seq_length`/`seq_position` 轮换、`random`、`trigger` attack/release）、
  keyswitch（`sw_lokey`/`sw_hikey`/`sw_default`）、`<include>` 递归加载、LFO 调制（pitch/pan/amp）与 pitch 包络；
  未实现 `fil_env`（滤波包络）、`amp_velcurve`（多值力度曲线）、`trigger first`/`legato` 完整语义；采样按需懒解码，首次发声个别采样可能延迟。
- **CC64 延音踏板未支持**：当前延音为音符级 noteOn/noteOff（SoundFont / SFZ / 振荡器统一释放）；MIDI CC64 延音踏板（sustain pedal）尚未实现，需扩展 MidiNote/工程数据、SMF 导入导出与钢琴卷帘 UI。
- **VST3 完全未接入**（无扫描/加载/MIDI/音频/参数/State/插件 UI）。调研结论：`nvst3-host` 不适合生产
  （无进程隔离、无音频 I/O、Intel Mac 无预编译、Linux 需 glibc≥2.28）；替代方向为独立原生音频服务（JUCE/Rust），
  或先做 Node PoC。当前定位轻量试听，高级处理由用户导出 MIDI 到专业 DAW。
- **播放调度**为 rAF 驱动逐音符触发，轻量试听够用；采样级精确需改用 AudioContext 时钟调度（非紧急）。

## SFZ 未完成项（相对 SFZ v1/v2 全量）

- **交叉淡化（键/力度）**：`xfin_lokey/hikey`、`xfout_lokey/hikey`、`xfin_lovel/hivel`、`xfout_lovel/hivel`（区域间键/力度过渡）；`xfin_ccN`/`xfout_ccN`（CC 淡化）未实现——需与 CC 状态统一做。
- **滤波包络**：`fil_env_depth/attack/decay/sustain`（截止扫频）。
- **力度曲线（多值）**：`amp_velcurve_N`（力度→音量曲线；与 `amp_veltrack` 并存，曲线优先）。
- **trigger 完整语义**：`trigger=first`/`legato`（按同 channel 活动音符判断连奏）、`release_time`（release 采样延迟）；`release_time` 已支持。
- **调制补全**：`pitch_veltrack`/`cutoff_veltrack`/`pan_veltrack`、LFO `delay` 已支持；LFO `*_lfo_shape`（sine/triangle/square/sawtooth）与 `*_lfo_phase`（sine 用 PeriodicWave 起振）已支持。
- **keyswitch 补全**：`sw_last`/`sw_previous` 已支持（切换后保持 / 回退上一键）。
- **CC 调制**：`cc_*`、`oncc_*`、`set_cc`（MIDI CC 实时调制音色参数）。
  已支持：轨级 `controllerEvents`（含 CC64 延音踏板）、SMF `0xb0` 导入导出、播放/导出应用 CC、SFZ `xfin_ccN`/`xfout_ccN` CC 淡化、`on_ccN` CC 触发切换、`ccN_amp`/`ccN_pitch`/`ccN_cutoff`/`ccN_pan` 参数调制、CC64 踏板延音（SoundFont 经 controllerChange、SFZ held 音符统一释放）、钢琴卷帘 CC64 lane 编辑。
- **SFZ v2 合成**：`oscillator` 波形发声（OscillatorNode，非采样，含 ADSR/滤波/LFO/CC 调制链）、`playback_rate`（采样变速变调 / 振荡器频率倍率）。
- **v2 控制指令**：`on_cc`（CC 值变化触发区域，短促播放）、`#include` 变体（`#include "path"` 语法）、`hint_*` 元数据（解析存储，对发声无影响）。
- **include 变更监听**：主文件解析的 include 文件修改后，音源库扫描缓存（按 mtime）未链式失效，需重建扫描缓存。
  已实现：`parseSfz` 返回 `files`（主 + include 链），`library-store` 缓存记录 `fileMtimes`，任一 include 文件 mtime 变化即重新解析。

## SFZ 已实现功能手动测试清单（A–F 及后续新功能，均尚未手动验证）

> 以下均为**真实音源试听**层面的手动验证；自动化单测已覆盖解析器/选择器逻辑，但不验证实际听感。建议各造一个最小测试 SFZ（一个 `<region>` + 一个短 WAV 采样）验证，验证后即删。

- **A · 补全与别名**：`tune`/`pitch`（Salamander Retuned 用 `tune=10`，与主版音高对比应一致）；`delay=0.05`（发声延迟）；`pitch_keytrack=0`（不同键音高不变）；`pitch_offset=12`（音高上移一个八度）。
- **B · 滤波器**：同一采样两份 SFZ `fil_type=lowpass cutoff=300` vs `cutoff=8000`，对比低频版发闷（高频被滤）；`resonance=20` 增强共振峰。
- **C · 分组行为**：`seq_length=2` + `seq_position=1/2`（两个不同音高采样）连续点击同一键，应交替发声；`random=0` 与 `random=100` 区域多次触发观察随机变体；`trigger=release` 区域在 noteOff 时发声。
- **D · keyswitch**：`sw_lokey=72 sw_hikey=72` 与 `sw_lokey=60 sw_hikey=60` 两组区域，按 72/60 键后再按普通键，应切换到对应音色层；无激活键时 `sw_default=1` 区域生效。
- **E · include**：主 SFZ `<include>sub/piano.sfz</include>` + 子文件（含 `default_path` 与采样），扫描后应合并发声；include 循环应被截断（不卡死）。
- **F · 调制（LFO/pitch 包络）**：`pitch_lfo_freq=6 pitch_lfo_depth=15` 长音符应可听颤音；`pan_lfo_freq=2 pan_lfo_depth=50` 声像左右摆动；`amp_lfo_freq=5 amp_lfo_depth=20` 音量抖动；`pitch_env_depth=100`（上行滑音包络）音头音高变化。
- **交叉淡化（键/力度）**：`lokey=40 hikey=60 xfin_lokey=36 xfout_hikey=64` 边界附近试听音量渐变（36→40 渐入、60→64 渐出）；力度淡化同理用 `xfin_lovel`/`xfout_hivel`。
- **滤波包络（fil_env）**：`fil_env_depth=400 fil_env_attack=0.1 fil_env_decay=0.2` 音头截止扫频（发亮→回落）；`fil_env_sustain` 控制回落后电平。
- **力度曲线（amp_velcurve）**：`amp_velcurve_30=0.2 amp_velcurve_100=0.9` 不同力度触发，音量按曲线插值（非默认线性）。
- **trigger 补全（first/legato/release_time）**：`trigger=legato` 区域仅在连奏（前音仍按）时发声；`trigger=first` 区域首音发声；`release_time=0.05` release 采样延迟触发。
- **调制补全（veltrack/LFO delay）**：`pitch_veltrack`（力度越大音越高）、`cutoff_veltrack`（力度越大滤波越开）、`pan_veltrack`（力度越大声像越偏）；`*_lfo_delay` LFO 延迟起振。
- **keyswitch 补全（sw_last/sw_previous）**：`sw_last=0` 区域松开 keyswitch 键后回默认；`sw_previous=1` 区域按此键回退到上一个激活键。
- **LFO 波形/相位**：`pitch_lfo_shape=triangle` 对比 sine 的颤音听感；`pitch_lfo_phase=180` 起始相位差异。
- **include 变更监听**：修改主 SFZ 的 include 子文件后，重新「扫描音源库」应反映变更（缓存按 mtime 链式失效）。
- **延音（noteOn/noteOff）**：Salamander 钢琴长音符按住持续、到结束 tick 释放；试听按音符时长延音；暂停/停止立即切断；循环区音符 on/off 正常。

## 阶段 E：可靠性完善（下一阶段）

1. 目标模式接入真实预算、评分、排序与诊断闭环（对应 P1-1）。
2. 已更新 Shell 的 Electron 烟测 + 三平台真实 Bash 验证（对应 P2 跨平台）。

## 阶段 F：发布准备（尚未完成）

1. 固化 Windows 打包分发路径，完成 NSIS 安装/卸载测试。
2. 真实 OpenAI API 链路测试（错误/超时/额度）。
3. 干净 Windows 安装环境验证启动诊断。
4. 代码签名、应用图标、版本信息与发布检查清单。

## 音频导出（已实现，残余项）

WAV / OGG(Vorbis) 音频导出已实现（见 IMPLEMENTED.md 第 10 节）。仍待完善：

- 导出范围当前为**完整工程**；仅导出循环区（loopRegion）已支持（见 IMPLEMENTED.md）。
- 渲染速度使用与播放一致的单一速度，未按工程 tempoMap 的多段速度映射导出。
- 真实 SoundFont/SFZ 混排工程的导出已在本机端到端验证；多音源库（同一工程多个 SoundFont）与跨平台桌面导出手测未覆盖。

## 明确不应宣称完成的事项

- 三端安装包已完成签名和发布验证。
- 真实 OpenAI 云端链路已通过自动化端到端回归测试（应用内已可实际使用自定义供应商，但自动化真实请求测试未覆盖）。
- 大型 MIDI 工程已稳定支持。
- 目标模式已有完整成本预算和音乐评分系统。
- 两级音源库已在三平台真实桌面交互中完整验证（目前仅 macOS 冒烟通过）。
- Skill 嵌套调用已在真实云端模型上端到端验证（目前仅离线脚本化 tool loop 与单测覆盖）。
