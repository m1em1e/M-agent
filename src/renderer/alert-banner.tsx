import type { EnvironmentIssue } from "../shared/bridge";
import { Icon } from "./icon";

interface EnvironmentAlertBannerProps {
  issues: EnvironmentIssue[];
  busy: boolean;
  onConfigureShell: () => void;
  onConfigureProviders: () => void;
  onRefresh: () => void;
}

export function EnvironmentAlertBanner({ issues, busy, onConfigureShell, onConfigureProviders, onRefresh }: EnvironmentAlertBannerProps) {
  return (
    <section className="environment-alert" role="alert" aria-live="polite">
      <Icon name="warning" />
      <div>
        <strong>{issues.map((issue) => issue.message).join("；")}</strong>
        <span>{issues.map((issue) => issue.instruction).join(" ")}</span>
      </div>
      <div className="environment-alert-actions">
        {issues.some((issue) => issue.action === "open-shell-settings") && (
          <button onClick={onConfigureShell}>配置 Shell</button>
        )}
        {issues.some((issue) => issue.action === "open-provider-settings") && (
          <button onClick={onConfigureProviders}>配置供应商</button>
        )}
      </div>
      <button disabled={busy} onClick={onRefresh}>{busy ? "检测中…" : "重新检测"}</button>
    </section>
  );
}

interface InstrumentAlertBannerProps {
  onConfigure: () => void;
  onDismiss: () => void;
}

export function InstrumentAlertBanner({ onConfigure, onDismiss }: InstrumentAlertBannerProps) {
  return (
    <section className="instrument-alert" role="alert" aria-live="polite">
      <Icon name="warning" />
      <div>
        <strong>尚未配置音源</strong>
        <span>为获得真实音色试听，请在设置 → 音源 中「添加」工程音源，或把音源文件放入系统级音源库目录（打开文件夹）后扫描；未配置时轨道使用默认振荡器。</span>
      </div>
      <div className="instrument-alert-actions">
        <button onClick={onConfigure}>配置音源</button>
      </div>
      <button className="instrument-alert-close" onClick={onDismiss} aria-label="关闭音源提示"><Icon name="close" size={12} /></button>
    </section>
  );
}