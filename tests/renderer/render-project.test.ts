import { describe, expect, it } from "vitest";
import { computeAudibleEndTick, exportDurationSeconds, tickToSeconds, ExportTooLongError } from "../../src/renderer/audio/render-project";
import type { MidiTrack } from "../../src/shared/midi";

function track(overrides: Partial<MidiTrack>): MidiTrack {
  return {
    id: "t",
    name: "T",
    role: "other",
    channel: 0,
    program: 0,
    muted: false,
    solo: false,
    notes: [],
    ...overrides,
  };
}

describe("render-project helpers", () => {
  it("converts ticks to seconds", () => {
    expect(tickToSeconds(480, 480, 120)).toBe(0.5);
    expect(tickToSeconds(960, 480, 120)).toBe(1);
  });

  it("computes the end tick of the longest audible track", () => {
    const melody = track({
      notes: [
        { id: "n1", pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 },
        { id: "n2", pitch: 64, startTick: 480, durationTicks: 960, velocity: 90 },
      ],
    });
    const muted = track({ muted: true, notes: [{ id: "nm", pitch: 48, startTick: 10000, durationTicks: 960, velocity: 90 }] });
    expect(computeAudibleEndTick([melody, muted])).toBe(1440);
    expect(computeAudibleEndTick([])).toBe(0);
  });

  it("honors solo over mute", () => {
    const solo = track({ solo: true, notes: [{ id: "ns", pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 }] });
    const other = track({ notes: [{ id: "no", pitch: 60, startTick: 0, durationTicks: 1920, velocity: 90 }] });
    expect(computeAudibleEndTick([solo, other])).toBe(480);
  });

  it("derives export duration with a release tail", () => {
    expect(exportDurationSeconds(0, 480, 120)).toBe(2);
    expect(exportDurationSeconds(960, 480, 120)).toBe(3);
    expect(exportDurationSeconds(960, 480, 120, 0)).toBe(1);
  });

  it("produces a readable too-long error", () => {
    const error = new ExportTooLongError(600.5, 60);
    expect(error.message).toContain("600.5 秒");
    expect(error.message).toContain("60 秒");
  });
});
