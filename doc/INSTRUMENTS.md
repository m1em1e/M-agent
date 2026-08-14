# 音源系统状态

> 状态基线：2026-08-14
> 范围：M/agent 轻量 MIDI 试听 + 音源导入。不做 DAW 级混音、效果器与 VST3 host。

## 设计原则

MIDI 编辑层（钢琴卷帘、轨道）只与统一的 `Instrument` 抽象交互，不依赖具体音频引擎。
不同音源格式（SoundFont / SFZ / 未来 VST3）是独立的 Provider / Backend，互不强耦合。

```
MIDI Track ── InstrumentReference（可序列化）
                └─ Instrument Registry（全局音源库）
                     ├─ SoundFont Engine（SpessaSynth）  ✅
                     ├─ SFZ Engine                        ◐ 仅登记，未采样
                     └─ VST3 Host                         ❌ 未接入
AudioEngine ── Web Audio (AudioContext) + AudioWorklet
```

## 已完成

### 数据契约与核心抽象
- `src/shared/instrument.ts`：`InstrumentReference`（soundfont / sfz 联合类型）、
  `InstrumentLibraryEntry`、`SoundFontPresetInfo` 等跨进程类型。
- `src/shared/midi.ts`：`MidiTrack` 新增可选 `instrument?` 与 `volume?`；`TrackInput` 同步。
- `src/core/audio/instrument.ts`：统一 `Instrument` 接口
  （`load/unload/noteOn/noteOff/controlChange/programChange/dispose`），引擎无关。
- `src/core/audio/registry.ts`：纯逻辑 `InstrumentRegistry`
  （增删改查、扫描、启用/禁用、搜索、引用解析），可单测。

### 主进程音源库
- `src/main/soundfont-parser.ts`：用 `spessasynth_core` 的 `SoundBankLoader`
  解析 SF2/SF3，提取 bank/program/preset 清单。
- `src/main/audio/library-store.ts`：electron-store 持久化全局音源库（路径/名称/启用状态/presets）。
- `src/main/audio/library-ipc.ts`：5 个 IPC
  （list / add / update / remove / read-file）。文件读取走主进程，渲染进程不直接碰文件系统。

### 渲染进程音频
- `src/renderer/audio/audio-engine.ts`：`AudioEngine` 管理 AudioContext 与
  SpessaSynth `WorkletSynthesizer`；按 `track.instrument` 路由，无音源时回退 Web Audio 振荡器。
- `src/renderer/audio/soundfont-engine.ts`：共享合成器宿主，库 → (bank, program) 路由。
- 播放循环（rAF 驱动）已改为按轨道 `playTrackNote` 发声，保留 `muted/solo/volume` 处理。
- 点击/绘制/双击音符试听同样走 `playTrackNote`（跟随选中轨道音源）。

### 界面
- 设置 → 音源：音源库管理（添加 SoundFont / SFZ、启用/禁用、移除、空状态提示）。
- 轨道检查器：音量滑块 + 音色选择（SoundFont 库 + preset 平铺下拉 + 音色号细调）。

### 工程持久化
- `toProjectPayload` / `projectToTracks` 已串联 `instrument` / `volume`；
  `.magent` 保存、加载、导出 MIDI 均保留轨道音源引用。
- 主进程 `assertProjectFile` / `assertRendererProjectPayload` 校验音源引用与音量合法性。

### 构建与安全
- CSP 增加 `'wasm-unsafe-eval'`（SpessaSynth 内部 WASM 编译必需）。
- Vite 构建时把 `spessasynth_processor.min.js` 拷贝到 `dist/` 根目录
  （dev server 通过中间件 serve），`file://` 与 dev 下 worklet 均能加载。
- 音源文件仅记录路径，不随工程复制，不包含任何凭据。

## 未完成 / 已知限制

### SFZ（仅登记，未实现采样）
- 当前 `addInstrument("sfz", ...)` 只登记路径与 preset 名称，**未实现**：
  - SFZ 文本解析（sample/key/lokey/hikey/velocity/lovel/hivel/tuning/volume/pan/envelope）。
  - 采样文件（WAV/FLAC/OGG）加载与映射。
  - SFZ 音色的实际发声。
- 因此轨道选择器只列出 SoundFont，SFZ 仅出现在音源库列表中。

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
- 音源库文件路径变更后工程中的引用会失效，需重新导入同一音源。

## 验证方式

- `npm run typecheck`、`npm test`、`npm run build`。
- 手动：设置 → 音源 → 添加 .sf2 → 轨道检查器选择音色 → 播放/点击试听。
- 真实 worklet 加载已通过 Electron `file://` 冒烟验证。
