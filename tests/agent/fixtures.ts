import type { MidiProject } from "../../src/shared/midi";

export function createTestProject(): MidiProject {
  return {
    id: "project-1",
    title: "Agent test",
    ppq: 480,
    tempoMap: [{ tick: 0, bpm: 120 }],
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    loopRegion: { startTick: 0, endTick: 1920 },
    tracks: [
      {
        id: "track-1",
        name: "Melody",
        role: "melody",
        channel: 0,
        program: 0,
        muted: false,
        solo: false,
        notes: [],
      },
    ],
    revisions: [],
    agentSessions: [],
  };
}

export function validRawChangeSet(id = "candidate-1"): Record<string, unknown> {
  return {
    id,
    summary: "Add a motif",
    operations: [
      {
        type: "insert_notes",
        trackId: "track-1",
        notes: [
          { pitch: 64, startTick: 0, durationTicks: 480, velocity: 90 },
        ],
      },
    ],
    validation: [],
    estimatedAffectedNotes: 1,
  };
}
