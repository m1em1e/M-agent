import { describe, expect, it } from "vitest";
import { recentProjectLabel } from "../../src/shared/menu";

describe("recentProjectLabel", () => {
  it("uses a real title when present", () => {
    expect(recentProjectLabel({ path: "/a/b/jrpg.magent", title: "JRPG Battle" })).toBe("JRPG Battle");
  });

  it("falls back to filename when title is empty or Untitled", () => {
    expect(recentProjectLabel({ path: "C:\\x\\test.magent", title: "" })).toBe("test.magent");
    expect(recentProjectLabel({ path: "C:\\x\\test.magent", title: "Untitled" })).toBe("test.magent");
    expect(recentProjectLabel({ path: "/a/b/music.magent", title: "  " })).toBe("music.magent");
  });

  it("uses the raw path when no basename is derivable", () => {
    expect(recentProjectLabel({ path: "/", title: "" })).toBe("/");
  });
});
