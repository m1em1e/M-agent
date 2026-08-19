import type { TickRange } from "../shared/midi.js";

/** 循环带边缘缩放命中区域（像素）。 */
export const LOOP_EDGE_PX = 6;

/** 循环带顶部手柄条高度（像素）。 */
export const LOOP_HANDLE_HEIGHT = 7;

export type LoopHit = "resize-start" | "resize-end" | "move" | null;

/**
 * 判断指针 x 是否命中 [startPx, endPx] 区间内的循环带，以及命中模式。
 * 命中左/右边缘 LOOP_EDGE_PX 像素为缩放，其余为整体移动。
 */
export function hitLoopBand(startPx: number, endPx: number, x: number): LoopHit {
  if (x < startPx || x > endPx) return null;
  if (x - startPx <= LOOP_EDGE_PX) return "resize-start";
  if (endPx - x <= LOOP_EDGE_PX) return "resize-end";
  return "move";
}

/**
 * 由一次拖拽的两个 tick 端点计算循环区间。
 * 端点取最小/最大归一化；区间为空（反向或宽度为 0）返回 null 表示清除/不创建。
 */
export function loopRangeFromDrag(startTick: number, endTick: number): TickRange | null {
  if (!Number.isFinite(startTick) || !Number.isFinite(endTick)) return null;
  const first = Math.round(Math.max(0, Math.min(startTick, endTick)));
  const second = Math.round(Math.max(0, Math.max(startTick, endTick)));
  if (second <= first) return null;
  return { startTick: first, endTick: second };
}

/** 整体移动：区间平移 deltaTicks，平移出界或反向后返回 null（表示清除）。 */
export function shiftedLoopRange(range: TickRange, deltaTicks: number): TickRange | null {
  return loopRangeFromDrag(range.startTick + deltaTicks, range.endTick + deltaTicks);
}

/** 缩放起点边：起点越过原终点返回 null（表示清除）。 */
export function resizedLoopStart(range: TickRange, newStartTick: number): TickRange | null {
  if (newStartTick >= range.endTick) return null;
  return { startTick: Math.max(0, newStartTick), endTick: range.endTick };
}

/** 缩放终点边：终点越过原起点返回 null（表示清除）。 */
export function resizedLoopEnd(range: TickRange, newEndTick: number): TickRange | null {
  if (newEndTick <= range.startTick) return null;
  return { startTick: range.startTick, endTick: newEndTick };
}