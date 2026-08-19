import { describe, expect, it } from "vitest";
import { projectVersionOf } from "../../src/shared/project-version";

const base = {
  title: "Loop",
  ppq: 480,
  tempo: 120,
  tracks: [{
    id: "melody",
    name: "Melody",
    role: "melody" as const,
    channel: 0,
    program: 1,
    muted: false,
    solo: false,
    notes: [{ pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 }],
  }],
};

describe("projectVersionOf", () => {
  it("is stable for identical content", () => {
    expect(projectVersionOf(base)).toBe(projectVersionOf({ ...base, tracks: [...base.tracks] }));
  });

  it("changes when note content changes", () => {
    const changed = { ...base, tracks: [{
      ...base.tracks[0],
      notes: [{ ...base.tracks[0].notes[0], velocity: 91 }],
    }] };
    expect(projectVersionOf(changed)).not.toBe(projectVersionOf(base));
  });

  it("changes when track order changes", () => {
    const two = {
      ...base,
      tracks: [
        { ...base.tracks[0], id: "a", name: "A" },
        { ...base.tracks[0], id: "b", name: "B" },
      ],
    };
    const swapped = {
      ...base,
      tracks: [
        { ...base.tracks[0], id: "b", name: "B" },
        { ...base.tracks[0], id: "a", name: "A" },
      ],
    };
    expect(projectVersionOf(swapped)).not.toBe(projectVersionOf(two));
  });

  it("changes when tempo changes", () => {
    expect(projectVersionOf({ ...base, tempo: 130 })).not.toBe(projectVersionOf(base));
  });

  it("changes when a per-track loop region changes", () => {
    const withLoop = {
      ...base,
      tracks: [{ ...base.tracks[0], loopRegion: { startTick: 480, endTick: 1920 } }],
    };
    const movedLoop = {
      ...base,
      tracks: [{ ...base.tracks[0], loopRegion: { startTick: 960, endTick: 1920 } }],
    };
    expect(projectVersionOf(withLoop)).not.toBe(projectVersionOf(base));
    expect(projectVersionOf(movedLoop)).not.toBe(projectVersionOf(withLoop));
  });
});
