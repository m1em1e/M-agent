# 音频导出计划（WAV / OGG）

> 状态：计划（未实施）
> 记录日期：2026-08-16
> 目标：把当前工程离线渲染为 WAV / OGG 音频文件。

## 1. 版权说明（已确认）

- **WAV / OGG 格式本身无版权问题**：
  - WAV 为无压缩 PCM 容器，完全开放。
  - OGG 为开放容器；内部 Vorbis / Opus 编解码器均免专利费、BSD 授权。
- **真正的版权考量在音频内容**：导出的声音由当前所选 SoundFont/SFZ 采样合成。
  各音源授权不同（如 GeneralUser GS 允许使用/渲染，部分商业音源限制采样再分发/再采样）。
  「用音源在应用内合成并导出用户自己的 MIDI 作品」属正常使用，与实时播放同性质；
  建议在文档中提示用户留意所用音源授权条款。MIDI 作品本身归用户所有。

## 2. 方案：离线渲染导出

不做实时录音（脆弱、易失真），改用 `OfflineAudioContext` 离线路由一遍工程，
渲染出 PCM 后再编码写入文件。

### 2.1 渲染（`src/renderer/audio/render-project.ts`，新增）
- 按工程时长建 `OfflineAudioContext`：时长 = `maxEndTick / ppq * 60 / tempo`（tick 0 → 最大结束 tick）。
- 在离线 context 上加载音源：
  - SpessaSynth worklet（`spessasynth_processor.min.js`，`audioWorklet.addModule` 支持离线 context）+ 各 SoundFont 库。
  - SFZ 采样引擎（`AudioBufferSourceNode`，离线 context 同样可用）。
  - 无音源轨道回退 Web Audio 振荡器。
- 按音符起止在精确时间 `noteOn / noteOff`（tick → 秒换算，与实时播放一致）。
- `startRendering()` → `AudioBuffer`。
- **技术风险（实现时先最小验证）**：确认 `WorkletSynthesizer` 能否跑在
  `OfflineAudioContext` 上；若不可行，退回方案：
  - 实时回放 + `MediaStreamAudioDestinationNode` 捕获（质量/同步较差，不推荐）；
  - 或改用 SpessaSynth 的非 worklet API（若有）。

### 2.2 编码
- **WAV**：纯 JS 手写 PCM 头 + 采样（无依赖，约几十行）。
- **OGG**：需编码器，候选：
  - `wasm-audio-encoder`（Vorbis/Opus，MIT，单个 WASM）——推荐。
  - `ogg-vorbis-encoder-js`。
  - 需把 `.wasm` 拷贝进 `dist/`（仿现有 `copy-spessasynth-worklet` 步骤）；
    CSP 已有 `wasm-unsafe-eval`，可实例化 WASM。

### 2.3 主进程落盘
- 新增 IPC（如 `audio:export`，含 `format: "wav" | "ogg"`）→
  保存对话框 + `writeFile`（仿 `midi:export` 流程，`src/main/index.ts`）。
- 渲染进程只产生 `ArrayBuffer`，写盘由主进程完成。

### 2.4 UI
- `src/shared/menu.ts` 文件组「导出」下新增「导出 WAV」「导出 OGG」两个子项
  → 动作 `file-export-wav` / `file-export-ogg`。
- `App.tsx` `runMenuAction` 映射到导出处理（触发离线路由 → 编码 → IPC 落盘）。
- 导出过程中显示忙碌状态（复用 `agentBusy` 或独立 `exportBusy`），完成后 toast。

## 3. 验证
- `npm run typecheck`、`npm test`、`npm run build`、smoke。
- 手测：
  - 小工程（含 SoundFont + SFZ + 振荡器轨道）导出 WAV 可播放；
  - 导出 OGG 可播放；
  - 空工程/无音源轨道回退振荡器也能导出；
  - 保存对话框取消不写文件。

## 4. 待定决策（后续确认后填入）
- [ ] OGG 编码器依赖：新增 WASM 编码器（推荐）还是先只做 WAV。
- [ ] 导出范围：完整工程（推荐）还是仅循环区。
- [ ] OGG 内编码：Vorbis（推荐，兼容性广）还是 Opus。
- [ ] 采样率：默认 44100 或 48000。
- [ ] 渲染时长上限（避免超大工程无限渲染）。

## 5. 相关文件（实施时的改动面）
- `src/renderer/audio/render-project.ts`（新增）
- `src/renderer/audio/audio-engine.ts`（复用音源加载逻辑，或抽共用）
- `src/renderer/App.tsx`（导出动作 + 忙碌 UI）
- `src/main/index.ts`（`audio:export` IPC + 保存对话框）
- `src/shared/bridge.ts` / `src/preload/index.cts`（桥方法）
- `src/shared/menu.ts`（导出子菜单项）
- `vite.config.*`（拷贝 WASM 编码器，仿 spessasynth worklet 拷贝）
- `doc/PROGRESS.md` / `doc/TODO.md`（完成后记录）
