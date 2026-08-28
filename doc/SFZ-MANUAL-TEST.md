# SFZ 功能手动测试方案

> 适用版本：M Agent 0.6.0（Windows 开发态）。面向真实音源试听与端到端链路的**手动**验证；
> 解析器/选择器逻辑已有单测覆盖（`tests/audio/sfz-parser.test.ts`、`tests/main/soundfont-parser.test.ts` 等），
> 本方案不重复其断言，只补「听感与整链路」。
> 功能声明依据：`doc/IMPLEMENTED.md` 第 6 / 10 / 11 节、「SFZ v1/v2 覆盖情况」见 `doc/INCOMPLETE.md`。

## 1. 目的与范围

验证 SFZ 已实现功能在真实试听、播放、控制器交互、导出等层面符合预期，
并明确「已知不支持项」在本应用中表现为**不崩溃、不误发声**。

覆盖：

- 系统级音源库：目录扫描、mtime 缓存与 include 链失效、启用/禁用、目录迁移；
- 项目级绑定：拖拽绑定 .sfz、`.magent` 快照持久化；
- SFZ 解析：`<global>/<group>/<region>/<control>` 继承、注释、引号路径、
  `<include>`/`#include` 递归加载（含循环截断）、`default_path`；
- 发声引擎（`src/renderer/audio/sfz-engine.ts`）：键区/力度分层、延音 noteOn/noteOff、
  ADSR、滤波器与滤波包络、LFO/pitch 包络、keyswitch、seq/random/trigger、
  键/力度/CC 交叉淡化、CC 调制（含 CC64 踏板延音）、v2 `oscillator`/`playback_rate`；
- 轨级 `controllerEvents`/`pitchBends`：MIDI `0xb0`/`0xE0` 往返、导入导出兼容（无 UI 入口）；
- 音符级 MIDI 属性：「MIDI 属性」浮动面板（菜单栏 MIDI → MIDI 属性…）编辑选中音符的 力度/声像/释放/截止/共振/微调/延音拍数；
- 导出：SFZ 轨道离线渲染、SFZ+SoundFont+振荡器混排、mute/solo、循环区导出。

不在范围（仅验证不崩溃、行为与文档一致）：`set_cc`、`trigger=first` 完整语义、
`group`/`off_by` 复音抢夺、VST3、采样级时钟精度、跨平台。

## 2. 测试环境与前置准备

1. **环境**：`npm install` 后 `npm run dev`（桌面包启动，需可输出的音频设备）。
2. **基线**：测试前先执行 `npm test` 与 `npm run typecheck` 确认全绿，
   避免把环境问题误判为功能缺陷。
3. **测试音源**：按附录 A 在系统音源库目录
   （默认 `%USERPROFILE%\Documents\m-agent\Instruments\tests\`）创建最小 SFZ
   （一个 `<region>` + 一个 0.5s 短 WAV 采样），各用例直接在文件上增删 opcode 后
   「扫描音源库」复用。建议另备一份真实 SFZ（如 Salamander 钢琴）做综合听感对比，非必需。
4. **界面入口**：
   - 设置 → 音源：列表 / 新建音源库两视图；「扫描音源库」；「打开文件夹」；
     系统级条目启用/禁用开关；右上角「添加」拖拽绑定工程音源；
   - 轨道检查器音色选择器：系统级 + 工程级条目合并；
   - 钢琴卷帘：点击/拖动音符试听、多音符工程「播放 / 暂停 / 停止」；
   - 钢琴卷帘顶部 PEDAL lane（CC64 踏板编辑）；
   - 文件菜单：导入 MIDI / 导出 WAV / 导出 OGG。
5. **记录方式**：逐用例记录 实际操作、实际结果、是否符合预期（通过/失败）；
   失败附复现 SFZ 文本与操作步骤。临时测试文件结束后删除。

## 3. 测试用例矩阵

用例 ID 前缀：`LIB`=音源库与扫描，`PAR`=解析与登记，`V`=发声引擎试听，
`CC`=控制器/踏板，`EX`=导出，`RD`=回归与边界，`UN`=已知不支持项。

### 3.1 LIB 音源库与扫描

| ID | 步骤 | 预期 |
|---|---|---|
| LIB-1 | 把 `tests/*.sfz` 放入系统目录 → 设置→音源→「扫描音源库」 | 列表出现 SFZ 条目，类型徽标为 SFZ，区域计数正确 |
| LIB-2 | 目录混放 `.sf2 / .sf3 / .sfz` 后扫描 | 三类均登记，类型区分正确（SoundFont / SFZ） |
| LIB-3 | 修改 SFZ 文本（如 `volume` 改值）→ 再次扫描 | 条目刷新（mtime 缓存失效后重解析） |
| LIB-4 | 修改被 `<include>` 的子 SFZ → 再次扫描 | include 链 mtime 变化触发重解析，发声跟随变化 |
| LIB-5 | 构造 include 循环（主→子→主）→ 扫描 | 不卡死、不崩溃；区域有限（visited 防环） |
| LIB-6 | 禁用系统级 SFZ 条目 → 用该音源绑定的轨道试听/播放 | 不发声，轨道回退振荡器；重新启用后恢复 |
| LIB-7 | 「打开文件夹」且目录不存在 | 自动创建目录，无报错 |
| LIB-8 | 修改系统音源目录（不迁移 / 迁移两种都测） | 迁移后文件移至新目录、扫描正常；不迁移则新目录为空 |
| LIB-9 | 空目录扫描；把目录指向不可读路径 | 空列表或跳过，不报错不崩溃 |

### 3.2 PAR 解析与登记

| ID | 步骤 | 预期 |
|---|---|---|
| PAR-1 | 工程级绑定：把 `.sfz` 拖入音源页「添加」区 | 绑定成功，出现「工程」标记条目与区域数；轨道音色选择器可选到 |
| PAR-2 | 绑定后保存 `.magent` → 关闭重开工程 | 绑定保留（`sfzRegions` 快照随工程持久化），发声正常 |
| PAR-3 | `<control> default_path=samples/` + 相对采样 | 采样路径正确解析到子目录，试听发声正常 |
| PAR-4 | 引号路径、含空格/中文路径、`sample=C:\abs\a.wav` 绝对路径 | 解析与发声均正常 |
| PAR-5 | 空文件 / 无 `sample` 无 `oscillator` 的 region / 采样文件不存在 | 扫描不崩溃；条目区域数如实；试听静默不报错 |
| PAR-6 | `tune`/`pitch` 别名、`hint_*` 元数据 | 解析不报错、不影响发声 |
| PAR-7 | 列表区域数与实际 `<region>` 计数一致（含 `<group>` 多 region） | 数量一致，便于快速回归 |

### 3.3 V 发声引擎试听（核心）

统一操作：钢琴卷帘点击/拖动音符试听；长音符/多音符用工程「播放」验证持续发声与 noteOff。

| ID | 场景（SFZ opcode） | 预期 |
|---|---|---|
| V-1 | 基础：单 `<region>` + 采样，`key=60` | 点击 C4 发声，音高对应 key center；力度影响音量 |
| V-2 | 键区/力度分层：`lokey/hikey`、`lovel/hivel` 分区 | 不同键区/力度触发对应采样；重叠区多 region 同时发声混叠 |
| V-3 | 延音与释放：长音符 | 按住延音到结束 tick 才释放（attack→decay→sustain 保持，noteOff 进 release）；播放中暂停/停止立即切断，无拖尾 |
| V-4 | 采样懒解码 | 首次发声可能有短暂延迟，第二次立即；无卡死、无重复解码报错 |
| V-5 | 音高族：`tuning=10` / `tune=10` / `pitch=10`（等效）、`pitch_keytrack=0`（不同键音高不变）、`pitch_offset=12`（上移八度）、`playback_rate=0.5`（音高降、时值倍长） | 各参数听感符合预期 |
| V-6 | 包络：`amp_env_attack/decay/sustain/release/hold` 与 `ampeg_*` 前缀 | 两种前缀等价；音头、衰减、持续电平、释放、保持期内听感符合参数 |
| V-7 | 增益/力度：`volume`、`amp_veltrack`（0=力度不影响 / 100=全跟随）、`amp_velcurve_30=0.2 amp_velcurve_100=0.9` | 不同力度音量按曲线插值（曲线优先于线性 veltrack） |
| V-8 | 滤波器：同一采样两份 SFZ `fil_type=lowpass cutoff=300` vs `cutoff=8000` 对比；`resonance=20` | 低频版发闷（高频被滤）、高频版明亮；共振峰增强可辨 |
| V-9 | 滤波包络/veltrack：`fil_env_depth=400 attack=0.1 decay=0.2`、`fil_env_sustain`、`cutoff_veltrack` | 音头截止扫频（亮→回落）；sustain 控制回落后电平；力度越大滤波越开 |
| V-10 | 分组：`seq_length=2 seq_position=1/2`（两个不同音高采样）、`random=0/100`、`trigger=release`、`release_time=0.05` | 连续点击同键交替发声；random=100 多次触发有变体、=0 稳定；noteOff 时 release 层短促发声（release_time 延迟）；legato 见 V-11 |
| V-11 | `trigger=legato`（同 channel 前一音仍按）与 `trigger=first` | legato 层仅连奏时发声（独立试听时不死按住则不响）；first 按普通 attack 处理（首音发声） |
| V-12 | keyswitch：`sw_lokey=72 sw_hikey=72` 与 `sw_lokey=60 sw_hikey=60` 两组；`sw_default=1`；`sw_last=0`；`sw_previous=1` | 先按 72/60 再按普通键切到对应层；无激活键走默认层；松开 keyswitch 键（sw_last=0）回默认；sw_previous 回退上一激活键 |
| V-13 | LFO：`pitch_lfo_freq=6 depth=15`（颤音）、`pan_lfo_freq=2 depth=50`（声像摆动）、`amp_lfo_freq=5 depth=20`（音量抖动）、`*_lfo_delay`（延迟起振）、`pitch_lfo_shape=triangle` vs sine、`pitch_lfo_phase=180` | 各调制可听且互不串扰；波形/相位差异可区分 |
| V-14 | pitch 包络：`pitch_env_depth=100`（上行滑音）、attack/decay/sustain | 音头音高变化后回落/保持符合参数 |
| V-15 | 交叉淡化：`lokey=40 hikey=60 xfin_lokey=36 xfout_hikey=64`；力度同理 `xfin_lovel/xfout_hivel` | 边界附近音量渐变（36→40 渐入、60→64 渐出），非阶跃突变 |
| V-16 | 轨级 `controllerEvents`（如 CC1）修饰轨道并播放 | CC 调制生效，听感随 CC 事件变化（配合 CC-5~7 场景） |
| V-17 | 缺失采样路径 | 静默、不崩溃、无错误弹窗，其余 region 正常发声 |
| V-18 | v2 合成：`<region> oscillator=saw key=60`（无采样）、`oscillator=square/triangle/sine`、`playback_rate` 作用于振荡器 | 对应波形发声，走 ADSR/滤波/LFO/CC 链；无采样文件也发声 |

### 3.4 CC 控制器与踏板

| ID | 步骤 | 预期 |
|---|---|---|
| CC-1 | 导入含 CC64（`0xb0`）的 MIDI 曲目 → 播放 | 踩下（127）期间音符到结束 tick 不立即释放，松开（0）统一释放（SFZ 与 SoundFont 均应如此） |
| CC-2 | 试听无 CC 事件的工程 | 踏板默认值 64，无异常延音 |
| CC-3 | 钢琴卷帘 PEDAL lane：点击空白添 127（踩）、点击已踩区间内添 0（松） | 事件添加/删除正确；踩区间块随音符区正确绘制 |
| CC-4 | 保存 `.magent` 重开；导出 MIDI 再导入 | `controllerEvents` 保留；`0xb0` 往返还原 |
| CC-5 | `on_cc64=127` 区域；`on_cc` 区域 | 仅 CC64=127 时可选；CC 值变化到目标值时短促发声一次 |
| CC-6 | `xfin_ccN=0 xfout_ccN=100` CC 淡化 | CC 从 0→100 变化时音量线性渐入（可用 CC-3 的踏板事件驱动） |
| CC-7 | `cc1_pitch=200`、`cc2_cutoff=500`、`cc3_pan=-50`、`cc64_amp=80` | 对应 CC 变化产生音高/滤波/声像/音量调制；CC=64 中值无偏移 |
| CC-8 | 「MIDI 属性」面板（菜单 MIDI → MIDI 属性…）选中音符 → PAN 滑杆 -100..100 → 播放/试听 | SFZ 轨声像随音符 pan 变化（覆盖 region）；SoundFont 轨每通道链生效（重叠音符后音覆盖） |
| CC-9 | CUTOFF 滑杆（对数 0=关 → 200Hz..20kHz） | SFZ 轨立即起 lowpass 听感（无需 .sfz 有滤波器）；SoundFont 轨每通道链生效 |
| CC-10 | RESONANCE 滑杆（0.5..16.5） | SFZ / SoundFont 轨共振随值增强（配合 CUTOFF） |
| CC-11 | REL 滑杆（0..2s） | SFZ 轨 noteOff 尾音随值变长；SoundFont 轨仅导出（库无 CC72） |
| CC-12 | PB 滑杆（-100..100 音分） | SFZ 轨音高随微调偏移（+100 音分 ≈ +1 半音的 50%）；SoundFont 轨仅导出（库无弯音 API） |
| CC-13 | HOLD 滑杆（0..8 拍）→ 播放 | 音符释放延后 N 拍（默认 0=踩 0 拍）；导出 MIDI 写 CC64 127/0 对，再导入还原为轨级 CC64 事件 |
| CC-14 | 保存 `.magent` 重开；导出 MIDI 再导入 | 音符属性随 `.magent` 保留；导出为 CC10/71/74/72、0xE0、CC64 近似事件（导入后为轨级近似，per-note 不可逆向） |

### 3.5 EX 导出

| ID | 步骤 | 预期 |
|---|---|---|
| EX-1 | 仅 SFZ 轨道工程 → 文件菜单导出 WAV；再导出 OGG | 文件可被系统播放器打开；音色、音高、音符时值正确（对比试听） |
| EX-2 | SoundFont + SFZ + 振荡器混排工程导出 | 各轨音量比例与时序一致，无缺失、无爆音 |
| EX-3 | 对轨道设置 mute / solo 后导出 | 导出遵守 mute/solo |
| EX-4 | 设置工程级循环区并勾选「仅导出循环区」 | 只导出区间内容，时长 = 区间长度 + 释放尾音 |
| EX-5 | 空工程导出 | 约 1s 静音文件，不报错 |
| EX-6 | 导出期间重复点击导出 / 长工程中途取消 | busy 态与进行提示正常，无重复写入、无崩溃（关联合法上限校验） |

### 3.6 RD 回归与边界

| ID | 步骤 | 预期 |
|---|---|---|
| RD-1 | 播放后「停止」再一次播放 | 无幽灵音、无残留发声（stopAll 干净重来） |
| RD-2 | 撤销/重做含 SFZ 音色轨道的编辑后播放 | 正常发声，撤销快照不破坏音源引用 |
| RD-3 | 切换轨道音色：SFZ ↔ SoundFont ↔ 振荡器 | 切换后播放即时更新 |
| RD-4 | 播放中删除该 SFZ 的工程绑定 / 禁用系统条目 | 不崩溃，轨道回退振荡器 |
| RD-5 | 长音符（接近 8000ms 试听上限） | 按时长上限行为，不溢出、不崩溃 |
| RD-6 | 同键重叠音符快速连击 | 多发声正常叠加，noteOff 释放最近一次，无异常 |

### 3.7 UN 已知不支持项

| ID | 步骤 | 预期 |
|---|---|---|
| UN-1 | SFZ 含 `set_cc`、`group`/`off_by`、`trigger=first` opcode 的扫描与试听 | 解析不报错、不崩溃；`set_cc` 不生效、`first` 按 attack 处理、`group` 忽略；**不得**误发声或产生异常状态 |
| UN-2 | `<global>` 使用 `sequence_length`（非 `seq_length`）等未列入覆盖表的 opcode | 忽略未知 opcode，不报错、不影响已支持功能 |

## 4. 通过准则与缺陷处理

- **通过准则**：除 UN 项外的全部用例达到预期；无崩溃、无幽灵音、无卡死；
  已知限制与 `doc/INCOMPLETE.md` 描述一致；导出文件可正常使用。
- **缺陷分级**：
  - P0：崩溃、静音全挂、数据损坏、导出产物不可用；
  - P1：功能与文档不符（如某已声明 opcode 无效果、键区/力度错位、CC 调制错乱）；
  - P2：体验问题（首次加载延迟过大、提示缺失、列表刷新滞后）。
- 发现 P0/P1 时附复现 SFZ 文本与操作步骤后转修复；修复后回归对应用例。
- 本方案执行完成后，更新 `doc/INCOMPLETE.md`「SFZ 已实现功能手动测试清单（A–F…均尚未手动验证）」
  的勾选状态与结论。

## 5. 收尾

- 删除临时测试目录 `%USERPROFILE%\Documents\m-agent\Instruments\tests\` 及其中的 SFZ/WAV；
- 汇总结论：各用例通过数 / 失败数 / 缺陷单；明确下一步（修复项、未覆盖项）。

## 附录 A：最小测试 SFZ 模板

目录结构（系统音源库 `.../Instruments/` 下）：

```
Instruments/tests/
├── test.sfz            # 主文件，用例在此增删 opcode
└── samples/
    └── test.wav        # 0.5s 短音（如 440Hz 正弦），各用例共用
```

`test.sfz` 内容：

```sfz
// test.sfz —— 最小测试音源
<control>
default_path=samples/

<global>
volume=0

<region>
sample=test.wav
key=60
```

> 注：`<include>` 与 `#include "sub/a.sfz"` 的测试把子文件放在 `tests/sub/` 下即可；
> include 循环用例让子文件 `#include` 回主文件路径（如 `#include "../test.sfz"`）。

WAV 生成（任选其一）：ffmpeg `ffmpeg -f lavfi -i "sine=frequency=440:duration=0.5" samples/test.wav`；
或用任意音频工具/现成短采样。测试后即删。

## 附录 B：关联代码文件

| 层 | 文件 |
|---|---|
| 解析 | `src/core/audio/sfz-parser.ts`（`parseSfzText`、`selectSfzRegions`、`pickSfzRegions[WithGain]`、`nextKeyswitchState`） |
| 主进程解析/缓存 | `src/main/soundfont-parser.ts`（`parseSfz`：default_path、include 递归、visited 防环）、`src/main/audio/library-store.ts`（扫描/mtime/include 链失效）、`src/main/audio/system-scan.ts` |
| 播放引擎 | `src/renderer/audio/sfz-engine.ts`（SfzEngine）、`src/renderer/audio/audio-engine.ts`（路由/noteOff/stopAll/setCC） |
| 轨道音色路由 | `src/renderer/App.tsx`（`resolveTrackInstrument`、`playTrackNote`、播放 rAF 调度、PEDAL lane、音源设置 UI） |
| 导出 | `src/renderer/audio/render-project.ts`（SFZ/振荡器离线渲染、SFZ 分组） |
| 数据与类型 | `src/shared/instrument.ts`（SfzRegion / InstrumentType / 引用格式）、`src/core/midi/project.ts`、`src/main/project-adapter.ts` |
| 已有自动测试 | `tests/audio/sfz-parser.test.ts`、`tests/audio/registry.test.ts`、`tests/audio/instrument.test.ts`、`tests/main/soundfont-parser.test.ts`、`tests/main/system-scan.test.ts`、`tests/main/project-adapter.test.ts` |

## 附录 C：与 INCOMPLETE.md「A–F 手动测试清单」映射

| 既有清单条目 | 对应用例 |
|---|---|
| A 补全与别名（tune/pitch、delay、pitch_keytrack、pitch_offset） | V-5、V-6 中的 delay/hold |
| B 滤波器（fil_type/cutoff/resonance） | V-8 |
| C 分组行为（seq/random/trigger=release） | V-10、V-11 |
| D keyswitch（sw_lokey/hikey/default 及 sw_last/sw_previous） | V-12 |
| E include（含循环截断） | LIB-4、LIB-5、PAR-3 |
| F 调制（LFO/pitch 包络） | V-13、V-14 |
| 交叉淡化（键/力度） | V-15 |
| 滤波包络 fil_env | V-9 |
| 力度曲线 amp_velcurve | V-7 |
| trigger 补全（legato/release_time） | V-10、V-11 |
| 调制补全（veltrack/LFO delay） | V-7、V-9、V-13 |
| keyswitch 补全（sw_last/sw_previous） | V-12 |
| LFO 波形/相位 | V-13 |
| include 变更监听 | LIB-3、LIB-4 |
| 延音 noteOn/noteOff、暂停/停止切断 | V-3、V-4 |
| CC64 踏板（数据/SMF/播放/lane 编辑） | CC-1~CC-4 |
| CC 淡化 / on_ccN / on_cc / ccN_* 调制 | CC-5~CC-7 |
| v2 合成与 #include/hint_* | V-18、PAR-6 |
| SFZ 导出端到端 | EX-1~EX-6 |