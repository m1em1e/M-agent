# M/agent Skill 系统（嵌套调用）

> 状态：2026-08-15 已实现。
> 7 份 SKILL.md 位于仓库根 `skills/<name>/SKILL.md`（开发态与打包态目录名一致）；
> 打包时经 `electron-builder` `extraResources` 放入 `resources/skills`。

## 1. 两级音源之外的新能力

Skill 让用户通过 `@skill-name` 触发一个「编曲工作流」：顶层 Skill（如 `song-arranger`）
负责分析工程、挑选 specialist、用 `invoke_skill` 委托子任务、收拢结构化结果并合并为**一个统一候选**，
最后仍走现有 Diff Preview、权限与用户确认流程。在输入框输入 `@` 会弹出 Skill 选择列表
（↑/↓ 选择、Enter 确认、Esc 关闭，点击亦可），选中后自动插入 `@skill-name `。

```
@song-arranger
  → 项目分析
  → 选择 specialist（≤4 个子调用 / 父，深度 ≤2，全局 ≤8）
  → invoke_skill 子 Skill（继承父模式权限）
  → 结构化 SkillInvocationResult
  → 冲突检测 / 合并（merge 引擎，绝不 last-wins）
  → 统一 MIDI candidate → 现有 Diff Preview → 用户确认
```

## 2. 7 个内置 Skill

| Skill | 角色 | 可委托（SKILL.md 语义） |
| --- | --- | --- |
| `song-arranger` | 顶层编排 | harmony / melody / rhythm / bass / orchestration / humanize |
| `harmony-arranger` | 和声 | melody / bass / orchestration / song |
| `melody-arranger` | 旋律 | harmony / rhythm / orchestration / song / humanize |
| `rhythm-arranger` | 节奏 | bass / melody / song / humanize / orchestration |
| `bass-arranger` | 低音 | harmony / rhythm / melody / orchestration / song |
| `orchestration-arranger` | 配器/织体 | harmony / melody / bass / rhythm / song |
| `humanize-performance` | 人性化 | rhythm / melody / orchestration / song |

## 3. 运行时工具（仅 Skill 作用域注册）

| 工具 | 参数 | 返回 |
| --- | --- | --- |
| `list_skills` | 无 | `[{ name, description, available }]`（当前状态下的可用性） |
| `load_skill` | `{ skillName }` | 该 Skill 的完整 SKILL.md（progressive disclosure） |
| `invoke_skill` | `{ skillName, task, context?, constraints? }` | `SkillInvocationResult` |

`SkillInvocationResult`（与 SKILL.md 子结果契约一致）：

```ts
interface SkillInvocationResult {
  skill: string;
  summary: string;
  operations: MidiEditOperation[];
  affectedTracks: string[];
  affectedNotes: string[];
  assumptions: string[];
  warnings: string[];
  depth: number;
  status: "ok" | "skipped" | "error";
  error?: string;
}
```

## 4. 防递归与预算

- 默认：最大嵌套深度 **2**、每父 Skill 最多 **4** 个子调用、每顶层运行全局最多 **8** 次子调用。
- 禁止 self-invocation；禁止 `A → B → A` 环（`visited` 调用链检测，跨内核传递）。
- 子调用可取消（继承父 AbortSignal）且有独立超时（默认 45s）；`agent:run` 在 Skill 目标下放宽到 300s。
- 子 Skill 失败不会拖垮整个 Agent：以 `status: "error"` 返回，父 Skill 决定 fallback。

## 5. 权限继承

子 Skill 以父模式递归运行（同一 `runPiKernel`），`propose_midi_changes` 仍是唯一候选通道且无 apply 工具：

- `research`：子 Skill 只读（无 propose）。
- `plan`：子 Skill 可产生候选，但不能应用。
- `goal`：子 Skill 可产生受预算约束的候选，最终仍由用户确认。

## 6. 合并与冲突检测（`mergeSkillOperations`）

确定性引擎，先到先得（父调用顺序即意图），绝不「最后一个 Skill 获胜」：

- 同 noteId 的 update/delete 冲突 → 保留先到者 + warning。
- delete 后 update → 忽略后续冲突操作。
- 同位置重复 insert（同 trackId + pitch + startTick）→ 保留先到者。
- track 删除与该轨道音符/轨道操作冲突 → 移除冲突操作 + warning。
- 重复 set_tempo / set_time_signature、重叠 set_loop、clear_loop 与 set_loop 冲突 → 保留先到者。
- 超出操作数上限（500）截断 + warning；受影响音符超限（10,000）warning。
- 合并候选重新过 `validateChangeSet` 领域校验；失败则保留父 Skill 自身候选并记录 warning。

## 7. 上下文传递

子 Skill 注入紧凑 `SkillContext`（goal/projectId/section/relevantTrackIds/relevantNoteIds/
tickRange/meter/tempo/currentFindings/constraints），不 dump 完整工程；细节由子模型调
`inspect_midi_project` / `analyze_midi_project` 按需读取。

## 8. 可观测性

`AgentResponsePayload.skillTrace` 返回每次子调用记录；界面消息内可折叠展示；`console.debug` 输出：

```
[skills] song-arranger -> harmony-arranger depth=1 ok 40ms ops=1 notes=4
```

## 9. 用户自定义 Skill

在 Skill 目录（开发态仓库根 `skills/`，打包态 `<resources>/skills`）下新建
`<name>/SKILL.md` 即可，格式：

```markdown
---
name: my-skill
description: 一句话说明（list_skills 用）
---
# My Skill
（正文，含委托规则与工作流）
```

应用每次运行 Agent 时现读目录，新增/修改即时生效。无效文件（缺 name 或空正文）会跳过并告警。
自定义 Skill 可与内置 Skill 互委托（受同一深度/环/上限约束）。
