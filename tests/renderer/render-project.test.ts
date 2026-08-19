import { describe, expect, it } from "vitest";
import {
  computeAudibleEndTick,
  computeLoopEndTick,
  expandTracksByLoop,
  exportDurationSeconds,
  tickToSeconds,
  ExportTooLongError,
} from "../../src/renderer/audio/render-project";
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

  it("computes the loop end tick as max of loop ends and plain track ends", () => {
    const looped = track({
      loopRegion: { startTick: 480, endTick: 1920 },
      notes: [{ id: "nl", pitch: 60, startTick: 600, durationTicks: 480, velocity: 90 }],
    });
    const plain = track({ notes: [{ id: "np", pitch: 60, startTick: 0, durationTicks: 1440, velocity: 90 }] });
    expect(computeLoopEndTick([looped, plain])).toBe(1920);
    expect(computeLoopEndTick([looped])).toBe(1920);
    expect(computeLoopEndTick([plain])).toBe(1440);
  });

  it("honors mute and solo in loop end tick", () => {
    const looped = track({ loopRegion: { startTick: 0, endTick: 960 }, notes: [] });
    const muted = track({ muted: true, loopRegion: { startTick: 0, endTick: 10000 }, notes: [] });
    const plain = track({ notes: [{ id: "np", pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 }] });
    expect(computeLoopEndTick([looped, muted, plain])).toBe(960);
    const solo = track({ solo: true, loopRegion: { startTick: 0, endTick: 120 }, notes: [] });
    expect(computeLoopEndTick([looped, plain, solo])).toBe(120);
  });

  it("expands loop notes repeatedly from the loop start to the project end", () => {
    const melody = track({
      loopRegion: { startTick: 480, endTick: 1920 },
      notes: [
        { id: "inside", pitch: 60, startTick: 600, durationTicks: 480, velocity: 90 },
        { id: "before", pitch: 62, startTick: 100, durationTicks: 480, velocity: 90 },
        { id: "cross", pitch: 66, startTick: 1500, durationTicks: 960, velocity: 90 },
      ],
    });
    const expanded = expandTracksByLoop([melody], 3840)[0].notes;
    expect(expanded).toHaveLength(9);
    expect(expanded.map((note) => note.startTick)).toEqual([600, 480, 1500, 2040, 1920, 2940, 3480, 3360, 4380]);
    expect(expanded[0]).toMatchObject({ id: "inside-0", startTick: 600, durationTicks: 480 });
    expect(expanded[1]).toMatchObject({ id: "before-0", startTick: 480, durationTicks: 100 });
    expect(expanded[2]).toMatchObject({ id: "cross-0", startTick: 1500, durationTicks: 420 });
    expect(expanded[5]).toMatchObject({ id: "cross-1440", startTick: 2940, durationTicks: 420 });
  });

  it("keeps tracks without a loop region untouched", () => {
    const plain = track({ notes: [{ id: "np", pitch: 60, startTick: 0, durationTicks: 1440, velocity: 90 }] });
    const result = expandTracksByLoop([plain], 1920);
    expect(result[0]).toBe(plain);
  });

  it("empties loop tracks whose notes all fall outside the loop", () => {
    const empty = track({
      loopRegion: { startTick: 480, endTick: 1920 },
      notes: [{ id: "n", pitch: 60, startTick: 0, durationTicks: 10, velocity: 90 }],
    });
    const expanded = expandTracksByLoop([empty], 3840);
    expect(expanded[0].notes).toHaveLength(0);
  });
});
