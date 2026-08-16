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
