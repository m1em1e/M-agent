import type { PointerEvent as ReactPointerEvent } from "react";

/**
 * 「MIDI 属性」浮动面板：音符级 MIDI 属性编辑器。
 * 非模态、可拖动（标题栏 onDragStart 由 App 实现指针捕获与位置持久化）。
 * 编辑模型 = 直接写选中音符的可选字段（力度 + 声像/释放/截止/共振/微调/延音拍数）。
 */

/** 面板所需的最小音符形状（与 App 本地 MidiNote 结构兼容）。 */
export interface MidiPanelNote {
  id: string;
  pitch: number;
  velocity: number;
  pan?: number;
  release?: number;
  cutoffHz?: number;
  resonanceQ?: number;
  finePitchCents?: number;
  sustainBeats?: number;
}

export type NoteAttributeKey = "velocity" | "pan" | "release" | "cutoffHz" | "resonanceQ" | "finePitchCents" | "sustainBeats";

interface AttributeRow {
  key: NoteAttributeKey;
  label: string;
  detail: string;
  min: number;
  max: number;
  step: number;
  unit: string;
  defaultValue: number;
  /** 截止频率用对数滑杆（0=关，1..100 → 200..20000Hz）。 */
  logCutoff?: boolean;
}

const ROWS: AttributeRow[] = [
  { key: "velocity", label: "VEL", detail: "力度（1–127）", min: 1, max: 127, step: 1, unit: "", defaultValue: 90 },
  { key: "pan", label: "PAN", detail: "声像（-100..100）", min: -100, max: 100, step: 1, unit: "", defaultValue: 0 },
  { key: "release", label: "REL", detail: "释放尾音（秒）", min: 0, max: 2, step: 0.01, unit: "s", defaultValue: 0 },
  { key: "cutoffHz", label: "CUT", detail: "滤波截止（0=关）", min: 0, max: 100, step: 1, unit: "Hz", defaultValue: 0, logCutoff: true },
  { key: "resonanceQ", label: "RES", detail: "滤波共振（Q）", min: 0, max: 16.5, step: 0.1, unit: "Q", defaultValue: 0 },
  { key: "finePitchCents", label: "PB", detail: "微调（音分，±100）", min: -100, max: 100, step: 1, unit: "ct", defaultValue: 0 },
  { key: "sustainBeats", label: "HOLD", detail: "延音踏板时长（拍，0=踩 0 拍）", min: 0, max: 8, step: 0.5, unit: "拍", defaultValue: 0 },
];

/** 对数截止滑杆值 → Hz（0=关；1..100 → 200..20000Hz）。 */
function cutoffHzFromSlider(v: number): number {
  if (v <= 0) return 0;
  return Math.round(200 * Math.pow(100, v / 100));
}
function sliderFromCutoffHz(hz: number): number {
  if (hz <= 0) return 0;
  return Math.max(1, Math.min(100, Math.round((Math.log(hz / 200) / Math.log(100)) * 100)));
}

interface MidiPropertiesPanelProps {
  /** 选中音符；undefined 时显示占位。 */
  note: MidiPanelNote | undefined;
  position: { x: number; y: number };
  /** 标题栏按下（App 开始拖动面板）。 */
  onDragStart: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onClose: () => void;
  /** 写入选中音符的某个属性（持续调用）。 */
  onChangeAttr: (key: NoteAttributeKey, value: number) => void;
  /** 一次编辑开始（指针按下，App 捕获基线快照）。 */
  onEditStart: () => void;
  /** 一次编辑结束（指针抬起，App 提交一次可撤销历史）。 */
  onEditCommit: () => void;
}

export function MidiPropertiesPanel(props: MidiPropertiesPanelProps) {
  const { note, position, onDragStart, onClose, onChangeAttr, onEditStart, onEditCommit } = props;
  return (
    <section
      className="midi-panel"
      role="dialog"
      aria-label="MIDI 属性"
      style={{ left: position.x, top: position.y }}
    >
      <header className="midi-panel-header" onPointerDown={onDragStart}>
        <strong>M/A · MIDI 属性</strong>
        <span className="midi-panel-track">{note ? `${noteName(note.pitch)} · VEL ${note.velocity}` : "未选择音符"}</span>
        <button type="button" className="midi-panel-close" onClick={onClose} aria-label="关闭">×</button>
      </header>
      <div className="midi-panel-body">
        {!note ? (
          <div className="midi-panel-empty">请先在钢琴卷帘选择一个音符。</div>
        ) : ROWS.map((row) => {
          const raw = note[row.key] ?? row.defaultValue;
          const sliderValue = row.logCutoff ? sliderFromCutoffHz(raw) : raw;
          const display = row.logCutoff ? (raw === 0 ? "关" : `${raw} Hz`) : `${raw}${row.unit ? ` ${row.unit}` : ""}`;
          const setValue = (next: number) => {
            onChangeAttr(row.key, row.logCutoff ? cutoffHzFromSlider(next) : next);
          };
          return (
            <label key={row.key} className="midi-row">
              <span className="midi-row-label" title={row.detail}>{row.label}</span>
              <span className="midi-row-detail">{row.detail}</span>
              <input
                type="range"
                min={row.min}
                max={row.max}
                step={row.step}
                value={sliderValue}
                onPointerDown={onEditStart}
                onPointerUp={onEditCommit}
                onChange={(event) => setValue(Number(event.currentTarget.value))}
              />
              <span className="midi-row-value" title={display}>{display}</span>
              <button
                type="button"
                className="midi-row-reset"
                title="重置为默认值"
                onClick={() => { onEditStart(); setValue(row.defaultValue); onEditCommit(); }}
              >↺</button>
            </label>
          );
        })}
      </div>
      <footer className="midi-panel-note">
        音符级属性：SFZ 轨全部生效（含微调/延音）；SoundFont 轨 力度/声像/截止/共振/延音 可听，释放与微调受合成器库限制仅导出。播放时音符属性优先于音源与轨级设置；延音=音符释放延后 N 拍。
      </footer>
    </section>
  );
}

function noteName(pitch: number): string {
  const names = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];
  return `${names[pitch % 12]}${Math.floor(pitch / 12) - 1}`;
}