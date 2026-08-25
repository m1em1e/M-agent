import { describe, expect, it } from "vitest";
import {
  nextKeyswitchState,
  parseSfzText,
  pickSfzRegions,
  pickSfzRegionsWithGain,
  sampleVelCurve,
  selectSfzRegions,
} from "../../src/core/audio/sfz-parser";

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

  it("tune/pitch 作为 tuning 的别名（Salamander Retuned 风格）", () => {
    expect(parseSfzText(`<region> sample=a.wav tune=10`).regions[0].tuning).toBe(10);
    expect(parseSfzText(`<region> sample=a.wav pitch=-5`).regions[0].tuning).toBe(-5);
    expect(parseSfzText(`<region> sample=a.wav tuning=3`).regions[0].tuning).toBe(3);
  });

  it("解析 delay / pitch_keytrack / pitch_offset", () => {
    const { regions } = parseSfzText(`<region> sample=a.wav delay=0.02 pitch_keytrack=50 pitch_offset=12`);
    expect(regions[0].delay).toBe(0.02);
    expect(regions[0].keytrack).toBe(50);
    expect(regions[0].pitchOffset).toBe(12);
    const ariaDelay = parseSfzText(`<region> sample=a.wav ampeg_delay=0.05`).regions[0];
    expect(ariaDelay.delay).toBe(0.05);
  });

  it("解析滤波器 opcode（fil_type/cutoff/resonance → Q）", () => {
    const lp = parseSfzText(`<region> sample=a.wav fil_type=lpf_hp cutoff=2000 resonance=10`).regions[0];
    expect(lp.filterType).toBe("lowpass");
    expect(lp.cutoffHz).toBe(2000);
    expect(lp.resonanceQ).toBeCloseTo(0.5 + (10 / 40) * 19.5, 5);
    const bp = parseSfzText(`<region> sample=a.wav fil_type=bandpass cutoff=800`).regions[0];
    expect(bp.filterType).toBe("bandpass");
    const unknown = parseSfzText(`<region> sample=a.wav fil_type=foobar`).regions[0];
    expect(unknown.filterType).toBeUndefined();
  });

  it("解析分组行为 opcode（seq/random/trigger）", () => {
    const { regions } = parseSfzText(`
      <group> seq_length=2
      <region> sample=a.wav seq_position=1
      <region> sample=b.wav seq_position=2 random=40 trigger=release
    `);
    expect(regions[0]).toMatchObject({ seqLength: 2, seqPosition: 1 });
    expect(regions[1]).toMatchObject({ seqLength: 2, seqPosition: 2, randomChance: 40, trigger: "release" });
  });

  it("解析 keyswitch（sw_lokey/sw_hikey/sw_default）", () => {
    const { regions } = parseSfzText(`
      <region> sample=a.wav sw_lokey=60 sw_hikey=60
      <region> sample=b.wav sw_lokey=72 sw_hikey=72 sw_default=1
    `);
    expect(regions[0]).toMatchObject({ swLokey: 60, swHikey: 60 });
    expect(regions[1]).toMatchObject({ swLokey: 72, swHikey: 72, swDefault: 1 });
  });

  it("解析 include 指令", () => {
    const parsed = parseSfzText(`
      <include>sub/piano.sfz</include>
      <include>drums.sfz</include>
      <region> sample=a.wav
    `);
    expect(parsed.includes).toEqual(["sub/piano.sfz", "drums.sfz"]);
    expect(parsed.regions).toHaveLength(1);
  });

  it("解析 LFO 与 pitch 包络 opcode", () => {
    const { regions } = parseSfzText(`
      <region> sample=a.wav pitch_lfo_freq=5 pitch_lfo_depth=10 pan_lfo_freq=3 pan_lfo_depth=20 amp_lfo_freq=6 amp_lfo_depth=15 pitch_env_depth=50 pitch_env_attack=0.1 pitch_env_decay=0.3 pitch_env_sustain=40
    `);
    expect(regions[0]).toMatchObject({
      pitchLfoFreq: 5, pitchLfoDepth: 10, panLfoFreq: 3, panLfoDepth: 20,
      ampLfoFreq: 6, ampLfoDepth: 15, pitchEnvDepth: 50, pitchEnvAttack: 0.1,
      pitchEnvDecay: 0.3, pitchEnvSustain: 40,
    });
  });

  it("解析交叉淡化（xfin/xfout 键与力度）", () => {
    const { regions } = parseSfzText(`
      <region> sample=a.wav lokey=40 hikey=60 xfin_lokey=36 xfout_hikey=64 xfin_lovel=10 xfout_hivel=120
    `);
    expect(regions[0]).toMatchObject({
      xfinLokey: 36, xfoutHikey: 64, xfinLovel: 10, xfoutHivel: 120,
    });
  });

  it("解析滤波包络（fil_env）与力度曲线（amp_velcurve）", () => {
    const { regions } = parseSfzText(`
      <region> sample=a.wav fil_env_depth=400 fil_env_attack=0.1 fil_env_decay=0.2 fil_env_sustain=50 amp_velcurve_30=0.2 amp_velcurve_100=0.9
    `);
    expect(regions[0]).toMatchObject({ filEnvDepth: 400, filEnvAttack: 0.1, filEnvDecay: 0.2, filEnvSustain: 50 });
    expect(regions[0].velCurve).toEqual({ 30: 0.2, 100: 0.9 });
  });

  it("解析 release_time、veltrack 变体与 LFO delay", () => {
    const { regions } = parseSfzText(`
      <region> sample=a.wav release_time=0.05 pitch_veltrack=20 cutoff_veltrack=300 pan_veltrack=40 pitch_lfo_delay=0.1 pan_lfo_delay=0.2 amp_lfo_delay=0.3
    `);
    expect(regions[0]).toMatchObject({
      releaseTime: 0.05, pitchVelTrack: 20, cutoffVelTrack: 300, panVelTrack: 40,
      pitchLfoDelay: 0.1, panLfoDelay: 0.2, ampLfoDelay: 0.3,
    });
  });

  it("解析 keyswitch sw_last/sw_previous 与 LFO 波形/相位", () => {
    const { regions } = parseSfzText(`
      <region> sample=a.wav sw_lokey=60 sw_hikey=60 sw_last=0 sw_previous=1 pitch_lfo_shape=triangle pitch_lfo_phase=180 pan_lfo_shape=square amp_lfo_shape=sawtooth amp_lfo_phase=90
    `);
    expect(regions[0]).toMatchObject({
      swLast: 0, swPrevious: 1,
      pitchLfoShape: "triangle", pitchLfoPhase: 180,
      panLfoShape: "square", ampLfoShape: "sawtooth", ampLfoPhase: 90,
    });
  });
});

describe("pickSfzRegions", () => {
  const regions = parseSfzText(`
    <group> seq_length=2
    <region> sample=a.wav key=60 seq_position=1
    <region> sample=b.wav key=60 seq_position=2
    <region> sample=r.wav key=60 trigger=release
  `).regions;

  it("attack 触发时排除 release 区域", () => {
    const matched = pickSfzRegions(regions, 60, 90, "attack");
    expect(matched.some((region) => region.samplePath === "r.wav")).toBe(false);
    expect(matched.length).toBeGreaterThan(0);
  });

  it("release 触发时只选 release 区域", () => {
    const matched = pickSfzRegions(regions, 60, 90, "release");
    expect(matched.map((region) => region.samplePath)).toEqual(["r.wav"]);
  });

  it("legato 触发时选 legato 区域，非连奏时选 attack/first", () => {
    const legatoRegions = parseSfzText(`
      <region> sample=attack.wav key=60
      <region> sample=legato.wav key=60 trigger=legato
      <region> sample=first.wav key=60 trigger=first
    `).regions;
    const nonLegato = pickSfzRegions(legatoRegions, 60, 90, "attack", undefined, Math.random, undefined, false);
    expect(nonLegato.map((region) => region.samplePath)).toEqual(["attack.wav", "first.wav"]);
    const inLegato = pickSfzRegions(legatoRegions, 60, 90, "attack", undefined, Math.random, undefined, true);
    expect(inLegato.map((region) => region.samplePath)).toEqual(["legato.wav"]);
  });

  it("seq 轮换按触发计数选择对应位置", () => {
    const state = { seqCounts: new Map<number, number>() };
    const first = pickSfzRegions(regions, 60, 90, "attack", state);
    expect(first.map((region) => region.samplePath)).toEqual(["a.wav"]);
    const second = pickSfzRegions(regions, 60, 90, "attack", state);
    expect(second.map((region) => region.samplePath)).toEqual(["b.wav"]);
    const third = pickSfzRegions(regions, 60, 90, "attack", state);
    expect(third.map((region) => region.samplePath)).toEqual(["a.wav"]);
  });

  it("random 按权重保留；全部滤掉时回退全部", () => {
    const withRandom = parseSfzText(`
      <region> sample=x.wav key=60 random=0
      <region> sample=y.wav key=60 random=0
    `).regions;
    // random() 恒返回 0.5 → 0.5*100=50，random=0 不保留 → 全部滤掉回退。
    expect(pickSfzRegions(withRandom, 60, 90, "attack", undefined, () => 0.5).length).toBe(2);
    // random() 恒返回 0.9 → 保留 random>90 的（无）→ 回退。
    expect(pickSfzRegions(withRandom, 60, 90, "attack", undefined, () => 0.95).length).toBe(2);
  });

  it("keyswitch：激活键选中对应区域、普通区域始终可选", () => {
    const { regions } = parseSfzText(`
      <region> sample=a.wav key=60 sw_lokey=72 sw_hikey=72
      <region> sample=b.wav key=60 sw_lokey=60 sw_hikey=60
      <region> sample=c.wav key=60
    `);
    const withKey = pickSfzRegions(regions, 60, 90, "attack", undefined, Math.random, 72);
    expect(withKey.map((region) => region.samplePath)).toEqual(["a.wav", "c.wav"]);
    const otherKey = pickSfzRegions(regions, 60, 90, "attack", undefined, Math.random, 60);
    expect(otherKey.map((region) => region.samplePath)).toEqual(["b.wav", "c.wav"]);
  });

  it("keyswitch：无激活键时只选 sw_default 区域与普通区域", () => {
    const { regions } = parseSfzText(`
      <region> sample=a.wav key=60 sw_lokey=72 sw_hikey=72
      <region> sample=b.wav key=60 sw_lokey=60 sw_hikey=60 sw_default=1
      <region> sample=c.wav key=60
    `);
    const matched = pickSfzRegions(regions, 60, 90, "attack");
    expect(matched.map((region) => region.samplePath)).toEqual(["b.wav", "c.wav"]);
  });
});

describe("pickSfzRegionsWithGain / crossfade", () => {
  const { regions } = parseSfzText(`
    <region> sample=a.wav lokey=40 hikey=60 xfin_lokey=36 xfout_hikey=64
  `);

  it("主区间内 gain 为 1", () => {
    const picks = pickSfzRegionsWithGain(regions, 50, 90, "attack");
    expect(picks).toHaveLength(1);
    expect(picks[0].gain).toBeCloseTo(1, 5);
  });

  it("淡入带内按比例（xfin_lokey=36 → lokey=40）", () => {
    const picks = pickSfzRegionsWithGain(regions, 38, 90, "attack");
    expect(picks[0].gain).toBeCloseTo(0.5, 5);
    const atStart = pickSfzRegionsWithGain(regions, 36, 90, "attack");
    expect(atStart[0].gain).toBeCloseTo(0, 5);
  });

  it("淡出带内按比例（hikey=60 → xfout_hikey=64）", () => {
    const picks = pickSfzRegionsWithGain(regions, 62, 90, "attack");
    expect(picks[0].gain).toBeCloseTo(0.5, 5);
  });

  it("有效范围外不命中", () => {
    expect(pickSfzRegionsWithGain(regions, 35, 90, "attack")).toHaveLength(0);
    expect(pickSfzRegionsWithGain(regions, 65, 90, "attack")).toHaveLength(0);
  });
});

describe("sampleVelCurve", () => {
  const curve = { 30: 0.2, 100: 0.9 };

  it("端点与插值", () => {
    expect(sampleVelCurve(curve, 10)).toBe(0.2);
    expect(sampleVelCurve(curve, 100)).toBe(0.9);
    expect(sampleVelCurve(curve, 65)).toBeCloseTo(0.2 + (0.9 - 0.2) * (35 / 70), 5);
  });

  it("无曲线返回 undefined", () => {
    expect(sampleVelCurve(undefined, 60)).toBeUndefined();
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

describe("nextKeyswitchState", () => {
  const ksRegions = parseSfzText(`
    <region> sample=a.wav key=60 sw_lokey=60 sw_hikey=60
    <region> sample=b.wav key=60 sw_lokey=72 sw_hikey=72
    <region> sample=c.wav key=60 sw_lokey=84 sw_hikey=84 sw_previous=1
    <region> sample=d.wav key=60 sw_lokey=96 sw_hikey=96 sw_last=0
  `).regions;

  it("非 keyswitch 键不改变状态", () => {
    expect(nextKeyswitchState(undefined, 40, ksRegions)).toBeUndefined();
    const state = { activeKey: 60, previousKey: undefined, last: true };
    expect(nextKeyswitchState(state, 40, ksRegions)).toBe(state);
  });

  it("首次 keyswitch 键激活并记录（默认保持）", () => {
    const next = nextKeyswitchState(undefined, 60, ksRegions);
    expect(next).toMatchObject({ activeKey: 60, last: true });
  });

  it("新 keyswitch 键更新激活，旧键记为上一个", () => {
    const next = nextKeyswitchState({ activeKey: 60, last: true }, 72, ksRegions);
    expect(next).toMatchObject({ activeKey: 72, previousKey: 60, last: true });
  });

  it("sw_previous=1 回退到上一个激活键", () => {
    const next = nextKeyswitchState({ activeKey: 72, previousKey: 60, last: true }, 84, ksRegions);
    expect(next).toMatchObject({ activeKey: 60, previousKey: 72, last: true });
  });

  it("sw_last=0 区域标记 last=false（松开 keyswitch 键后回默认）", () => {
    const next = nextKeyswitchState({ activeKey: 60, last: true }, 96, ksRegions);
    expect(next).toMatchObject({ activeKey: 96, last: false });
  });
});
