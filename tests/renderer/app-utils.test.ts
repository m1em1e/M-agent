import { describe, expect, it } from "vitest";
import {
  applyNoteChangeSet,
  candidateFromChangeSet,
  clamp,
  cleanAgentError,
  computeBarCount,
  errorMessage,
  isBlackKey,
  isMissingProjectError,
  mergeEventsByTick,
  noteDurationMs,
  noteName,
  normalizeCcEvents,
  normalizePitchBends,
  normalizeTimeSignatureNumerator,
  pattern,
  projectToTracks,
  toProjectPayload,
  uid,
  upsertTempoEvent,
  upsertTimeSignature,
  validateNote,
} from "../../src/renderer/app-utils";
import type { MidiTrack, ProjectMetadata } from "../../src/renderer/app-utils";

const makeTrack = (overrides: Partial<MidiTrack> = {}): MidiTrack => ({
  id: "track-1",
  name: "Melody",
  role: "melody",
  color: "#ff9d78",
  channel: 0,
  program: 0,
  muted: false,
  solo: false,
  notes: [],
  ...overrides,
});

describe("note helpers", () => {
  it("noteName returns the standard name", () => {
    expect(noteName(60)).toBe("C4");
    expect(noteName(61)).toBe("C♯4");
    expect(noteName(69)).toBe("A4");
    expect(noteName(48)).toBe("C3");
  });

  it("isBlackKey", () => {
    expect(isBlackKey(61)).toBe(true);
    expect(isBlackKey(60)).toBe(false);
  });

  it("clamp", () => {
    expect(clamp(5, 0, 10)).toBe(5);
    expect(clamp(-1, 0, 10)).toBe(0);
    expect(clamp(11, 0, 10)).toBe(10);
  });
});

describe("tempo / time signature helpers", () => {
  it("normalizeTimeSignatureNumerator keeps valid values", () => {
    expect(normalizeTimeSignatureNumerator(4, 4)).toBe(4);
    expect(normalizeTimeSignatureNumerator(3, 8)).toBe(3);
  });

  it("normalizeTimeSignatureNumerator snaps invalid values to the nearest allowed", () => {
    expect(normalizeTimeSignatureNumerator(10, 8)).toBe(9);
    expect(normalizeTimeSignatureNumerator(5, 1)).toBe(4);
  });

  it("upsertTempoEvent replaces existing tick and sorts", () => {
    expect(upsertTempoEvent([{ tick: 4, bpm: 100 }, { tick: 0, bpm: 120 }], 4, 90))
      .toEqual([{ tick: 0, bpm: 120 }, { tick: 4, bpm: 90 }]);
  });

  it("upsertTimeSignature replaces existing tick and sorts", () => {
    expect(upsertTimeSignature([{ tick: 0, numerator: 4, denominator: 4 }], { tick: 0, numerator: 3, denominator: 4 }))
      .toEqual([{ tick: 0, numerator: 3, denominator: 4 }]);
  });

  it("mergeEventsByTick merges with incoming wins and sorts", () => {
    expect(mergeEventsByTick([{ tick: 2, bpm: 1 }, { tick: 0, bpm: 1 }], [{ tick: 2, bpm: 99 }]))
      .toEqual([{ tick: 0, bpm: 1 }, { tick: 2, bpm: 99 }]);
  });
});

describe("note timing and generation", () => {
  it("noteDurationMs clamps into the audible range", () => {
    expect(noteDurationMs({ durationTicks: 100000 }, 480, 120)).toBe(8000);
    expect(noteDurationMs({ durationTicks: 1 }, 480, 120)).toBe(80);
    expect(noteDurationMs({ durationTicks: 480 }, 480, 120)).toBe(500);
  });

  it("pattern generates one note per beat with per-index velocity variation", () => {
    const notes = pattern([60, 62], 480, 240, 2, 88);
    expect(notes).toHaveLength(8);
    expect(notes[0].pitch).toBe(60);
    expect(notes[1].pitch).toBe(62);
    expect(notes[1].startTick).toBe(480);
    expect(notes.every((note) => note.durationTicks >= 1)).toBe(true);
  });

  it("computeBarCount floors at 16 with 4-bar padding", () => {
    expect(computeBarCount([makeTrack()], 480)).toBe(16);
    expect(computeBarCount([makeTrack({ notes: [{ id: "n", pitch: 60, startTick: 0, durationTicks: 480 * 160, velocity: 100 }] })], 480)).toBe(44);
  });
});

describe("uid", () => {
  it("produces incrementing unique ids", () => {
    const a = uid("note");
    const b = uid("note");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^note-/);
  });
});

describe("validateNote", () => {
  it("accepts a valid note", () => {
    expect(validateNote({ id: "n", pitch: 60, startTick: 0, durationTicks: 480, velocity: 100 })).toBe(true);
  });

  it("rejects out-of-range fields", () => {
    expect(validateNote({ id: "", pitch: 60, startTick: 0, durationTicks: 480, velocity: 100 })).toBe(false);
    expect(validateNote({ id: "n", pitch: 128, startTick: 0, durationTicks: 480, velocity: 100 })).toBe(false);
    expect(validateNote({ id: "n", pitch: 60, startTick: 0, durationTicks: 0, velocity: 100 })).toBe(false);
    expect(validateNote({ id: "n", pitch: 60, startTick: 0, durationTicks: 480, velocity: 0 })).toBe(false);
  });
});

describe("normalizeCcEvents / normalizePitchBends", () => {
  it("assigns ids and sorts by tick then controller", () => {
    const events = normalizeCcEvents([
      { controller: 64, tick: 480, value: 127 },
      { controller: 10, tick: 0, value: 64 },
    ]);
    expect(events.map((event) => event.tick)).toEqual([0, 480]);
    expect(events[0].controller).toBe(10);
    expect(events.every((event) => event.id.startsWith("cc-"))).toBe(true);
  });

  it("normalizePitchBends assigns ids and sorts by tick", () => {
    const bends = normalizePitchBends([{ tick: 240, value: 100 }, { tick: 0, value: -100 }]);
    expect(bends.map((bend) => bend.tick)).toEqual([0, 240]);
    expect(bends.every((bend) => bend.id.startsWith("pb-"))).toBe(true);
  });
});

describe("candidateFromChangeSet", () => {
  it("counts affected notes and marks supported ops", () => {
    const candidate = candidateFromChangeSet({
      id: "c",
      summary: "add bass",
      operations: [{ type: "insert_notes", trackId: "track-1", notes: [{ pitch: 48, startTick: 0, durationTicks: 480, velocity: 90 }] }],
    }, 0, "goal");
    expect(candidate.notesAdded).toBe(1);
    expect(candidate.supported).toBe(true);
    expect(candidate.score).toBeGreaterThan(0);
  });

  it("marks validation failures as unsupported with zero score", () => {
    const candidate = candidateFromChangeSet({
      id: "c",
      summary: "invalid",
      operations: [{ type: "insert_notes", trackId: "track-1", notes: [] }],
      validation: [{ valid: false, issues: [], affectedNotes: 0 }],
    }, 0, "goal");
    expect(candidate.supported).toBe(false);
    expect(candidate.score).toBe(0);
  });
});

describe("project conversion", () => {
  const metadata: ProjectMetadata = {
    id: "proj-1",
    tempoMap: [{ tick: 0, bpm: 120 }],
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    loopRegion: null,
    revisions: [],
    agentSessions: [],
  };

  it("projectToTracks adds colors and default volume", () => {
    const project = {
      id: "proj-1",
      title: "T",
      ppq: 480,
      tempoMap: [{ tick: 0, bpm: 120 }],
      timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
      loopRegion: null,
      revisions: [],
      agentSessions: [],
      tracks: [{ ...makeTrack({ volume: undefined }) }],
    };
    const tracks = projectToTracks(project);
    expect(tracks[0].color).toMatch(/^#/);
    expect(tracks[0].volume).toBe(1);
  });

  it("toProjectPayload strips color but keeps note-level MIDI properties", () => {
    const tracks: MidiTrack[] = [makeTrack({
      notes: [{ id: "n", pitch: 60, startTick: 0, durationTicks: 480, velocity: 100, pan: -30, release: 0.4 }],
    })];
    const payload = toProjectPayload("T", 480, 120, 4, 4, tracks, metadata, [], []);
    expect(payload.title).toBe("T");
    expect(payload.tracks[0]).not.toHaveProperty("color");
    expect(payload.tracks[0].notes[0].pan).toBe(-30);
    expect(payload.tracks[0].notes[0].release).toBe(0.4);
  });
});

describe("applyNoteChangeSet", () => {
  it("applies insert / update / delete operations atomically", () => {
    const base = [makeTrack({
      notes: [{ id: "n1", pitch: 60, startTick: 0, durationTicks: 480, velocity: 100 }],
    })];
    const result = applyNoteChangeSet(base, {
      id: "c",
      summary: "edit",
      operations: [
        { type: "update_notes", trackId: "track-1", changes: [{ noteId: "n1", velocity: 80 }] },
        { type: "insert_notes", trackId: "track-1", notes: [{ id: "n2", pitch: 64, startTick: 480, durationTicks: 240, velocity: 90 }] },
        { type: "delete_notes", trackId: "track-1", noteIds: ["n2"] },
      ],
    });
    expect(result.tracks[0].notes).toHaveLength(1);
    expect(result.tracks[0].notes[0].velocity).toBe(80);
  });

  it("supports track and project-level operations", () => {
    const result = applyNoteChangeSet([makeTrack()], {
      id: "c",
      summary: "arrange",
      operations: [
        { type: "create_track", track: { id: "track-2", name: "Bass", role: "bass", channel: 2, program: 32 } },
        { type: "set_tempo", tick: 0, bpm: 140 },
        { type: "set_time_signature", tick: 0, numerator: 3, denominator: 4 },
        { type: "set_loop", startTick: 0, endTick: 1920 },
        { type: "delete_track", trackId: "track-1" },
      ],
    });
    expect(result.tracks).toHaveLength(1);
    expect(result.tracks[0].id).toBe("track-2");
    expect(result.tempo).toBe(140);
    expect(result.timeSigNumerator).toBe(3);
    expect(result.loopRegion).toEqual({ startTick: 0, endTick: 1920 });
  });

  it("throws on unknown track references", () => {
    expect(() => applyNoteChangeSet([makeTrack()], {
      id: "c",
      summary: "bad",
      operations: [{ type: "insert_notes", trackId: "missing", notes: [{ pitch: 60, startTick: 0, durationTicks: 480, velocity: 100 }] }],
    })).toThrow(/不存在的轨道/);
  });
});

describe("error helpers", () => {
  it("errorMessage appends the error detail", () => {
    expect(errorMessage(new Error("boom"), "失败")).toBe("失败：boom");
    expect(errorMessage(null, "失败")).toBe("失败");
  });

  it("cleanAgentError strips IPC wrapping", () => {
    expect(cleanAgentError(new Error("Error invoking remote method 'agent:run': Error: 上游超时"))).toContain("上游超时");
  });

  it("isMissingProjectError detects the marker", () => {
    expect(isMissingProjectError(new Error("PROJECT_MISSING: gone"))).toBe(true);
    expect(isMissingProjectError(new Error("other"))).toBe(false);
  });
});