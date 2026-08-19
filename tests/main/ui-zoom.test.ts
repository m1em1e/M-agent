import { describe, expect, it } from "vitest";
import { computeUiZoomFactor, DESIGN_WINDOW_HEIGHT, DESIGN_WINDOW_WIDTH, UI_ZOOM_MAX, UI_ZOOM_MIN } from "../../src/main/ui-zoom";

describe("computeUiZoomFactor", () => {
  it("默认窗口尺寸保持当前缩放 1.15", () => {
    expect(computeUiZoomFactor(DESIGN_WINDOW_WIDTH, DESIGN_WINDOW_HEIGHT)).toBe(UI_ZOOM_MAX);
  });

  it("窗口缩小后等比降低缩放，不裁剪", () => {
    const zoom = computeUiZoomFactor(1250, 800);
    expect(zoom).toBeLessThan(UI_ZOOM_MAX);
    expect(zoom).toBeGreaterThan(0.9);
  });

  it("按宽高较小比例缩放（较窄维度主导缩放）", () => {
    const byNarrowWidth = computeUiZoomFactor(1200, 920);
    const byNarrowHeight = computeUiZoomFactor(1480, 700);
    const wider = computeUiZoomFactor(1480, 920);
    expect(byNarrowWidth).toBeLessThan(wider);
    expect(byNarrowHeight).toBeLessThan(wider);
    expect(byNarrowHeight).toBeLessThan(byNarrowWidth);
  });

  it("放大窗口时封顶在 1.15", () => {
    expect(computeUiZoomFactor(1920, 1080)).toBe(UI_ZOOM_MAX);
    expect(computeUiZoomFactor(4000, 4000)).toBe(UI_ZOOM_MAX);
  });

  it("过小窗口钳制在最小缩放 0.7", () => {
    expect(computeUiZoomFactor(100, 100)).toBe(UI_ZOOM_MIN);
  });

  it("极小尺寸按较小比例钳制，不越过下限", () => {
    const zoom = computeUiZoomFactor(640, 480);
    expect(zoom).toBeGreaterThanOrEqual(UI_ZOOM_MIN);
  });
});