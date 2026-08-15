/**
 * 应用菜单的单一数据源。
 * macOS 原生 Menu Bar（src/main/index.ts installApplicationMenu）与
 * Windows/Linux 应用内菜单栏（src/renderer/App.tsx）都从 APP_MENU_GROUPS 生成，
 * 修改菜单只需改动这里，两端自动同步。
 */

export interface AppMenuItem {
  label: string;
  /** 渲染进程菜单动作（runMenuAction 处理）；macOS 原生菜单点击经 menu:action 转发同一动作。 */
  action?: string;
  /** Electron 原生角色，仅 macOS 原生菜单使用；应用内菜单会忽略。 */
  role?: "cut" | "copy" | "paste" | "selectAll" | "togglefullscreen";
  /** 应用内菜单显示的快捷键文本。 */
  shortcut?: string;
  /** Electron 加速键（如 CmdOrCtrl+O），用于 macOS 原生菜单。 */
  accelerator?: string;
  /** 分隔线（仅原生菜单渲染）。 */
  separator?: boolean;
  /** 次级菜单（递归）。应用内菜单与 macOS 原生菜单都渲染。 */
  submenu?: AppMenuItem[];
  /** 标记「最近打开项目」：子菜单内容由运行时填充（主进程存 electron-store，渲染进程经 IPC 读取）。 */
  recentProjects?: boolean;
  /** 动作附带的不透明负载（如最近项目路径），由动作处理方解析。 */
  payload?: string;
  disabled?: boolean;
}

export interface AppMenuGroup {
  key: string;
  label: string;
  accessKey?: string;
  items: AppMenuItem[];
}

export const APP_MENU_GROUPS: AppMenuGroup[] = [
  {
    key: "file",
    label: "文件",
    accessKey: "F",
    items: [
      { label: "新建项目", action: "file-new-project", shortcut: "Ctrl+N", accelerator: "CmdOrCtrl+N" },
      { label: "打开项目", action: "file-open-project", shortcut: "Ctrl+O", accelerator: "CmdOrCtrl+O" },
      { label: "最近打开项目", recentProjects: true, submenu: [] },
      { separator: true, label: "" },
      { label: "保存项目", action: "file-save-project", shortcut: "Ctrl+S", accelerator: "CmdOrCtrl+S" },
      { label: "项目另存为", action: "file-save-project-as", shortcut: "Ctrl+Shift+S", accelerator: "CmdOrCtrl+Shift+S" },
      { separator: true, label: "" },
      {
        label: "导入",
        submenu: [
          { label: ".magent 工程", action: "file-open-project" },
          { label: "MIDI 文件（.mid / .midi）", action: "file-open-midi" },
        ],
      },
      { label: "导出 MIDI", action: "file-export-midi" },
      { separator: true, label: "" },
      { label: "关闭项目", action: "window-close", shortcut: "Ctrl+W", accelerator: "CmdOrCtrl+W" },
    ],
  },
  {
    key: "edit",
    label: "编辑",
    accessKey: "E",
    items: [
      { label: "撤销", action: "edit-undo", shortcut: "Ctrl+Z", accelerator: "CmdOrCtrl+Z" },
      { label: "重做", action: "edit-redo", shortcut: "Ctrl+Y", accelerator: "CmdOrCtrl+Shift+Z" },
      { separator: true, label: "" },
      { label: "剪切", role: "cut" },
      { label: "拷贝", role: "copy" },
      { label: "粘贴", role: "paste" },
      { label: "全选", role: "selectAll" },
    ],
  },
  {
    key: "window",
    label: "窗口",
    accessKey: "W",
    items: [
      { label: "最小化", action: "window-minimize", accelerator: "CmdOrCtrl+M" },
      { label: "最大化 / 还原", action: "window-maximize" },
      { separator: true, label: "" },
      { label: "切换全屏", role: "togglefullscreen" },
    ],
  },
  {
    key: "instruments",
    label: "音源",
    accessKey: "S",
    items: [
      { label: "音源库管理", action: "instruments-settings" },
    ],
  },
  {
    key: "plugins",
    label: "插件",
    accessKey: "P",
    items: [
      { label: "插件管理", action: "plugins-settings" },
    ],
  },
  {
    key: "help",
    label: "帮助",
    accessKey: "H",
    items: [
      { label: "关于 M Agent", action: "help-about" },
      { label: "设置", action: "help-settings" },
    ],
  },
];
