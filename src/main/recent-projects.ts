import Store from "electron-store";
import type { RecentProject } from "../shared/bridge.js";

interface RecentProjectsSchema {
  projects: RecentProject[];
}

const MAX_RECENT = 10;

let store: Store<RecentProjectsSchema> | undefined;

function recentStore(): Store<RecentProjectsSchema> {
  return store ??= new Store<RecentProjectsSchema>({ name: "recent-projects", defaults: { projects: [] } });
}

export function listRecentProjects(): RecentProject[] {
  return recentStore().get("projects");
}

export function recordRecentProject(path: string, title?: string): RecentProject[] {
  const clean = path.trim();
  if (!clean) return listRecentProjects();
  const now = Date.now();
  const existing = listRecentProjects().filter((entry) => entry.path !== clean);
  const next = [{ path: clean, title: title?.trim() || undefined, openedAt: now }, ...existing].slice(0, MAX_RECENT);
  recentStore().set("projects", next);
  return next;
}

/** 记录路径为「已授权保存路径」（来自用户对话框或最近打开）。 */
export function approveProjectPath(path: string): void {
  recordRecentProject(path);
}

/** 从最近项目列表移除指定路径（如文件已不存在或不可访问）。 */
export function removeRecentProject(path: string): RecentProject[] {
  const clean = path.trim();
  if (!clean) return listRecentProjects();
  const next = listRecentProjects().filter((entry) => entry.path !== clean);
  recentStore().set("projects", next);
  return next;
}
