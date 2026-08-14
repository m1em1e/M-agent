import { describe, expect, it } from "vitest";
import {
  ChangeSetValidationError,
  MidiTransactionHistory,
  applyChangeSet,
  createMidiProject,
  validateChangeSet,
} from "../../src/core/midi";

function sequentialIds() {
  let value = 0;
  return (prefix: string) => `${prefix}_${value++}`;
}

describe("MIDI project edits", () => {
  it("applies an atomic multi-operation change set without mutating the input", () => {
    const project = createMidiProject({ id: "project", idFactory: sequentialIds() });
    const result = applyChangeSet(
      project,
      {
        id: "change_1",
        summary: "Add a melody",
        operations: [
          {
            type: "create_track",
            track: { id: "melody", name: "Melody", role: "melody", channel: 0, program: 1 },
          },
          {
            type: "insert_notes",
            trackId: "melody",
            notes: [{ id: "c4", pitch: 60, startTick: 0, durationTicks: 480, velocity: 100 }],
          },
          { type: "set_tempo", tick: 0, bpm: 128 },
          { type: "set_loop", startTick: 0, endTick: 1920 },
        ],
      },
      { idFactory: sequentialIds(), now: () => "2026-01-01T00:00:00.000Z" },
    );

    expect(project.tracks).toHaveLength(0);
    expect(result.project.tracks[0].notes[0]).toMatchObject({ id: "c4", pitch: 60 });
    expect(result.project.tempoMap[0].bpm).toBe(128);
    expect(result.project.loopRegion).toEqual({ startTick: 0, endTick: 1920 });
    expect(result.project.revisions.at(-1)).toMatchObject({
      label: "Add a melody",
      source: "user",
      changeSetId: "change_1",
    });
  });

  it("rejects invalid and unknown notes without partial writes", () => {
    const project = createMidiProject({ id: "project", idFactory: sequentialIds() });
    const changeSet = {
      id: "invalid",
      summary: "Invalid edit",
      operations: [
        { type: "create_track" as const, track: { id: "track", name: "Track", channel: 0 } },
        {
          type: "insert_notes" as const,
          trackId: "track",
          notes: [{ pitch: 200, startTick: -1, durationTicks: 0, velocity: 0 }],
        },
      ],
    };
    const validation = validateChangeSet(project, changeSet);
    expect(validation.valid).toBe(false);
    expect(validation.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(["INVALID_PITCH", "INVALID_START_TICK", "INVALID_DURATION", "INVALID_VELOCITY"]),
    );
    expect(() => applyChangeSet(project, changeSet)).toThrow(ChangeSetValidationError);
    expect(project.tracks).toHaveLength(0);
  });

  it("enforces an affected-note budget", () => {
    const project = createMidiProject({ id: "project", idFactory: sequentialIds() });
    const validation = validateChangeSet(
      project,
      {
        id: "large",
        summary: "Too large",
        operations: [{
          type: "create_track",
          track: {
            name: "Track",
            notes: [
              { pitch: 60, startTick: 0, durationTicks: 1, velocity: 1 },
              { pitch: 61, startTick: 1, durationTicks: 1, velocity: 1 },
            ],
          },
        }],
      },
      { maximumAffectedNotes: 1 },
    );
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((issue) => issue.code === "NOTE_BUDGET_EXCEEDED")).toBe(true);
  });

  it("assigns distinct IDs while validating multiple ID-less notes", () => {
    const project = createMidiProject({ id: "project", idFactory: sequentialIds() });
    const changeSet = {
      id: "generated-ids",
      summary: "Generate notes",
      operations: [{
        type: "create_track" as const,
        track: {
          name: "Generated",
          notes: [
            { pitch: 60, startTick: 0, durationTicks: 120, velocity: 80 },
            { pitch: 64, startTick: 120, durationTicks: 120, velocity: 80 },
          ],
        },
      }],
    };
    expect(validateChangeSet(project, changeSet).valid).toBe(true);
    const applied = applyChangeSet(project, changeSet, { idFactory: sequentialIds() }).project;
    expect(new Set(applied.tracks[0].notes.map((note) => note.id)).size).toBe(2);
  });

  it("reports malformed runtime payloads instead of throwing from validation", () => {
    const project = createMidiProject({ id: "project", idFactory: sequentialIds() });
    const malformed = {
      id: "malformed",
      summary: "Malformed",
      operations: [null, { type: "create_track", track: { name: "Track" } }, {
        type: "insert_notes",
        trackId: "validation_track_0",
        notes: [null],
      }],
    } as unknown as Parameters<typeof validateChangeSet>[1];
    expect(() => validateChangeSet(project, malformed)).not.toThrow();
    expect(validateChangeSet(project, malformed).valid).toBe(false);
  });

  it("writes only domain fields from note and time-signature operations", () => {
    const base = applyChangeSet(
      createMidiProject({ id: "project", idFactory: sequentialIds() }),
      {
        id: "seed",
        summary: "Seed",
        operations: [{
          type: "create_track",
          track: {
            id: "track",
            name: "Track",
            notes: [{ id: "note", pitch: 60, startTick: 0, durationTicks: 120, velocity: 80 }],
          },
        }],
      },
      { idFactory: sequentialIds() },
    ).project;
    const updated = applyChangeSet(base, {
      id: "update",
      summary: "Update",
      operations: [
        { type: "update_notes", trackId: "track", changes: [{ noteId: "note", velocity: 96 }] },
        { type: "set_time_signature", tick: 480, numerator: 3, denominator: 4 },
      ],
    }).project;
    expect(updated.tracks[0].notes[0]).toEqual({
      id: "note",
      pitch: 60,
      startTick: 0,
      durationTicks: 120,
      velocity: 96,
    });
    expect(updated.timeSignatures[1]).toEqual({ tick: 480, numerator: 3, denominator: 4 });
  });
});

describe("MIDI transaction history", () => {
  it("undoes and redoes the same atomic project state", () => {
    const history = new MidiTransactionHistory(createMidiProject({ id: "project", idFactory: sequentialIds() }));
    history.apply(
      {
        id: "change",
        summary: "Create bass",
        operations: [{ type: "create_track", track: { id: "bass", name: "Bass", role: "bass", channel: 1 } }],
      },
      { idFactory: sequentialIds() },
    );
    expect(history.project.tracks).toHaveLength(1);
    expect(history.undo()?.tracks).toHaveLength(0);
    expect(history.canRedo).toBe(true);
    expect(history.redo()?.tracks[0].id).toBe("bass");
  });

  it("clears redo history after a new transaction", () => {
    const history = new MidiTransactionHistory(createMidiProject({ id: "project", idFactory: sequentialIds() }));
    history.apply({ id: "one", summary: "One", operations: [{ type: "set_tempo", tick: 0, bpm: 100 }] });
    history.undo();
    history.apply({ id: "two", summary: "Two", operations: [{ type: "set_tempo", tick: 0, bpm: 140 }] });
    expect(history.canRedo).toBe(false);
    expect(history.project.tempoMap[0].bpm).toBe(140);
  });
});
