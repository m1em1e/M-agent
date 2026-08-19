import { describe, expect, it } from "vitest";
import {
  hitLoopBand,
  loopRangeFromDrag,
  resizedLoopEnd,
  resizedLoopStart,
  shiftedLoopRange,
} from "../../src/renderer/loop-ruler";

describe("hitLoopBand", () => {
  const startPx = 100;
  const endPx = 300;

  it("returns null outside the band", () => {
    expect(hitLoopBand(startPx, endPx, 99)).toBeNull();
    expect(hitLoopBand(startPx, endPx, 301)).toBeNull();
  });

  it("detects edge resizing within LOOP_EDGE_PX", () => {
    expect(hitLoopBand(startPx, endPx, 100)).toBe("resize-start");
    expect(hitLoopBand(startPx, endPx, 105)).toBe("resize-start");
    expect(hitLoopBand(startPx, endPx, 106)).toBe("resize-start");
    expect(hitLoopBand(startPx, endPx, 107)).toBe("move");
    expect(hitLoopBand(startPx, endPx, 293)).toBe("move");
    expect(hitLoopBand(startPx, endPx, 294)).toBe("resize-end");
    expect(hitLoopBand(startPx, endPx, 300)).toBe("resize-end");
  });
});

describe("loopRangeFromDrag", () => {
  it("normalizes drag direction", () => {
    expect(loopRangeFromDrag(480, 1920)).toEqual({ startTick: 480, endTick: 1920 });
    expect(loopRangeFromDrag(1920, 480)).toEqual({ startTick: 480, endTick: 1920 });
  });

  it("returns null for empty or reversed ranges", () => {
    expect(loopRangeFromDrag(480, 480)).toBeNull();
    expect(loopRangeFromDrag(0, 0)).toBeNull();
    expect(loopRangeFromDrag(Number.NaN, 480)).toBeNull();
  });

  it("clamps negative ticks to zero", () => {
    expect(loopRangeFromDrag(-480, 960)).toEqual({ startTick: 0, endTick: 960 });
  });
});

describe("shiftedLoopRange", () => {
  it("shifts the range by delta", () => {
    expect(shiftedLoopRange({ startTick: 480, endTick: 1920 }, 240))
      .toEqual({ startTick: 720, endTick: 2160 });
    expect(shiftedLoopRange({ startTick: 480, endTick: 1920 }, -240))
      .toEqual({ startTick: 240, endTick: 1680 });
  });

  it("returns null when moved fully out of range", () => {
    expect(shiftedLoopRange({ startTick: 480, endTick: 960 }, -960)).toBeNull();
    expect(shiftedLoopRange({ startTick: 480, endTick: 960 }, 10000))
      .toEqual({ startTick: 10480, endTick: 10960 });
  });
});

describe("resizedLoopStart", () => {
  it("moves the start edge and clamps at zero", () => {
    expect(resizedLoopStart({ startTick: 480, endTick: 1920 }, 240))
      .toEqual({ startTick: 240, endTick: 1920 });
    expect(resizedLoopStart({ startTick: 480, endTick: 1920 }, -100))
      .toEqual({ startTick: 0, endTick: 1920 });
  });

  it("clears when the start passes the end (reverse)", () => {
    expect(resizedLoopStart({ startTick: 480, endTick: 1920 }, 1920)).toBeNull();
    expect(resizedLoopStart({ startTick: 480, endTick: 1920 }, 2400)).toBeNull();
  });
});

describe("resizedLoopEnd", () => {
  it("moves the end edge", () => {
    expect(resizedLoopEnd({ startTick: 480, endTick: 1920 }, 2400))
      .toEqual({ startTick: 480, endTick: 2400 });
  });

  it("clears when the end passes the start (reverse)", () => {
    expect(resizedLoopEnd({ startTick: 480, endTick: 1920 }, 480)).toBeNull();
    expect(resizedLoopEnd({ startTick: 480, endTick: 1920 }, 0)).toBeNull();
  });
});