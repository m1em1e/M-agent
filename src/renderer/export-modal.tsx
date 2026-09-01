import { EXPORT_SAMPLE_RATES, type ExportSampleRate } from "../shared/export-settings";

export type ExportAudioFormat = "wav" | "ogg";

interface ExportAudioModalProps {
  format: ExportAudioFormat;
  sampleRate: ExportSampleRate;
  loopOnly: boolean;
  busy: boolean;
  onSampleRateChange: (rate: ExportSampleRate) => void;
  onLoopOnlyChange: (value: boolean) => void;
  onCancel: () => void;
  onExport: (format: ExportAudioFormat, sampleRate: ExportSampleRate) => void;
}

export function ExportAudioModal({
  format,
  sampleRate,
  loopOnly,
  busy,
  onSampleRateChange,
  onLoopOnlyChange,
  onCancel,
  onExport,
}: ExportAudioModalProps) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onCancel(); }}>
      <section className="modal migrate-modal" role="dialog" aria-modal="true" aria-labelledby="export-audio-title">
        <span className="modal-kicker">AUDIO EXPORT</span>
        <h3 id="export-audio-title">导出{format === "ogg" ? " OGG" : " WAV"} 音频</h3>
        <p className="settings-intro">
          离线渲染完整工程为{format === "ogg" ? " Ogg Vorbis（.ogg）" : " WAV（.wav）"}。
          包含 SoundFont 采样、SFZ 采样与振荡器回退轨道，时长随最长轨道并附加释放尾音。
        </p>
        <label className="settings-row">
          <div><strong>采样率</strong><span>越高保真越好、文件越大。</span></div>
          <select value={sampleRate} onChange={(event) => onSampleRateChange(Number(event.target.value) as ExportSampleRate)}>
            {EXPORT_SAMPLE_RATES.map((rate) => <option key={rate} value={rate}>{rate} Hz</option>)}
          </select>
        </label>
        <label className="settings-row">
          <div>
            <strong>仅导出循环区</strong>
            <span>有循环区的轨道从头播放、进入循环区后循环至曲末；无循环区轨道整轨导出。</span>
          </div>
          <input type="checkbox" checked={loopOnly} onChange={(event) => onLoopOnlyChange(event.target.checked)} />
        </label>
        <div className="modal-actions">
          <button className="candidate-secondary" disabled={busy} onClick={onCancel}>取消</button>
          <button className="primary-button" disabled={busy} onClick={() => onExport(format, sampleRate)}>
            {busy ? "正在渲染并编码…" : "导出"}
          </button>
        </div>
      </section>
    </div>
  );
}