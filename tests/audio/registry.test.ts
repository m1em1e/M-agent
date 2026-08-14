import { describe, expect, it } from "vitest";
import { InstrumentRegistry } from "../../src/core/audio/registry";
import type { InstrumentReference } from "../../src/shared/instrument";

function registry(overrides: { presets?: number } = {}) {
  let counter = 0;
  return new InstrumentRegistry({
    scan: async (path) => {
      const name = path.split(/[\\/]/).pop() ?? "bank";
      if (path.endsWith(".sf2") || path.endsWith(".sf3")) {
        const presets = Array.from({ length: overrides.presets ?? 3 }, (_, index) => ({
          bank: 0,
          program: index,
          name: `Preset ${index}`,
        }));
        return { id: `scan-${counter++}`, name, type: "soundfont" as const, presets };
      }
      return { id: `scan-${counter++}`, name, type: "sfz" as const, presetName: name };
    },
  });
}

describe("InstrumentRegistry", () => {
  it("adds and lists entries with parsed metadata", async () => {
    const reg = registry();
    const sf = await reg.add("C:\\Banks\\Piano.sf2", "soundfont");
    expect(sf.name).toBe("Piano.sf2");
    expect(sf.presets).toHaveLength(3);
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0].presetCount).toBe(3);
  });

  it("parses sfz entries and lists them separately", async () => {
    const reg = registry();
    await reg.add("/banks/Piano.sfz", "sfz");
    const list = reg.list();
    expect(list[0].type).toBe("sfz");
    expect(list[0].presetName).toBe("Piano.sfz");
    expect(reg.search("soundfont")).toHaveLength(0);
  });

  it("carries parsed sfz regions on entries", async () => {
    const reg = new InstrumentRegistry({
      scan: async (path) => ({
        id: "scan-1",
        name: "Rhodes.sfz",
        type: "sfz" as const,
        presetName: "Rhodes",
        sfzRegions: [{ samplePath: "/banks/rhodes/r1.wav", lokey: 0, hikey: 127, lovel: 0, hivel: 127, keyCenter: 60, tuning: 0, volume: 0, pan: 0 }],
      }),
    });
    const entry = await reg.add("/banks/Rhodes.sfz", "sfz");
    expect(entry.sfzRegions).toHaveLength(1);
    expect(reg.list()[0].sfzRegions?.[0].samplePath).toBe("/banks/rhodes/r1.wav");
  });

  it("supports enable/disable and search", async () => {
    const reg = registry();
    await reg.add("/a.sf2", "soundfont");
    const b = await reg.add("/b.sf2", "soundfont");
    reg.update(b.id, { enabled: false });
    expect(reg.search(undefined, "b.sf2")[0].enabled).toBe(false);
    expect(reg.resolve({ type: "soundfont", libraryId: b.id, bank: 0, program: 0 })).toBeUndefined();
  });

  it("removes entries and resolves references", async () => {
    const reg = registry();
    const a = await reg.add("/a.sf2", "soundfont");
    const ref: InstrumentReference = { type: "soundfont", libraryId: a.id, bank: 0, program: 1 };
    expect(reg.resolve(ref)?.id).toBe(a.id);
    expect(reg.referenceKey(ref)).toContain("soundfont");
    reg.remove(a.id);
    expect(reg.resolve(ref)).toBeUndefined();
  });
});
