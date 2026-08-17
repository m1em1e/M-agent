import { describe, expect, it, vi } from "vitest";
import { withCachedLoader, type SkillLoader } from "../../../src/core/agent/skills/loader";
import type { SkillDefinition } from "../../../src/core/agent/skills/types";

function makeSource(): { loader: SkillLoader; loadCalls: string[] } {
  const loadCalls: string[] = [];
  const loader: SkillLoader = {
    list: async () => [
      { name: "song-arranger", description: "顶层编排" },
      { name: "harmony-arranger", description: "和声" },
    ],
    load: async (name) => {
      loadCalls.push(name);
      const skill: SkillDefinition | undefined =
        name === "song-arranger"
          ? { name: "song-arranger", description: "顶层编排", instructions: "top" }
          : name === "harmony-arranger"
            ? { name: "harmony-arranger", description: "和声", instructions: "harmony" }
            : undefined;
      return skill;
    },
  };
  return { loader, loadCalls };
}

describe("withCachedLoader", () => {
  it("list 直通；load 按需加载一次并缓存", async () => {
    const { loader, loadCalls } = makeSource();
    const cached = withCachedLoader(loader);

    const metas = await cached.list();
    expect(metas).toHaveLength(2);

    const first = await cached.load("song-arranger");
    const second = await cached.load("song-arranger");
    expect(first?.instructions).toBe("top");
    expect(second?.instructions).toBe("top");
    expect(loadCalls).toEqual(["song-arranger"]);

    const other = await cached.load("harmony-arranger");
    expect(other?.instructions).toBe("harmony");
    expect(loadCalls).toEqual(["song-arranger", "harmony-arranger"]);
  });

  it("缓存未命中不存在时也缓存 undefined，不重复读取", async () => {
    const { loader, loadCalls } = makeSource();
    const cached = withCachedLoader(loader);

    expect(await cached.load("missing")).toBeUndefined();
    expect(await cached.load("missing")).toBeUndefined();
    expect(loadCalls).toEqual(["missing"]);
  });

  it("缓存只覆盖本次运行，不跨 loader 共享", async () => {
    const a = makeSource();
    const b = makeSource();
    const cachedA = withCachedLoader(a.loader);
    const cachedB = withCachedLoader(b.loader);

    await cachedA.load("song-arranger");
    await cachedB.load("song-arranger");
    expect(a.loadCalls).toEqual(["song-arranger"]);
    expect(b.loadCalls).toEqual(["song-arranger"]);
  });

  it("list 不触发 load", async () => {
    const { loader, loadCalls } = makeSource();
    const cached = withCachedLoader(loader);
    await cached.list();
    await cached.list();
    expect(loadCalls).toEqual([]);
  });
});
