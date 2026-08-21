import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const currentDir = dirname(fileURLToPath(import.meta.url));
const promptPath = join(currentDir, "../../agent/context-prompt.md");

async function contextPrompt(): Promise<string> {
  return readFile(promptPath, "utf8");
}

describe("agent context prompt", () => {
  it("documents the project file format for the model", async () => {
    const prompt = await contextPrompt();
    for (const fragment of [
      "M Agent",
      "ppq",
      "tempoMap",
      "timeSignatures",
      "loopRegion",
      "tracks",
      "revisions",
      "agentSessions",
      "instruments",
      "volume",
      "instrument",
      "research",
      "plan",
      "goal",
      "insert_notes",
      "delete_notes",
      "update_notes",
      "create_track",
      "delete_track",
      "update_track",
      "set_tempo",
      "set_time_signature",
      "set_loop",
      "clear_loop",
      "propose_midi_changes",
      "500",
      "10,000",
      "3",
    ]) {
      expect(prompt).toContain(fragment);
    }
  });

  it("keeps the boundary language consistent with the kernel", async () => {
    const prompt = await contextPrompt();
    expect(prompt).toMatch(/永远不能直接改写工程/);
    expect(prompt).toMatch(/简体中文/);
    expect(prompt).toMatch(/禁止编造/);
  });

  it("documents instrument search and set-instrument capability", async () => {
    const prompt = await contextPrompt();
    expect(prompt).toMatch(/instrument_search/);
    expect(prompt).toMatch(/create_track/);
    expect(prompt).toMatch(/update_track/);
    expect(prompt).toMatch(/不得编造音色引用|不得编造/);
  });

  it("documents SFZ and SoundFont instrument reference formats", async () => {
    const prompt = await contextPrompt();
    expect(prompt).toMatch(/"type": "sfz"/);
    expect(prompt).toMatch(/"type": "soundfont"/);
    expect(prompt).toMatch(/无 bank\/program/);
  });
});
