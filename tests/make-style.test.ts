import { describe, expect, it } from "vitest";
import {
  GRADE,
  boardSeconds,
  candidates,
  chooseStyle,
  clipPrice,
  faceGrade,
  hasSpokenLines,
  offeredQualities,
  offeredShapes,
  priceText,
  styleLine,
  type Mod,
  type Registry,
} from "../public/make-style.js";

// cf#1242: the default-style rule for the Make a video page. Fixtures copy the real manifests'
// usage flags, ui.order, aspect and resolution enums and stated rates (modules/*/src), so a test
// reads the same facts the registry serves.
const motion = (name: string, usage: Mod["usage"], extra: Partial<Mod> = {}): Mod => ({
  name,
  hooks: ["motion.backend"],
  provides: [{ id: name, label: name }],
  usage,
  ...extra,
});
const enumOf = (values: string[], dflt = values[0]) => ({ type: "enum", values, default: dflt });

const KEYFRAME: Mod = {
  name: "keyframe",
  hooks: ["keyframe"],
  trains_loras: true,
  config_schema: { width: { type: "int", default: 1344, min: 512, max: 1536 }, height: { type: "int", default: 768, min: 512, max: 1536 } },
};
const CLOUD_KF: Mod = {
  name: "cloud-keyframe",
  hooks: ["keyframe"],
  config_schema: { width: { type: "int", default: 1344, min: 512, max: 1536 }, height: { type: "int", default: 768, min: 512, max: 1536 } },
};
const DOORS: Record<string, Mod> = {
  seedance: motion("cf-seedance", { native_audio: true, first_last: true, voice_ref: true }, {
    ui: { order: 70 },
    config_schema: { aspect_ratio: enumOf(["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "9:21"], "16:9"), resolution: enumOf(["480p", "720p", "1080p", "4k"], "720p") },
  }),
  vidu: motion("cf-vidu-q3-turbo", { native_audio: true, first_last: true }, {
    ui: { order: 58, cost_usd_per_second: [0.04, 0.07] },
    config_schema: { resolution: enumOf(["540p", "720p", "1080p"], "720p") },
  }),
  kling: motion("cf-kling-v4", { native_audio: false, first_last: true }, {
    ui: { order: 94, cost_usd_per_second: [0.157, 0.235] },
    config_schema: { ratio: enumOf(["21:9", "16:9", "9:16", "1:1"], "16:9"), resolution: enumOf(["720p", "1080p"]) },
  }),
  hh1: motion("cf-hh1-r2v", { native_audio: false, first_last: true }, {
    ui: { order: 60 },
    config_schema: { ratio: enumOf(["16:9", "9:16", "3:4", "4:3", "1:1", "21:9", "9:21", "5:4", "4:5"], "16:9"), resolution: enumOf(["720P", "1080P"]) },
  }),
  wanLora: motion("alibaba-wan-lora", { native_audio: false }, { ui: { order: 75 } }),
  flux: motion("cf-flux-3-video", { native_audio: true, first_last: true }, { ui: { order: 90 }, config_schema: { resolution: enumOf(["hd", "fhd"]) } }),
  infinitetalk: motion("infinitetalk", { native_audio: false, driving_audio: true }, { ui: { order: 15 }, config_schema: {} }),
  pva: motion("cf-p-video-avatar", { native_audio: false, driving_audio: true }, {
    ui: { order: 92, cost_usd_per_second: [0.025, 0.045] },
    config_schema: { resolution: enumOf(["720p", "1080p"]) },
  }),
  veo: motion("cf-veo", { native_audio: true }, { ui: { order: 55 }, config_schema: { aspect_ratio: enumOf(["16:9", "9:16", "1:1"]) } }),
  grok: motion("cf-grok-video", { native_audio: true }, { ui: { order: 80 } }),
};

function reg(doors: Mod[], stills: Mod[] = [KEYFRAME, CLOUD_KF]): Registry {
  return {
    modules: [...stills, ...doors],
    hooks: { keyframe: stills.map((m) => m.name), "motion.backend": doors.map((m) => m.name) },
    render: { quality_tiers: [{ value: "draft" }, { value: "standard" }, { value: "final" }], default_tier: "final" },
  };
}
const ALL = reg(Object.values(DOORS));

describe("face grade", () => {
  it("a door that holds the face by its own evidence outranks two stills, which outrank one", () => {
    expect(faceGrade(DOORS.hh1)).toBe(GRADE.HOLD);
    expect(faceGrade(DOORS.wanLora)).toBe(GRADE.HOLD);
    expect(faceGrade(DOORS.seedance)).toBe(GRADE.TWO);
    expect(faceGrade(DOORS.veo)).toBe(GRADE.ONE);
  });
  it("a door documented as drifting is demoted even though it takes two stills", () => {
    expect(DOORS.flux.usage?.first_last).toBe(true);
    expect(faceGrade(DOORS.flux)).toBe(GRADE.DRIFT);
  });
  it("an unknown door gets its grade from the registry facts alone", () => {
    expect(faceGrade(motion("new-door", { native_audio: true, first_last: true }))).toBe(GRADE.TWO);
    expect(faceGrade(motion("new-door", { native_audio: true }))).toBe(GRADE.ONE);
  });
});

describe("chooseStyle: consistency first, not price", () => {
  it("before the plan, the highest face grade wins, and a door that needs training it cannot get is skipped", () => {
    const c = chooseStyle(ALL, { shape: "vertical" });
    expect(c?.door.name).toBe("cf-hh1-r2v");
    expect(c?.motionConfig).toMatchObject({ ratio: "9:16" });
    expect(c?.stillConfig).toEqual({ width: 768, height: 1344 });
    expect(c?.still?.name).toBe("keyframe");
  });
  it("the trained-face door wins its tie once training is possible, by ui.order", () => {
    const c = chooseStyle(reg([DOORS.wanLora, DOORS.seedance]), { shape: "vertical", host: { wanTrainable: true } });
    expect(c?.door.name).toBe("alibaba-wan-lora");
    expect(c?.needs).toBe("wan_lora");
    expect(chooseStyle(reg([DOORS.wanLora, DOORS.seedance]), { shape: "vertical" })?.door.name).toBe("cf-seedance");
  });
  it("price never wins: the cheaper door with a stated rate loses to a better face grade", () => {
    const c = chooseStyle(reg([DOORS.vidu, DOORS.hh1]), { shape: "wide" });
    expect(c?.door.name).toBe("cf-hh1-r2v");
  });
  it("a plan with spoken lines keeps only doors that can speak", () => {
    const c = chooseStyle(ALL, { shape: "vertical", talks: true });
    expect(c?.door.name).toBe("cf-vidu-q3-turbo");
    expect(styleLine(c?.door)).toBe("Talking, consistent faces");
  });
  it("while talking is unknown, a door that can speak wins a tie in face grade", () => {
    const silent = motion("a-silent", { native_audio: false, first_last: true }, { ui: { order: 1 } });
    const c = chooseStyle(reg([silent, DOORS.seedance]), { shape: "wide" });
    expect(c?.door.name).toBe("cf-seedance");
    expect(chooseStyle(reg([silent, DOORS.seedance]), { shape: "wide", talks: false })?.door.name).toBe("a-silent");
  });
  it("wide plus talking picks InfiniteTalk: the face is our still and the voice is the person's own", () => {
    const c = chooseStyle(ALL, { shape: "wide", talks: true });
    expect(c?.door.name).toBe("infinitetalk");
    expect(c?.grade).toBe(GRADE.HOLD);
    expect(styleLine(c?.door)).toBe("Talking in their own voices, faces locked");
  });
  it("vertical plus talking does not pick a voice-file door, it takes the best native-audio door", () => {
    expect(chooseStyle(ALL, { shape: "vertical", talks: true })?.door.name).toBe("cf-vidu-q3-turbo");
    expect(chooseStyle(ALL, { shape: "square", talks: true })?.door.name).toBe("cf-vidu-q3-turbo");
    expect(candidates(reg([DOORS.infinitetalk, DOORS.pva]), { shape: "vertical", talks: true })).toEqual([]);
  });
  it("the higher-resolution voice-file door wins wide talking when InfiniteTalk is not installed", () => {
    expect(chooseStyle(reg([DOORS.vidu, DOORS.seedance, DOORS.pva]), { shape: "wide", talks: true })?.door.name).toBe("cf-p-video-avatar");
    expect(chooseStyle(reg([DOORS.pva, DOORS.infinitetalk]), { shape: "wide", talks: true })?.door.name).toBe("infinitetalk");
  });
  it("a voice-file door is never picked before the plan, or for a plan with no lines", () => {
    expect(chooseStyle(ALL, { shape: "wide" })?.door.name).toBe("cf-hh1-r2v");
    expect(chooseStyle(ALL, { shape: "wide", talks: false })?.door.name).toBe("cf-hh1-r2v");
    expect(candidates(reg([DOORS.infinitetalk]), { shape: "wide", talks: false })).toEqual([]);
  });
  it("among talking doors of one face grade, the person's own voice wins over an invented one", () => {
    // The rival takes hh1's evidence row (HOLD) with talking audio and ui.order 1, so ui.order alone
    // would pick it. Both are HOLD; the voice lock decides first.
    const rival = motion("cf-hh1-r2v", { native_audio: true, first_last: true }, { ui: { order: 1 } });
    expect(chooseStyle(reg([rival, DOORS.infinitetalk]), { shape: "wide", talks: true })?.door.name).toBe("infinitetalk");
  });
  it("a voice-file door is skipped when someone cannot be bound, since they would speak in the default voice", () => {
    expect(chooseStyle(ALL, { shape: "wide", talks: true, host: { voicesReady: false } })?.door.name).toBe("cf-vidu-q3-turbo");
    expect(chooseStyle(ALL, { shape: "wide", talks: true, host: { voicesReady: true } })?.door.name).toBe("infinitetalk");
  });
  it("one start still is not consistency grade, so it is never picked", () => {
    expect(chooseStyle(reg([DOORS.veo, DOORS.grok]), { shape: "wide" })).toBeNull();
  });
});

describe("shapes: only what a consistency-grade door can deliver", () => {
  it("vertical is offered when a consistency-grade door can make it", () => {
    expect(offeredShapes(ALL).map((s) => s.id)).toEqual(["vertical", "square", "wide"]);
  });
  it("a shape no consistency-grade door supports is NOT offered, rather than downgraded", () => {
    const wideOnly = motion("wide-door", { native_audio: true, first_last: true }, { config_schema: { ratio: enumOf(["16:9", "21:9"]) } });
    // veo can make vertical, but it is grade ONE, so vertical must not appear.
    const r = reg([wideOnly, DOORS.veo]);
    expect(offeredShapes(r).map((s) => s.id)).toEqual(["wide"]);
    expect(chooseStyle(r, { shape: "vertical" })).toBeNull();
  });
  it("a door with no aspect knob follows the still, so every shape the stills door can draw is offered", () => {
    expect(offeredShapes(reg([DOORS.vidu])).map((s) => s.id)).toEqual(["vertical", "square", "wide"]);
  });
  it("a stills door that cannot draw the size takes the shape off the list", () => {
    const small: Mod = { name: "small-kf", hooks: ["keyframe"], config_schema: { width: { type: "int", min: 512, max: 1024 }, height: { type: "int", min: 512, max: 1024 } } };
    expect(offeredShapes(reg([DOORS.vidu], [small])).map((s) => s.id)).toEqual(["square"]);
  });
  it("talking narrows the shapes to what a talking consistency-grade door can make", () => {
    const silentTall = motion("silent-tall", { native_audio: false, first_last: true }, { config_schema: { ratio: enumOf(["9:16"]) } });
    const talkWide = motion("talk-wide", { native_audio: true, first_last: true }, { config_schema: { ratio: enumOf(["16:9"]) } });
    expect(offeredShapes(reg([silentTall, talkWide])).map((s) => s.id)).toEqual(["vertical", "wide"]);
    expect(offeredShapes(reg([silentTall, talkWide]), { talks: true }).map((s) => s.id)).toEqual(["wide"]);
  });
  it("no motion door at all offers nothing", () => {
    expect(offeredShapes(reg([]))).toEqual([]);
  });
});

describe("quality and price", () => {
  it("offers Draft, Good, Best only for tiers the host projects", () => {
    expect(offeredQualities(ALL).map((q) => q.label)).toEqual(["Draft", "Good", "Best"]);
    expect(offeredQualities({ render: { quality_tiers: [{ value: "final" }] } }).map((q) => q.label)).toEqual(["Best"]);
  });
  it("prices from the door's stated rate: lowest resolution at the first figure, highest at the second", () => {
    expect(clipPrice(DOORS.vidu, 20, "draft")).toMatchObject({ usd: 0.8, kind: "about" });
    expect(clipPrice(DOORS.vidu, 20, "best")).toMatchObject({ usd: 1.4, kind: "about" });
  });
  it("a middle resolution is priced at the top figure and said as up to", () => {
    const p = clipPrice(DOORS.vidu, 20, "good");
    expect(p).toMatchObject({ usd: 1.4, kind: "up_to" });
    expect(priceText(p)).toBe("up to $1.40");
  });
  it("a missing rate is price unknown, never a guessed number", () => {
    const p = clipPrice(DOORS.hh1, 30, "best");
    expect(p.usd).toBeNull();
    expect(priceText(p)).toBe("price unknown");
  });
  it("a rate with a bad figure is unknown too", () => {
    const bad = motion("bad", { native_audio: true, first_last: true }, { ui: { cost_usd_per_second: [0, 0.1] } });
    expect(priceText(clipPrice(bad, 10, "best"))).toBe("price unknown");
  });
  it("the quality picks the door's resolution", () => {
    expect(chooseStyle(reg([DOORS.vidu]), { shape: "wide", quality: "best" })?.motionConfig).toEqual({ resolution: "1080p" });
    expect(chooseStyle(reg([DOORS.vidu]), { shape: "wide", quality: "draft" })?.motionConfig).toEqual({ resolution: "540p" });
    expect(chooseStyle(reg([DOORS.seedance]), { shape: "square", quality: "good" })?.motionConfig).toEqual({ aspect_ratio: "1:1", resolution: "720p" });
  });
});

describe("board facts", () => {
  const board = { clip_seconds: 5, scenes: [{ prompt: "a", target_seconds: 6 }, { prompt: "b" }, { prompt: " " }, { prompt: "c", dialogue: { slot: "A", text: "Hi." } }] };
  it("seconds match the render submit: target_seconds, else clip_seconds, and empty shots dropped", () => {
    expect(boardSeconds(board)).toBe(16);
  });
  it("finds a spoken line", () => {
    expect(hasSpokenLines(board)).toBe(true);
    expect(hasSpokenLines({ scenes: [{ prompt: "a", dialogue: { slot: "A", text: "  " } }] })).toBe(false);
  });
});
