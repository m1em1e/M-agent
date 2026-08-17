import { describe, expect, it, afterEach, beforeEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentLogSink, readAgentLogLines } from "../../src/main/agent-logger";

const originalEnv = process.env.VITE_DEV_SERVER_URL;

async function tempBase(): Promise<string> {
  return mkdtemp(join(tmpdir(), "magent-log-"));
}

describe("createAgentLogSink", () => {
  let base: string;

  beforeEach(async () => {
    base = await tempBase();
  });

  afterEach(async () => {
    process.env.VITE_DEV_SERVER_URL = originalEnv;
    await rm(base, { recursive: true, force: true });
  });

  it("非测试环境返回 no-op，不建目录不写文件", async () => {
    delete process.env.VITE_DEV_SERVER_URL;
    const sink = createAgentLogSink(base);
    sink({ type: "agent.request", requestId: "r1" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await readAgentLogLines(base)).toEqual([]);
  });

  it("测试环境写 JSON-lines 到 log/log-*.log，带 ts 与事件体", async () => {
    process.env.VITE_DEV_SERVER_URL = "http://127.0.0.1:5173";
    const sink = createAgentLogSink(base);
    sink({ type: "agent.request", requestId: "r1", objective: "分析" });
    sink({ type: "kernel.thinking", requestId: "r1", index: 0, durationMs: 12, text: "先检查" });
    await new Promise((resolve) => setTimeout(resolve, 30));

    const lines = await readAgentLogLines(base);
    expect(lines).toHaveLength(2);
    expect(lines[0].type).toBe("agent.request");
    expect(lines[0].requestId).toBe("r1");
    expect(typeof lines[0].ts).toBe("string");
    expect(new Date(lines[0].ts as string).getTime()).not.toBeNaN();
    expect(lines[1]).toMatchObject({ type: "kernel.thinking", index: 0, durationMs: 12 });
  });

  it("并发事件按调用顺序串行落盘", async () => {
    process.env.VITE_DEV_SERVER_URL = "http://127.0.0.1:5173";
    const sink = createAgentLogSink(base);
    for (let i = 0; i < 20; i += 1) sink({ type: "t", i });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lines = await readAgentLogLines(base);
    expect(lines.map((line) => line.i)).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });
});
