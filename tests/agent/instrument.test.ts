import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { applyChangeSet, validateChangeSet } from "../../src/core/midi";
import { createMidiProject, createMidiTrack } from "../../src/core/midi";
import { runPiKernel } from "../../src/core/agent/pi-kernel";
import type { InstrumentLibrarySummary } from "../../src/shared/instrument";

const systemInstruments: InstrumentLibrarySummary[] = [{
  id: "lib-1",
  type: "soundfont",
  path: "/banks/Piano.sf2",
  name: "Piano.sf2",
  enabled: true,
  presetCount: 1,
  presets: [{ bank: 0, program: 1, name: "Grand Piano" }],
  createdAt: 0,
  updatedAt: 0,
}];

function project() {
  const value = createMidiProject({ id: "p1", title: "Loop", ppq: 480, bpm: 100 });
  value.tracks.push(createMidiTrack({
    id: "melody",
    name: "Melody",
    role: "melody",
    channel: 0,
    program: 1,
    notes: [{ id: "n1", pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 }],
  }));
  return value;
}

describe("Agent 音色切换", () => {
  it("instrument_search + set_track_instrument 产出 update_track 候选", async () => {
    const result = await runPiKernel({
      requestId: "inst-1",
      mode: "goal",
      objective: "把主旋律换成钢琴",
      project: project(),
      instruments: systemInstruments,
      offlineScript: (faux) => faux.setResponses([
        fauxAssistantMessage(
          [
            fauxToolCall("instrument_search", { query: "piano" }),
            fauxToolCall("set_track_instrument", { trackId: "melody", instrument: { type: "soundfont", libraryId: "lib-1", bank: 0, program: 1 }, summary: "换成钢琴" }),
          ],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(fauxText("已把主旋律换成钢琴。")),
      ]),
    });
    expect(result.events.some((event) => event.type === "tool_start" && event.name === "instrument_search")).toBe(true);
    expect(result.events.some((event) => event.type === "tool_start" && event.name === "set_track_instrument")).toBe(true);
    expect(result.candidates).toHaveLength(1);
    const operation = result.candidates[0].operations[0] as { type: string; changes?: { instrument?: unknown } };
    expect(operation.type).toBe("update_track");
    expect(operation.changes?.instrument).toEqual({ type: "soundfont", libraryId: "lib-1", bank: 0, program: 1 });
  });

  it("research 下 instrument_search 可用，set_track_instrument 被权限拦截", async () => {
    const result = await runPiKernel({
      requestId: "inst-2",
      mode: "research",
      objective: "调研",
      project: project(),
      instruments: systemInstruments,
      offlineScript: (faux) => faux.setResponses([
        fauxAssistantMessage(
          [fauxToolCall("set_track_instrument", { trackId: "melody", instrument: null })],
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage(fauxText("只读调研。")),
      ]),
    });
    const blocked = result.events.find((event) => event.type === "tool_end" && event.name === "set_track_instrument");
    expect(blocked?.isError).toBe(true);
    expect(result.candidates).toEqual([]);
  });
});

describe("update_track 领域应用（音色）", () => {
  it("validateChangeSet 接受音色引用，applyChangeSet 写入 track.instrument", () => {
    const input = project();
    const changeSet = {
      id: "c1",
      summary: "换钢琴",
      operations: [{ type: "update_track" as const, trackId: "melody", changes: { instrument: { type: "soundfont" as const, libraryId: "lib-1", bank: 0, program: 1 } } }],
      validation: [],
      estimatedAffectedNotes: 0,
    };
    expect(validateChangeSet(input, changeSet).valid).toBe(true);
    const { project: next } = applyChangeSet(input, changeSet);
    expect(next.tracks[0].instrument).toEqual({ type: "soundfont", libraryId: "lib-1", bank: 0, program: 1 });
  });

  it("instrument: null 清除音色", () => {
    const input = project();
    input.tracks[0].instrument = { type: "soundfont", libraryId: "lib-1", bank: 0, program: 1 };
    const changeSet = {
      id: "c2",
      summary: "清除音色",
      operations: [{ type: "update_track" as const, trackId: "melody", changes: { instrument: null } }],
      validation: [],
      estimatedAffectedNotes: 0,
    };
    expect(validateChangeSet(input, changeSet).valid).toBe(true);
    const { project: next } = applyChangeSet(input, changeSet);
    expect(next.tracks[0].instrument).toBeUndefined();
  });
});
