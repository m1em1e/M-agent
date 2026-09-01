import type { ProjectOpenIntent } from "../shared/bridge";

interface MigratePathDialogProps {
  from: string;
  to: string;
  onCancel: () => void;
  onChangeOnly: () => void;
  onMigrate: () => void;
}

export function MigratePathDialog({ from, to, onCancel, onChangeOnly, onMigrate }: MigratePathDialogProps) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="modal migrate-modal" role="alertdialog" aria-modal="true" aria-labelledby="migrate-title">
        <span className="modal-kicker">SYSTEM INSTRUMENT PATH</span>
        <h3 id="migrate-title">更改系统音源目录</h3>
        <p className="settings-intro">要把现有音源从当前目录同步迁移到新目录吗？</p>
        <div className="shell-path-field">
          <span>当前</span>
          <code className="migrate-path">{from}</code>
        </div>
        <div className="shell-path-field">
          <span>新目录</span>
          <code className="migrate-path">{to}</code>
        </div>
        <p className="shell-settings-note">「迁移音源」会把文件移动到新目录并更新扫描缓存；「仅更改路径」只切换扫描目录，不移动文件。</p>
        <div className="modal-actions">
          <button className="candidate-secondary" onClick={onCancel}>取消</button>
          <button className="candidate-secondary" onClick={onChangeOnly}>仅更改路径</button>
          <button className="primary-button" onClick={onMigrate}>迁移音源</button>
        </div>
      </section>
    </div>
  );
}

interface WindowChoiceDialogProps {
  intent: ProjectOpenIntent;
  onCancel: () => void;
  onChoose: (intent: ProjectOpenIntent, target: "current" | "new") => void;
}

export function WindowChoiceDialog({ intent, onCancel, onChoose }: WindowChoiceDialogProps) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="modal migrate-modal" role="alertdialog" aria-modal="true" aria-labelledby="window-choice-title">
        <span className="modal-kicker">PROJECT TARGET</span>
        <h3 id="window-choice-title">在哪里打开？</h3>
        <p className="settings-intro">
          {intent === "new-project" ? "新建项目" : intent === "open-project" ? "打开项目" : "导入 MIDI"}
          ：在当前窗口进行，还是另开一个新窗口？
        </p>
        <div className="modal-actions">
          <button className="candidate-secondary" onClick={onCancel}>取消</button>
          <button className="candidate-secondary" onClick={() => onChoose(intent, "current")}>当前窗口</button>
          <button className="primary-button" onClick={() => onChoose(intent, "new")}>新窗口</button>
        </div>
      </section>
    </div>
  );
}

interface MissingProjectDialogProps {
  path: string;
  onCancel: () => void;
  onNewProject: () => void;
  onOpenProject: () => void;
  onCloseWindow: () => void;
}

export function MissingProjectDialog({ path, onCancel, onNewProject, onOpenProject, onCloseWindow }: MissingProjectDialogProps) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="modal migrate-modal" role="alertdialog" aria-modal="true" aria-labelledby="missing-project-title">
        <span className="modal-kicker">PROJECT NOT FOUND</span>
        <h3 id="missing-project-title">最近项目文件不存在或无法访问</h3>
        <p className="settings-intro">
          工程可能已被移动或删除（已从最近项目列表移除）。请选择接下来如何处理。
        </p>
        <p className="settings-intro mono-path">{path}</p>
        <div className="modal-actions">
          <button className="candidate-secondary" onClick={onCancel}>取消</button>
          <button className="candidate-secondary" onClick={onNewProject}>新建项目</button>
          <button className="candidate-secondary" onClick={onOpenProject}>打开项目</button>
          <button className="primary-button" onClick={onCloseWindow}>关闭</button>
        </div>
      </section>
    </div>
  );
}

interface UnsavedChangesDialogProps {
  onCancel: () => void;
  onDiscard: () => void;
  onSaveAndContinue: () => void;
}

export function UnsavedChangesDialog({ onCancel, onDiscard, onSaveAndContinue }: UnsavedChangesDialogProps) {
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onCancel(); }}>
      <section className="modal migrate-modal" role="alertdialog" aria-modal="true" aria-labelledby="unsaved-title">
        <span className="modal-kicker">UNSAVED CHANGES</span>
        <h3 id="unsaved-title">未保存的更改</h3>
        <p className="settings-intro">当前工程有未保存的改动，是否保存后再继续？</p>
        <div className="modal-actions">
          <button className="candidate-secondary" onClick={onCancel}>取消</button>
          <button className="candidate-secondary" onClick={onDiscard}>不保存</button>
          <button className="primary-button" onClick={onSaveAndContinue}>保存并继续</button>
        </div>
      </section>
    </div>
  );
}