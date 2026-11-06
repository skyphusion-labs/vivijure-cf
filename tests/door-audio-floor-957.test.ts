// cf#957 / vivijure-core#464: core 1.37.0 pads a line on a driven shot only to the floor the shot's own
// door declares, and refuses a manifest whose floor is unusable. These are the three doors that take a
// driving line (`grep -rln "driving_audio: true" modules/*/src/*.ts`), read from their real /module.json
// through core's own validator and parser.
import { describe, it, expect } from "vitest";
import { validateManifest } from "@skyphusion-labs/vivijure-core/modules/manifest-validate";
import { doorBillsPerClip, parseMotionUsage } from "@skyphusion-labs/vivijure-core/motion-usage";
import { assembleHoldSeconds, drivenLineFloorSeconds } from "@skyphusion-labs/vivijure-core/film-orchestrator";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core/modules/types";
import wan from "../modules/alibaba-wan/src/index";
import infinitetalk from "../modules/infinitetalk/src/index";
import pvideo from "../modules/cf-p-video-avatar/src/index";

// Each door's fetch has its own Env (and one takes a ctx); /module.json reads none of it.
type Door = { fetch: (...args: never[]) => Promise<Response> | Response };
const manifestOf = async (w: Door) => {
  const call = w.fetch as unknown as (r: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
  return (await (await call(new Request("https://m/module.json"), {}, {})).json()) as Record<string, unknown>;
};

describe("driving-audio floors under core 1.37.0 (cf#957, core#464)", () => {
  it("Wan declares 3s, and core loads it and keeps it", async () => {
    const m = await manifestOf(wan);
    expect(typeof validateManifest(m)).toBe("object");
    expect(parseMotionUsage(m.usage)?.driving_audio_min_seconds).toBe(3);
  });

  it("InfiniteTalk and p-video load with no floor, so their lines are not padded", async () => {
    for (const [name, w] of [["infinitetalk", infinitetalk], ["cf-p-video-avatar", pvideo]] as const) {
      const m = await manifestOf(w);
      expect(typeof validateManifest(m), name).toBe("object");
      const u = parseMotionUsage(m.usage);
      expect(u?.driving_audio, name).toBe(true);
      expect(u?.driving_audio_min_seconds, name).toBeUndefined();
    }
  });

  it("the p-video limit copy no longer says trailing silence is billed", async () => {
    const limits = ((await manifestOf(pvideo)).ui as { limits: string[] }).limits;
    expect(limits.some((l) => /not trimmed/.test(l))).toBe(false);
    expect(limits.some((l) => /cut to 200 ms/.test(l))).toBe(true);
  });
});

// cf#1338 / vivijure-core#478 (core 1.40.0): a driven shot keeps its planned length by the cheapest means its
// door allows. The rule reads each door's billing from its REAL manifest, so this is where it is proven: a
// fixture shaped by hand is what the first draft of core#478 got wrong (`[0.25]` against the real
// `[{ usd: 0.25 }]`), and a rule that misreads InfiniteTalk holds its clip instead of padding its line.
describe("planned length per driving-audio door, from the real manifests (cf#1338, core 1.40.0)", () => {
  const PLANNED = 2;
  const ruleFor = async (w: Door) => {
    const m = await manifestOf(w);
    const usage = parseMotionUsage(m.usage);
    const perClip = doorBillsPerClip({ ...(m as object), binding: "MODULE_X" } as RegisteredModule);
    return {
      perClip,
      pad: drivenLineFloorSeconds(usage, perClip, PLANNED),
      hold: assembleHoldSeconds(usage, perClip, PLANNED),
    };
  };

  it("InfiniteTalk bills per clip: its line is padded to the 2s plan, and assembly holds nothing", async () => {
    expect(await ruleFor(infinitetalk)).toEqual({ perClip: true, pad: 2, hold: undefined });
  });

  it("p-video bills per second: no pad, its pad would be billed; assembly holds it to the 2s plan", async () => {
    expect(await ruleFor(pvideo)).toEqual({ perClip: false, pad: 0, hold: 2 });
  });

  it("Wan bills per second: its own 3s floor still pads the line, and assembly holds to the plan", async () => {
    // A Wan clip is 5, 10 or 15 seconds, so the hold to 2s never adds a frame; it is harmless, not needed.
    expect(await ruleFor(wan)).toEqual({ perClip: false, pad: 3, hold: 2 });
  });
});
