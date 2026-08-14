import { describe, expect, it } from "vitest";
import { buildProjectInstruments, inferInstrumentTypeFromPath } from "../../src/shared/instrument";
import type { InstrumentReference } from "../../src/shared/instrument";

describe("inferInstrumentTypeFromPath", () => {
  it("识别 .sf2 / .sf3 为 soundfont", () => {
    expect(inferInstrumentTypeFromPath("C:\\Banks\\Piano.sf2")).toBe("soundfont");
    expect(inferInstrumentTypeFromPath("/banks/Orchestra.SF3")).toBe("soundfont");
  });

  it("识别 .sfz 为 sfz（不区分大小写）", () => {
    expect(inferInstrumentTypeFromPath("/samples/Rhodes.sfz")).toBe("sfz");
    expect(inferInstrumentTypeFromPath("C:\\sfz\\DRUMS.SFZ")).toBe("sfz");
  });

  it("未知扩展名返回 undefined", () => {
    expect(inferInstrumentTypeFromPath("/banks/piano.wav")).toBeUndefined();
    expect(inferInstrumentTypeFromPath("no-extension")).toBeUndefined();
    expect(inferInstrumentTypeFromPath("")).toBeUndefined();
  });
});

describe("buildProjectInstruments", () => {
  const systemEntry = {
    id: "lib-1",
    type: "soundfont" as const,
    path: "/system/Piano.sf2",
    name: "Piano.sf2",
    enabled: true,
    presetCount: 2,
    presets: [{ bank: 0, program: 0, name: "Grand Piano" }],
    sfzRegions: undefined,
    createdAt: 0,
    updatedAt: 0,
  };

  it("按轨道引用快照系统级条目并去重", () => {
    const tracks = [
      { instrument: { type: "soundfont", libraryId: "lib-1", bank: 0, program: 0 } as InstrumentReference },
      { instrument: { type: "soundfont", libraryId: "lib-1", bank: 0, program: 0 } as InstrumentReference },
      { instrument: undefined },
    ];
    const result = buildProjectInstruments(tracks, [systemEntry], []);
    expect(result).toHaveLength(1);
    expect(result![0]).toMatchObject({ id: "lib-1", path: "/system/Piano.sf2", presets: systemEntry.presets });
  });

  it("工程级条目优先，且保留完整快照", () => {
    const projectEntry = { id: "pinst-1", type: "sfz" as const, path: "/proj/Rhodes.sfz", sfzRegions: [] };
    const result = buildProjectInstruments([{ instrument: { type: "sfz", libraryId: "pinst-1" } }], [], [projectEntry]);
    expect(result![0]).toEqual(projectEntry);
  });

  it("无引用时返回 undefined", () => {
    expect(buildProjectInstruments([{ instrument: undefined }], [systemEntry], [])).toBeUndefined();
    expect(buildProjectInstruments([], [systemEntry], [])).toBeUndefined();
  });
});
