import { describe, expect, it } from "vitest";
import { exportMidi, importMidi, MidiFileError } from "../../src/core/midi";
import type { MidiProject } from "../../src/shared/midi";

function projectFixture(): MidiProject {
  return {
    id: "fixture",
    title: "Round Trip",
    ppq: 480,
    tempoMap: [{ tick: 0, bpm: 120 }, { tick: 960, bpm: 90 }],
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }, { tick: 1920, numerator: 3, denominator: 4 }],
    loopRegion: { startTick: 0, endTick: 3840 },
    tracks: [
      {
        id: "melody",
        name: "Lead 旋律",
        role: "melody",
        channel: 0,
        program: 80,
        muted: false,
        solo: false,
        notes: [
          { id: "n1", pitch: 60, startTick: 0, durationTicks: 480, velocity: 100 },
          { id: "n2", pitch: 64, startTick: 480, durationTicks: 960, velocity: 90 },
        ],
      },
      {
        id: "drums",
        name: "Drums",
        role: "drums",
        channel: 9,
        program: 0,
        muted: false,
        solo: false,
        notes: [{ id: "kick", pitch: 36, startTick: 0, durationTicks: 120, velocity: 110 }],
      },
    ],
    revisions: [],
    agentSessions: [],
  };
}

function musicalSnapshot(project: MidiProject) {
  return {
    ppq: project.ppq,
    tempoMap: project.tempoMap.map((event) => ({ tick: event.tick, bpm: Math.round(event.bpm * 1000) / 1000 })),
    timeSignatures: project.timeSignatures,
    tracks: project.tracks.map((track) => ({
      name: track.name,
      channel: track.channel,
      program: track.program,
      notes: track.notes.map(({ pitch, startTick, durationTicks, velocity }) => ({ pitch, startTick, durationTicks, velocity })),
    })),
  };
}

describe("Standard MIDI File Type 1", () => {
  it("preserves supported musical semantics in an export/import round trip", () => {
    const source = projectFixture();
    const encoded = exportMidi(source, { format: 1 });
    expect(new TextDecoder().decode(encoded.subarray(0, 4))).toBe("MThd");
    const imported = importMidi(encoded, { title: "Imported" });
    expect(imported.format).toBe(1);
    expect(imported.warnings).toEqual([]);
    expect(musicalSnapshot(imported.project)).toEqual(musicalSnapshot(source));
  });

  it("writes bank select for soundfont instrument tracks and keeps program on round trip", () => {
    const source = projectFixture();
    source.tracks[0].instrument = { type: "soundfont", libraryId: "lib", bank: 0x2003, program: 12 };
    source.tracks[0].program = 12;
    const encoded = exportMidi(source, { format: 1 });
    const bytes = Array.from(encoded);
    const hasSequence = (pattern: number[]) => bytes.some((_, index) => pattern.every((value, offset) => bytes[index + offset] === value));
    expect(hasSequence([0xb0, 0x00, 0x40])).toBe(true); // CC0 = bankMSB(64)
    expect(hasSequence([0xb0, 0x20, 0x03])).toBe(true); // CC32 = bankLSB(3)
    expect(hasSequence([0xc0, 0x0c])).toBe(true); // program 12
    const imported = importMidi(encoded, { title: "Imported" });
    expect(imported.project.tracks[0].program).toBe(12);
    expect(musicalSnapshot(imported.project)).toEqual(musicalSnapshot(source));
  });

  it("omits bank select for tracks without a soundfont instrument", () => {
    const source = projectFixture();
    const encoded = exportMidi(source, { format: 1 });
    expect(Array.from(encoded)).not.toContain(0xb0);
  });
});

describe("Standard MIDI File Type 0", () => {
  it("exports one track and splits its MIDI channels into project tracks on import", () => {
    const source = projectFixture();
    const encoded = exportMidi(source, { format: 0 });
    expect(Array.from(encoded.subarray(8, 12))).toEqual([0, 0, 0, 1]);
    const imported = importMidi(encoded);
    expect(imported.format).toBe(0);
    expect(imported.project.tracks.map((track) => track.channel)).toEqual([0, 9]);
    expect(imported.project.tracks.flatMap((track) => track.notes)).toHaveLength(3);
    expect(imported.project.tempoMap.map((event) => event.tick)).toEqual([0, 960]);
  });

  it("rejects conflicting programs on the same channel", () => {
    const source = projectFixture();
    source.tracks.push({ ...source.tracks[0], id: "other", name: "Other", program: 40, notes: [] });
    expect(() => exportMidi(source, { format: 0 })).toThrow(MidiFileError);
  });
});

describe("MIDI parser safety", () => {
  it("rejects truncated and SMPTE-timed input", () => {
    expect(() => importMidi(Uint8Array.of(0x4d, 0x54, 0x68))).toThrow(MidiFileError);
    const smpte = Uint8Array.of(
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6,
      0, 0, 0, 1, 0xe7, 0x28,
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 4, 0, 0xff, 0x2f, 0,
    );
    expect(() => importMidi(smpte)).toThrow(/SMPTE/);
  });
});

describe("CC 事件往返（含 CC64 延音踏板）", () => {
  it("导出写 0xb0、导入还原 controllerEvents", () => {
    const source = projectFixture();
    source.tracks[0].controllerEvents = [
      { id: "c1", tick: 480, controller: 64, value: 127 },
      { id: "c2", tick: 1440, controller: 64, value: 0 },
    ];
    const encoded = exportMidi(source, { format: 1 });
    const result = importMidi(encoded, { title: "rt" });
    const melody = result.project.tracks.find((track) => track.channel === 0);
    expect(melody?.controllerEvents).toEqual([
      expect.objectContaining({ tick: 480, controller: 64, value: 127 }),
      expect.objectContaining({ tick: 1440, controller: 64, value: 0 }),
    ]);
  });
});

describe("弯音事件往返（0xE0）", () => {
  it("导出写 0xE0、导入还原 pitchBends", () => {
    const source = projectFixture();
    source.tracks[0].pitchBends = [
      { id: "p1", tick: 240, value: 0 },
      { id: "p2", tick: 480, value: 4096 },
      { id: "p3", tick: 960, value: -8192 },
      { id: "p4", tick: 1200, value: -1 },
    ];
    const encoded = exportMidi(source, { format: 1 });
    const result = importMidi(encoded, { title: "pb" });
    const melody = result.project.tracks.find((track) => track.channel === 0);
    expect(melody?.pitchBends).toEqual([
      expect.objectContaining({ tick: 240, value: 0 }),
      expect.objectContaining({ tick: 480, value: 4096 }),
      expect.objectContaining({ tick: 960, value: -8192 }),
      expect.objectContaining({ tick: 1200, value: -1 }),
    ]);
  });

  it("低层 0xE0 字节按 14bit 还原弯音值（data1=LSB、data2=MSB，-8192..8191）", () => {
    const data = Uint8Array.of(
      0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, 0x01, 0x80,
      0x4d, 0x54, 0x72, 0x6b, 0, 0, 0, 24,
      0, 0xe0, 0x7f, 0x00,
      0, 0xe0, 0x00, 0x40,
      0, 0xe0, 0x00, 0x60,
      0, 0x90, 0x3c, 0x64,
      96, 0x80, 0x3c, 0x00,
      0, 0xff, 0x2f, 0x00,
    );
    const result = importMidi(data, { title: "pb-bytes" });
    const track = result.project.tracks[0];
    expect(track.pitchBends).toEqual([
      expect.objectContaining({ tick: 0, value: 127 - 8192 }),
      expect.objectContaining({ tick: 0, value: 0 }),
      expect.objectContaining({ tick: 0, value: 4096 }),
    ]);
  });
});

describe("音符级 MIDI 属性导出（近似 CC/弯音事件）", () => {
  it("导出写 CC10/71/74/72、0xE0 弯音与 CC64 延音对", () => {
    const source = projectFixture();
    const note = source.tracks[0].notes[0];
    note.pan = 40;
    note.cutoffHz = 2000;
    note.resonanceQ = 8;
    note.release = 1;
    note.finePitchCents = 50;
    note.sustainBeats = 2;
    note.durationTicks = 480;
    const encoded = exportMidi(source, { format: 1 });
    const result = importMidi(encoded, { title: "attrs" });
    const melody = result.project.tracks.find((track) => track.channel === 0);
    const ccAt = (controller: number): number[] => (melody?.controllerEvents ?? [])
      .filter((event) => event.controller === controller)
      .map((event) => event.value);
    const ccTicks = (controller: number): number[] => (melody?.controllerEvents ?? [])
      .filter((event) => event.controller === controller)
      .map((event) => event.tick);
    // pan 40 → (40+100)/2 = 70；cutoff 2000 → log 映射 ≈ 64；resonance 8 → 62；release 1 → 64。
    expect(ccAt(10)).toEqual([70]);
    expect(ccAt(74)[0]).toBeGreaterThanOrEqual(60);
    expect(ccAt(74)[0]).toBeLessThanOrEqual(68);
    expect(ccAt(71)).toEqual([62]);
    expect(ccAt(72)).toEqual([64]);
    // 延音 2 拍（ppq 480）：踩 @0、松 @480+960=1440。
    expect(ccTicks(64)).toEqual([0, 1440]);
    expect(ccAt(64)).toEqual([127, 0]);
    // finePitch +50 音分 → bend = 2048。
    expect(melody?.pitchBends).toEqual([
      expect.objectContaining({ tick: 0, value: 2048 }),
    ]);
  });

  it("默认属性不写出任何近似事件", () => {
    const source = projectFixture();
    const encoded = exportMidi(source, { format: 1 });
    const result = importMidi(encoded, { title: "defaults" });
    const melody = result.project.tracks.find((track) => track.channel === 0);
    expect(melody?.controllerEvents ?? []).toEqual([]);
    expect(melody?.pitchBends ?? []).toEqual([]);
  });
});
