import { describe, expect, it } from "vitest";
import { parseSfzText, selectSfzRegions } from "../../src/core/audio/sfz-parser";

describe("parseSfzText", () => {
  it("解析基础 region 并给出默认值", () => {
    const { regions } = parseSfzText(`<region> sample=piano_a3.wav`);
    expect(regions).toHaveLength(1);
    expect(regions[0]).toMatchObject({
      samplePath: "piano_a3.wav",
      lokey: 0,
      hikey: 127,
      lovel: 0,
      hivel: 127,
      keyCenter: 60,
      tuning: 0,
      volume: 0,
      pan: 0,
    });
    expect(regions[0].loopMode).toBeUndefined();
  });

  it("跳过注释与空行", () => {
    const { regions } = parseSfzText(`
      // 这是注释
      <region>
      sample=a.wav

      // 另一个 region
      <region>
      sample=b.wav
    `);
    expect(regions.map((region) => region.samplePath)).toEqual(["a.wav", "b.wav"]);
  });

  it("缺失 sample 的 region 被忽略", () => {
    const { regions } = parseSfzText(`<region> lokey=60`);
    expect(regions).toHaveLength(0);
  });

  it("支持键区与力度区 opcode", () => {
    const { regions } = parseSfzText(`<region> sample=a.wav lokey=60 hikey=72 lovel=32 hivel=100`);
    expect(regions[0]).toMatchObject({ lokey: 60, hikey: 72, lovel: 32, hivel: 100 });
  });

  it("key opcode 同时设置 lokey/hikey/keyCenter", () => {
    const { regions } = parseSfzText(`<region> sample=a.wav key=62`);
    expect(regions[0]).toMatchObject({ lokey: 62, hikey: 62, keyCenter: 62 });
  });

  it("显式给出的 lokey/hikey 优先于 key", () => {
    const { regions } = parseSfzText(`<region> sample=a.wav key=62 lokey=50 hikey=70`);
    expect(regions[0]).toMatchObject({ lokey: 50, hikey: 70, keyCenter: 62 });
  });

  it("tuning/volume/pan 与包络 opcode", () => {
    const { regions } = parseSfzText(`<region> sample=a.wav tuning=-12 volume=-6 pan=50 amp_env_attack=0.01 amp_env_release=0.5`);
    expect(regions[0]).toMatchObject({ tuning: -12, volume: -6, pan: 50, attack: 0.01, release: 0.5 });
  });

  it("pan 超出范围时收敛到 -100..100", () => {
    const { regions } = parseSfzText(`<region> sample=a.wav pan=999`);
    expect(regions[0].pan).toBe(100);
  });

  it("循环 opcode 映射", () => {
    const { regions } = parseSfzText(`<region> sample=a.wav loop_mode=loop_continuous loop_start=1000 loop_end=20000`);
    expect(regions[0].loopMode).toBe("continuous");
    expect(regions[0].loopStart).toBe(1000);
    expect(regions[0].loopEnd).toBe(20000);
  });

  it("no_loop 与 one_shot 循环模式", () => {
    const noLoop = parseSfzText(`<region> sample=a.wav loop_mode=no_loop`).regions;
    expect(noLoop[0].loopMode).toBeUndefined();
    const oneShot = parseSfzText(`<region> sample=a.wav loop_mode=one_shot`).regions;
    expect(oneShot[0].loopMode).toBe("one_shot");
  });

  it("global/group 继承到后续 region", () => {
    const { regions } = parseSfzText(`
      <global> volume=-3
      <group> lokey=40 hikey=60
      <region> sample=a.wav
      <group> lokey=61 hikey=80
      <region> sample=b.wav
    `);
    expect(regions).toHaveLength(2);
    expect(regions[0]).toMatchObject({ samplePath: "a.wav", lokey: 40, hikey: 60, volume: -3 });
    expect(regions[1]).toMatchObject({ samplePath: "b.wav", lokey: 61, hikey: 80, volume: -3 });
  });

  it("解析 control 段的 default_path", () => {
    const { defaultPath } = parseSfzText(`<control> default_path=samples/`);
    expect(defaultPath).toBe("samples/");
  });

  it("解析 ampeg_* 别名包络与 amp_veltrack（ARIA 风格，Salamander 钢琴）", () => {
    const { regions } = parseSfzText(`<group> amp_veltrack=73 ampeg_release=1
      <region> sample=a.wav pitch_keycenter=60`);
    expect(regions[0]).toMatchObject({ ampVelTrack: 73, release: 1 });
  });

  it("解析完整 ADSR 与 hold（amp_env_* 与 ampeg_* 两前缀）", () => {
    const env = parseSfzText(`<region> sample=a.wav amp_env_attack=0.01 amp_env_decay=0.2 amp_env_sustain=70 amp_env_release=0.5 amp_env_hold=0.1`).regions[0];
    expect(env).toMatchObject({ attack: 0.01, decay: 0.2, sustain: 70, release: 0.5, hold: 0.1 });
    const aria = parseSfzText(`<region> sample=a.wav ampeg_attack=0.02 ampeg_decay=0.3 ampeg_sustain=60 ampeg_release=0.8`).regions[0];
    expect(aria).toMatchObject({ attack: 0.02, decay: 0.3, sustain: 60, release: 0.8 });
  });

  it("sustain 与 amp_veltrack 收敛到 0..100", () => {
    const { regions } = parseSfzText(`<region> sample=a.wav ampeg_sustain=200 amp_veltrack=-5`);
    expect(regions[0].sustain).toBe(100);
    expect(regions[0].ampVelTrack).toBe(0);
  });

  it("解析采样 offset 与 end 截取", () => {
    const { regions } = parseSfzText(`<region> sample=a.wav offset=44100 end=88200`);
    expect(regions[0].offset).toBe(44100);
    expect(regions[0].end).toBe(88200);
    const absent = parseSfzText(`<region> sample=a.wav`).regions[0];
    expect(absent.offset).toBeUndefined();
    expect(absent.end).toBeUndefined();
  });

  it("未给出的包络字段保持 undefined，缺省 sustain/ampVelTrack 不设", () => {
    const { regions } = parseSfzText(`<region> sample=a.wav`);
    expect(regions[0].attack).toBeUndefined();
    expect(regions[0].decay).toBeUndefined();
    expect(regions[0].sustain).toBeUndefined();
    expect(regions[0].release).toBeUndefined();
    expect(regions[0].ampVelTrack).toBeUndefined();
  });

  it("global/group 继承新的包络与力度字段", () => {
    const { regions } = parseSfzText(`
      <global> ampeg_release=0.8
      <group> amp_veltrack=50
      <region> sample=a.wav
    `);
    expect(regions[0]).toMatchObject({ release: 0.8, ampVelTrack: 50 });
  });

  it("支持带引号的 sample 路径", () => {
    const { regions } = parseSfzText(`<region> sample="my samples/piano A.wav"`);
    expect(regions[0].samplePath).toBe("my samples/piano A.wav");
  });
});

describe("selectSfzRegions", () => {
  const regions = parseSfzText(`
    <region> sample=a.wav key=60
    <region> sample=b.wav key=64
    <region> sample=c.wav key=60 lovel=100 hivel=127
  `).regions;

  it("命中键区，未命中力度高层的区域被过滤", () => {
    const matched = selectSfzRegions(regions, 60, 64);
    expect(matched.map((region) => region.samplePath)).toEqual(["a.wav"]);
  });

  it("高力度命中多个力度层（分层叠加）", () => {
    const matched = selectSfzRegions(regions, 60, 110);
    expect(matched.map((region) => region.samplePath)).toEqual(["a.wav", "c.wav"]);
  });

  it("键区外返回空", () => {
    expect(selectSfzRegions(regions, 80, 64)).toHaveLength(0);
  });
});
