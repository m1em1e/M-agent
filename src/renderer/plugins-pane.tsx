import { Icon } from "./icon";

export function PluginsPane() {
  return (
    <div className="settings-pane">
      <section className="settings-group">
        <div className="settings-group-heading"><div><strong>插件管理</strong><span>用于扩展 Agent 工具、MIDI 处理和音源能力。</span></div><span className="availability-badge preview">规划中</span></div>
      </section>
      <div className="settings-empty"><Icon name="plugin" size={24} /><strong>插件系统尚未接入</strong><p>当前版本不会扫描或执行第三方插件。插件清单、Manifest、权限和启停功能尚待实现。</p></div>
    </div>
  );
}