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
});
