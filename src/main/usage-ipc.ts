import { ipcMain } from "electron";
import { clearUsage, getUsageByDay, getUsageByModel, getUsageSummary } from "./usage-store.js";

export function registerUsageIpc(): void {
  ipcMain.handle("usage:get-summary", () => getUsageSummary());
  ipcMain.handle("usage:get-days", (_event, page: unknown) => {
    return getUsageByDay(parsePage(page));
  });
  ipcMain.handle("usage:get-models", (_event, page: unknown) => {
    return getUsageByModel(parsePage(page));
  });
  ipcMain.handle("usage:clear", () => {
    clearUsage();
  });
}

function parsePage(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return Math.floor(value);
  return 1;
}
