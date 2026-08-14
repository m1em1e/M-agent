# 音源系统状态

> 状态基线：2026-08-15
> 范围：M/agent 轻量 MIDI 试听 + 音源管理（系统级托管目录 + 项目级绑定）。不做 DAW 级混音、效果器与 VST3 host。
> 换机续接：见 [CONTINUATION.md](CONTINUATION.md)（含 VST3/Agent 集成的下一步入口）。

## 设计原则

MIDI 编辑层（钢琴卷帘、轨道）只与统一的 `Instrument` 抽象交互，不依赖具体音频引擎。
不同音源格式（SoundFont / SFZ / 未来 VST3）是独立的 Provider / Backend，互不强耦合。

音源分为两级：

```
MIDI Track ── InstrumentReference（可序列化，libraryId）
                ├─ 项目级音源库（随 .magent 保存的 instruments 快照）
                │    └─ 绑定即生效，保存工程时落盘；换机会失效
                └─ 系统级音源库（托管目录，跨工程共享）
                     ├─ 目录：默认 ~/Documents/m-agent/Instruments（可配置）
                     ├─ 来源：递归扫描目录下的 .sf2/.sf3/.sfz
                     └─ SoundFont Engine（SpessaSynth）✅ / SFZ Engine ✅ / VST3 ❌
AudioEngine ── Web Audio (AudioContext) + AudioWorklet
```

## 已完成

### 数据契约与核心抽象
- `src/shared/instrument.ts`：`InstrumentReference`（soundfont / sfz 联合类型）、
  `InstrumentLibraryEntry`、`SoundFontPresetInfo`、`SfzRegion`、`ProjectInstrument`、
  `buildProjectInstruments`（保存快照）等跨进程类型与纯逻辑。
- `src/shared/midi.ts`：`MidiTrack` 可选 `instrument?` 与 `volume?`；`MidiProject.instruments?`（项目级清单）。
- `src/core/audio/instrument.ts`：统一 `Instrument` 接口
  （`load/unload/noteOn/noteOff/controlChange/programChange/dispose`），引擎无关。
- `src/core/audio/registry.ts`：纯逻辑 `InstrumentRegistry`，可单测。

### 主进程音源库（系统级托管目录）
- `src/main/soundfont-parser.ts`：用 `spessasynth_core` 解析 SF2/SF3（bank/program/preset）；
  `parseSfz` 读取 SFZ 文本并解析相对采样路径。
- `src/main/audio/system-scan.ts`：递归收集目录下 .sf2/.sf3/.sfz（纯 fs，可单测）；
  `stableId` 按路径生成稳定 id。
- `src/main/audio/library-store.ts`：electron-store 持久化系统目录路径（默认
  `documents/m-agent/Instruments`）、扫描缓存（path+mtime+解析结果）、禁用路径。
  目录扫描条目 + 解析缓存 + 启用状态；`setSystemInstrumentPath(path, migrate)` 支持迁移。
- `src/main/audio/library-ipc.ts`：IPC
  （list / pick-files / bind-instrument / get-set-system-path / open-system-folder /
  set-enabled / read-file）。文件读取走主进程，渲染进程不直接碰文件系统。

### 项目级音源库（随工程）
- `.magent` 的 `instruments` 数组保存项目级音源：绝对路径 + presets/sfzRegions 完整快照。
- `project-adapter` 校验清单（id/type/path 上限、≤256 条）；`rendererPayloadToProject` 深拷贝。
- 添加页项目级 dropzone 绑定即生效（解析为快照，不写系统库）；保存工程时自动快照被引用音源。
- 工程迁移到其他电脑后，绝对路径失效 → 回退系统级/振荡器（已知限制）。

### 渲染进程音频
- `src/renderer/audio/audio-engine.ts`：`AudioEngine` 管理 AudioContext 与
  SpessaSynth `WorkletSynthesizer`；按 `track.instrument` 路由，无音源时回退 Web Audio 振荡器。
- `src/renderer/audio/soundfont-engine.ts`：共享合成器宿主，库 → (bank, program) 路由。
- `src/renderer/audio/sfz-engine.ts`：SFZ 采样引擎，按 libraryId 缓存采样解码，
  键区/力度区命中区域发声（含 tuning/volume/pan/attack-release/loop）。
- 播放/点击试听按轨道 `playTrackNote` 发声，音源解析按 `findInstrumentEntry`（工程级 → 系统级）。

### SFZ 采样（2026-08-14 完成）
- `src/core/audio/sfz-parser.ts`：纯文本解析器（`parseSfzText`），覆盖
  `<global>/<group>/<region>/<control>` 继承、注释、带引号路径，以及
  sample/key/lokey/hikey/lovel/hivel/pitch_keycenter/tuning/volume/pan/loop*/amp_env_*；
  `selectSfzRegions` 按音符与力度选择命中区域（支持力度分层叠加）。
- 采样解码走 Chromium 内置 `decodeAudioData`（WAV/FLAC/OGG）；渲染进程经
  `instrument-library:read-file` IPC 读取采样文件。

### 界面
- 设置 → 音源：镜像供应商栏的两视图：
  - 列表视图（默认）：系统级条目（启用/禁用）+ 工程绑定条目（「工程」标记 + 移除绑定）+
    「扫描音源库」+ 右上角「添加」。
  - 新建音源库视图：项目级音源库（标题 + 描述 + 迁移注意事项 + 虚线放置区，绑定即生效）、
    系统级音源库（描述 + 右侧「打开文件夹」）、系统级音源库路径配置（默认
    `~/Documents/m-agent/Instruments`，修改时应用内确认面板询问是否迁移）。
- 启动时系统级与工程级音源均为空且未手动关闭时，顶部显示黄色可关闭警告，引导配置。
- 轨道检查器：音量滑块 + 音色选择（系统级 + 工程级 SoundFont/SFZ 合并；工程条目带「工程」标记）。

### 工程持久化
- `toProjectPayload` / `projectToTracks` 串联 `instrument` / `volume` / `instruments`；
  `.magent` 保存、加载保留轨道音源引用与项目级音源清单。
- 主进程 `assertProjectFile` / `assertRendererProjectPayload` 校验音源引用、音量与音源清单。

### 构建与安全
- CSP 增加 `'wasm-unsafe-eval'`（SpessaSynth 内部 WASM 编译必需）。
- Vite 构建时把 `spessasynth_processor.min.js` 拷贝到 `dist/` 根目录。
- 音源文件仅记录路径，不随工程复制，不包含任何凭据。

## 未完成 / 已知限制

### SFZ（已实现，仍有轻量边界）
- SFZ 支持最小 opcode 集与单次试听发声，已可用于实际音色；已知简化：
  - 采样文件的 offset/end 截取未支持；多 region 同时命中时按力度分层叠加发声。
  - envelope 仅取 `amp_env_attack` / `amp_env_release`，未实现完整 ADSR 与曲线。
  - 未实现 SFZ 的琴键切换（keyswitch）、随机/交替层、EQ/滤波器与调制 opcode。
  - 采样按需懒解码；首次发声个别采样可能略有延迟。

### VST3
- **完全未接入**。无扫描、无加载、无 MIDI/音频/参数/State/插件 UI。
- 原因：VST3 host 需要原生模块 + 三平台编译 + 插件崩溃隔离，
  与「轻量试听」定位不符；高级处理由用户导出 MIDI 后在专业 DAW 中完成。
- 候选方案调研结论（`nvst3-host` 等）见开发记录；当前不建议直接采用。

### 其他
- 未提供音源预设搜索（设置页内按名称/类型浏览）；轨道选择器平铺全部 preset，大型音源库下拉较长。
- 播放仍为 rAF 驱动的简化调度，未做采样级精确时钟；试听场景可接受。
- 轨道仅支持音量，未做 pan / 单轨 mute-bus；muted/solo 沿用工程字段。
- 真实 .sf2/.sf3 文件解析尚未在自动测试中覆盖（本机无测试音源文件），
  依赖 spessasynth 官方解析器（signal 生产使用）与用户实际导入验证。
- 项目级音源存绝对路径快照，工程迁移/文件移动后绑定失效（界面已提示）。
- 系统级目录扫描为递归全量；首次进入大目录时解析可能较慢（按文件缓存）。

## 验证方式

- `npm run typecheck`、`npm test`、`npm run build`。
- 手动：音源栏 → 打开文件夹放 .sf2 → 扫描 → 轨道检查器选音色 → 试听；
  添加页项目级 dropzone 绑定 → 保存 .magent → 重新打开仍可选；
  修改系统目录路径 → 确认面板迁移。
- 真实 worklet 加载已通过 Electron `file://` 冒烟验证。
