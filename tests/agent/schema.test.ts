import { describe, expect, it } from "vitest";
import {
  ChangeSetSchemaError,
  isProposedChangeSet,
  parseProposedChangeSet,
} from "../../src/core/agent";
import { validRawChangeSet } from "./fixtures";

describe("proposed change-set schema", () => {
  it("accepts a valid structured operation", () => {
    const result = parseProposedChangeSet(validRawChangeSet());
    expect(result.operations).toHaveLength(1);
    expect(result.estimatedAffectedNotes).toBe(1);
    expect(isProposedChangeSet(result)).toBe(true);
  });

  it("rejects an unsupported operation", () => {
    const input = validRawChangeSet();
    input.operations = [{ type: "overwrite_file", path: "music.mid" }];
    expect(() => parseProposedChangeSet(input)).toThrow(ChangeSetSchemaError);
  });

  it("accepts update_track instrument change and null clear", () => {
    const set = validRawChangeSet();
    set.operations = [{
      type: "update_track",
      trackId: "track-1",
      changes: { instrument: { type: "soundfont", libraryId: "lib-1", bank: 0, program: 12 } },
    }];
    expect(parseProposedChangeSet(set)).toMatchObject({ operations: [expect.objectContaining({ type: "update_track" })] });
    set.operations = [{ type: "update_track", trackId: "track-1", changes: { instrument: null } }];
    expect(parseProposedChangeSet(set)).toBeTruthy();
  });

  it("rejects an invalid instrument reference", () => {
    const input = validRawChangeSet();
    input.operations = [{
      type: "update_track",
      trackId: "track-1",
      changes: { instrument: { type: "soundfont", libraryId: 5, bank: 0, program: 12 } },
    }];
    expect(() => parseProposedChangeSet(input)).toThrow(ChangeSetSchemaError);
  });

  it("rejects invalid note bounds without partial acceptance", () => {
    const input = validRawChangeSet();
    input.operations = [
      {
        type: "insert_notes",
        trackId: "track-1",
        notes: [{ pitch: 200, startTick: -1, durationTicks: 0, velocity: 0 }],
      },
    ];
    expect(() => parseProposedChangeSet(input)).toThrow(/pitch.*startTick.*durationTicks.*velocity/);
  });

  it("accepts project track and loop operations from the shared domain", () => {
    const input = validRawChangeSet();
    input.operations = [
      { type: "update_track", trackId: "track-1", changes: { program: 40 } },
      { type: "clear_loop" },
    ];
    expect(parseProposedChangeSet(input).operations).toHaveLength(2);
  });

  it("accepts create_track notes without ids (app auto-generates them)", () => {
    const input = validRawChangeSet();
    input.operations = [{
      type: "create_track",
      track: {
        name: "Drums",
        role: "drums",
        channel: 9,
        program: 0,
        muted: false,
        solo: false,
        notes: [
          { pitch: 36, startTick: 0, durationTicks: 240, velocity: 90 },
          { pitch: 38, startTick: 480, durationTicks: 240, velocity: 85 },
        ],
      },
    }];
    expect(parseProposedChangeSet(input).operations).toHaveLength(1);
  });

  it("accepts create_track with a custom id and instrument reference", () => {
    const input = validRawChangeSet();
    input.operations = [{
      type: "create_track",
      track: {
        id: "bass",
        name: "Bass",
        role: "bass",
        channel: 0,
        program: 33,
        muted: false,
        solo: false,
        instrument: { type: "soundfont", libraryId: "lib-1", bank: 0, program: 33 },
        notes: [{ pitch: 48, startTick: 0, durationTicks: 480, velocity: 90 }],
      },
    }];
    const parsed = parseProposedChangeSet(input);
    const track = (parsed.operations[0] as unknown as { track: Record<string, unknown> }).track;
    expect(track.id).toBe("bass");
    expect(track.instrument).toMatchObject({ type: "soundfont", libraryId: "lib-1" });
  });

  it("rejects create_track with an invalid instrument reference", () => {
    const input = validRawChangeSet();
    input.operations = [{
      type: "create_track",
      track: {
        name: "Bass",
        role: "bass",
        channel: 0,
        program: 33,
        muted: false,
        solo: false,
        instrument: { type: "soundfont", libraryId: 5, bank: 0, program: 33 },
      },
    }];
    expect(() => parseProposedChangeSet(input)).toThrow(ChangeSetSchemaError);
  });

  it("expands define_pattern + arrange_pattern into insert_notes", () => {
    const input = validRawChangeSet();
    input.operations = [
      {
        type: "define_pattern",
        patternId: "p1",
        trackId: "drums",
        lengthTicks: 1920,
        notes: [
          { pitch: 36, startTick: 0, durationTicks: 240, velocity: 90 },
          { pitch: 38, startTick: 480, durationTicks: 240, velocity: 85 },
        ],
      },
      {
        type: "arrange_pattern",
        trackId: "drums",
        parts: [{ patternId: "p1", startTick: 0, repeats: 3 }],
      },
    ];
    const parsed = parseProposedChangeSet(input);
    // define_pattern 不产生输出；arrange_pattern 展开为 repeats 条 insert_notes。
    const inserts = parsed.operations.filter((op) => op.type === "insert_notes");
    expect(inserts).toHaveLength(3);
    const second = inserts[1] as { notes: Array<{ startTick: number }> };
    expect(second.notes[0].startTick).toBe(1920);
    const third = inserts[2] as { notes: Array<{ startTick: number }> };
    expect(third.notes[1].startTick).toBe(480 + 2 * 1920);
  });

  it("applies transpose and velocityOffset in arrange_pattern", () => {
    const input = validRawChangeSet();
    input.operations = [
      {
        type: "define_pattern",
        patternId: "p1",
        trackId: "bass",
        lengthTicks: 1920,
        notes: [{ pitch: 40, startTick: 0, durationTicks: 480, velocity: 80 }],
      },
      {
        type: "arrange_pattern",
        trackId: "bass",
        parts: [{ patternId: "p1", startTick: 0, repeats: 2, transpose: 3, velocityOffset: 10 }],
      },
    ];
    const parsed = parseProposedChangeSet(input);
    const inserts = parsed.operations.filter((op) => op.type === "insert_notes");
    expect(inserts).toHaveLength(2);
    const first = inserts[0] as { notes: Array<{ pitch: number; velocity: number }> };
    expect(first.notes[0].pitch).toBe(43);
    expect(first.notes[0].velocity).toBe(90);
  });

  it("grows density with densityGrow across repeats", () => {
    const input = validRawChangeSet();
    input.operations = [
      {
        type: "define_pattern",
        patternId: "p1",
        trackId: "drums",
        lengthTicks: 960,
        notes: [
          { pitch: 36, startTick: 0, durationTicks: 240, velocity: 90 },
          { pitch: 42, startTick: 480, durationTicks: 240, velocity: 80 },
        ],
      },
      {
        type: "arrange_pattern",
        trackId: "drums",
        parts: [{ patternId: "p1", startTick: 0, repeats: 3, densityGrow: true }],
      },
    ];
    const parsed = parseProposedChangeSet(input);
    const inserts = parsed.operations.filter((op) => op.type === "insert_notes");
    const noteCounts = inserts.map((op) => (op as { notes: unknown[] }).notes.length);
    // 密度递进：每次 repeat 增加若干补插音（2 → 3 → 5）。
    expect(noteCounts).toEqual([2, 3, 5]);
  });

  it("rejects arrange_pattern referencing an undefined patternId", () => {
    const input = validRawChangeSet();
    input.operations = [{
      type: "arrange_pattern",
      trackId: "drums",
      parts: [{ patternId: "missing", startTick: 0 }],
    }];
    expect(() => parseProposedChangeSet(input)).toThrow(/未定义的 patternId/);
  });

  it("rejects duplicate patternId definitions", () => {
    const input = validRawChangeSet();
    input.operations = [
      { type: "define_pattern", patternId: "p1", trackId: "drums", lengthTicks: 960, notes: [{ pitch: 36, startTick: 0, durationTicks: 240, velocity: 90 }] },
      { type: "define_pattern", patternId: "p1", trackId: "bass", lengthTicks: 960, notes: [{ pitch: 40, startTick: 0, durationTicks: 240, velocity: 90 }] },
    ];
    expect(() => parseProposedChangeSet(input)).toThrow(/重复的 patternId/);
  });

  it("accepts create_track with controllerEvents/pitchBends (ids optional)", () => {
    const input = validRawChangeSet();
    input.operations = [{
      type: "create_track",
      track: {
        id: "bass",
        name: "Bass",
        role: "bass",
        channel: 2,
        program: 33,
        instrument: { type: "sfz", libraryId: "piano-fx" },
        controllerEvents: [{ tick: 0, controller: 74, value: 96 }, { tick: 480, controller: 10, value: 32 }],
        pitchBends: [{ tick: 0, value: 512 }, { tick: 960, value: -4096 }],
        notes: [{ pitch: 40, startTick: 0, durationTicks: 960, velocity: 84 }],
      },
    }];
    expect(parseProposedChangeSet(input)).toMatchObject({
      operations: [expect.objectContaining({ type: "create_track" })],
    });
  });

  it("accepts update_track replacing controllerEvents/pitchBends and null clear", () => {
    const set = validRawChangeSet();
    set.operations = [{
      type: "update_track",
      trackId: "track-1",
      changes: { controllerEvents: [{ tick: 0, controller: 74, value: 90 }], pitchBends: [] },
    }];
    expect(parseProposedChangeSet(set)).toBeTruthy();
    set.operations = [{ type: "update_track", trackId: "track-1", changes: { controllerEvents: null, pitchBends: null } }];
    expect(parseProposedChangeSet(set)).toBeTruthy();
  });

  it("rejects out-of-range controllerEvents and pitchBends", () => {
    const input = validRawChangeSet();
    input.operations = [{
      type: "create_track",
      track: { name: "Bad", channel: 0, program: 0, controllerEvents: [{ tick: 0, controller: 128, value: 500 }] },
    }];
    expect(() => parseProposedChangeSet(input)).toThrow(/controller|value/);
    const input2 = validRawChangeSet();
    input2.operations = [{
      type: "create_track",
      track: { name: "Bad2", channel: 0, program: 0, pitchBends: [{ tick: -1, value: 10000 }] },
    }];
    expect(() => parseProposedChangeSet(input2)).toThrow(/tick|value/);
  });

  it("rejects oversized track event arrays", () => {
    const input = validRawChangeSet();
    input.operations = [{
      type: "create_track",
      track: {
        name: "Fat",
        channel: 0,
        program: 0,
        controllerEvents: Array.from({ length: 4001 }, (_, i) => ({ tick: i, controller: 10, value: 64 })),
      },
    }];
    expect(() => parseProposedChangeSet(input)).toThrow(/4000/);
  });

  it("accepts note-level MIDI attributes on notes", () => {
    const input = validRawChangeSet();
    input.operations = [{
      type: "insert_notes",
      trackId: "track-1",
      notes: [{
        pitch: 60, startTick: 0, durationTicks: 480, velocity: 84,
        pan: -40, release: 1.2, cutoffHz: 2000, resonanceQ: 8, finePitchCents: -25, sustainBeats: 2,
      }],
    }];
    expect(parseProposedChangeSet(input)).toMatchObject({
      operations: [expect.objectContaining({ type: "insert_notes" })],
    });
  });

  it("rejects out-of-range note attributes", () => {
    const input = validRawChangeSet();
    input.operations = [{
      type: "insert_notes",
      trackId: "track-1",
      notes: [{ pitch: 60, startTick: 0, durationTicks: 480, velocity: 84, cutoffHz: 50000, sustainBeats: 99 }],
    }];
    expect(() => parseProposedChangeSet(input)).toThrow(/cutoffHz|sustainBeats/);
  });
});
