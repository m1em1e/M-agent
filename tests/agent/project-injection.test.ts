import { describe, expect, it } from "vitest";
import { createMidiProject, createMidiTrack } from "../../src/core/midi";
import { buildProjectContext } from "../../src/core/agent/pi-kernel";

function project() {
  const value = createMidiProject({ id: "project-1", title: "Loop", ppq: 480, bpm: 100 });
  value.tracks.push(createMidiTrack({
    id: "melody",
    name: "Melody",
    role: "melody",
    channel: 0,
    program: 1,
    notes: [
      { id: "n1", pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 },
      { id: "n2", pitch: 64, startTick: 480, durationTicks: 480, velocity: 88 },
    ],
  }));
  value.tracks.push(createMidiTrack({
    id: "bass",
    name: "Bass",
    role: "bass",
    channel: 1,
    program: 33,
    notes: [
      { id: "b1", pitch: 36, startTick: 0, durationTicks: 480, velocity: 100 },
      { id: "b2", pitch: 40, startTick: 480, durationTicks: 480, velocity: 96 },
    ],
  }));
  return value;
}

const base = {
  requestId: "test",
  mode: "goal" as const,
  objective: "测试",
  project: project(),
};

describe("buildProjectContext", () => {
  it("injects the full project JSON by default", () => {
    const context = buildProjectContext({ ...base });
    expect(context).toContain("Current project (.magent):");
    expect(context).toContain('"id":"bass"');
    expect(context).toContain('"id":"melody"');
    expect(context).not.toContain("Selected track");
  });

  it("injects the overview plus only the selected track when requested", () => {
    const context = buildProjectContext({ ...base, projectInjection: "selected", focusTrackId: "melody" });
    expect(context).toContain("Current project overview:");
    expect(context).toContain("Selected track (Melody, id=melody):");
    expect(context).toContain('"id":"n1"');
    expect(context).not.toContain('"id":"b1"');
  });

  it("falls back to the full project when the selected track is missing", () => {
    const context = buildProjectContext({ ...base, projectInjection: "selected", focusTrackId: "missing-track" });
    expect(context).toContain("Current project (.magent):");
    expect(context).toContain('"id":"bass"');
  });
});
