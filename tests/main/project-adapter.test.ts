import { describe, expect, it } from "vitest";
import { assertProjectFile, rendererPayloadToProject } from "../../src/main/project-adapter";

const rendererProject = {
  title: "Safe Loop",
  ppq: 480,
  tempo: 100,
  tracks: [{
    id: "melody",
    name: "Melody",
    role: "melody" as const,
    channel: 0,
    program: 1,
    muted: false,
    solo: false,
    notes: [{ id: "n1", pitch: 60, startTick: 0, durationTicks: 480, velocity: 90 }],
  }],
};

describe("main-process project payload boundary", () => {
  it("normalizes a structurally valid renderer project", () => {
    const project = rendererPayloadToProject(rendererProject);
    expect(project.title).toBe("Safe Loop");
    expect(project.tracks[0].notes[0].startTick).toBe(0);
  });

  it("preserves optional project metadata across the renderer boundary", () => {
    const project = rendererPayloadToProject({
      ...rendererProject,
      id: "project-stable",
      tempoMap: [{ tick: 0, bpm: 100 }, { tick: 960, bpm: 104 }],
      timeSignatures: [{ tick: 0, numerator: 3, denominator: 4 }],
      loopRegion: { startTick: 0, endTick: 1920 },
      revisions: [{ id: "r1", label: "Import", createdAt: "2026-08-13T00:00:00Z", source: "import" }],
      agentSessions: [{
        id: "s1",
        mode: "goal",
        createdAt: "2026-08-13T00:00:00Z",
        prompt: "收束结尾",
        acceptedChangeSetIds: ["c1"],
      }],
    });
    expect(project).toMatchObject({
      id: "project-stable",
      tempoMap: [{ tick: 0, bpm: 100 }, { tick: 960, bpm: 104 }],
      timeSignatures: [{ tick: 0, numerator: 3, denominator: 4 }],
      loopRegion: { startTick: 0, endTick: 1920 },
    });
    expect(project.agentSessions[0].acceptedChangeSetIds).toEqual(["c1"]);
  });

  it("rejects fractional MIDI ticks before save, export, or agent use", () => {
    expect(() => rendererPayloadToProject({
      ...rendererProject,
      tracks: [{
        ...rendererProject.tracks[0],
        notes: [{ ...rendererProject.tracks[0].notes[0], durationTicks: 364.8 }],
      }],
    })).toThrow(/durationTicks must be an integer/);
  });

  it("rejects malformed project files without leaking a TypeError", () => {
    expect(() => assertProjectFile({ ppq: 480, tracks: [{}] })).toThrow(/工程文件/);
  });

  it("preserves track volume and instrument references", () => {
    const project = rendererPayloadToProject({
      ...rendererProject,
      tracks: [{
        ...rendererProject.tracks[0],
        volume: 0.6,
        instrument: { type: "soundfont", libraryId: "lib-1", bank: 0, program: 12 },
      }],
    });
    expect(project.tracks[0].volume).toBe(0.6);
    expect(project.tracks[0].instrument).toEqual({ type: "soundfont", libraryId: "lib-1", bank: 0, program: 12 });
  });

  it("rejects invalid track instrument references", () => {
    expect(() => rendererPayloadToProject({
      ...rendererProject,
      tracks: [{
        ...rendererProject.tracks[0],
        instrument: { type: "soundfont", libraryId: 5, bank: "x", program: 0 } as unknown as { type: "soundfont"; libraryId: string; bank: number; program: number },
      }],
    })).toThrow(/音源引用无效/);
    expect(() => rendererPayloadToProject({
      ...rendererProject,
      tracks: [{ ...rendererProject.tracks[0], volume: "loud" } as unknown as typeof rendererProject.tracks[0]],
    })).toThrow(/音量无效/);
  });

  it("rejects malformed nested project metadata", () => {
    const normalized = rendererPayloadToProject(rendererProject);
    expect(() => assertProjectFile({ ...normalized, tempoMap: [null] })).toThrow(/速度图/);
    expect(() => assertProjectFile({ ...normalized, agentSessions: [null] })).toThrow(/Agent 会话/);
  });
});
