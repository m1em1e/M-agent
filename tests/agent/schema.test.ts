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
});
