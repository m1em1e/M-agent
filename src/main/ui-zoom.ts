/**
 * UI 缩放因子计算：窗口缩小时整体 UI 等比缩小，始终保持布局完整显示。
 * 锚定默认窗口（1480×920）的缩放为 1.15；按 min(宽比, 高比) 等比降缩放。
 */

export const UI_ZOOM_MAX = 1.15;
export const UI_ZOOM_MIN = 0.7;
export const DESIGN_WINDOW_WIDTH = 1480;
export const DESIGN_WINDOW_HEIGHT = 920;

export function computeUiZoomFactor(width: number, height: number): number {
  const scale = Math.min(width / DESIGN_WINDOW_WIDTH, height / DESIGN_WINDOW_HEIGHT);
  return Math.min(UI_ZOOM_MAX, Math.max(UI_ZOOM_MIN, scale * UI_ZOOM_MAX));
}