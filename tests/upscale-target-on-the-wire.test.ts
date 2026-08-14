/// <reference types="node" />
// THE ASSERTION #177 COULD NOT CARRY. Its lookup tests covered the lookup; nothing asserted that a
// delivery target reaching the module actually changes what goes ON THE WIRE to the GPU. That
// consumer did not exist until now, so the assertion lands here.
//
// It closes the gap I named rather than papered over on #177: a test that stops at the seam it can
// reach, while the thing that matters is one hop further out.
//
// NON-DEFAULT PROBES. The module default is scale 2, so asserting 2 proves nothing -- it is what
// you get from a blind default, an honoured explicit choice, and a derivation that happens to agree.
// Every case here forces a factor that differs from the default, or pins the provenance separately.

import { describe, it, expect } from "vitest";
import { buildRunPodBody, coerceConfig } from "../modules/finish-upscale/src/finish";
import type { FinishInput } from "../modules/finish-upscale/src/contract";

const base = { shot_id: "shot_01", clip_key: "renders/p/shot_01.mp4" };
const body = (input: Partial<FinishInput>, cfg: Record<string, unknown> = {}) =>
  buildRunPodBody({ ...base, ...input } as FinishInput, coerceConfig(cfg), "p1").input;

describe("cf507b on the wire: the target decides the factor the GPU is asked for", () => {
  it("THE DRAFT CASE: a source that 2x would leave BELOW target goes out as 4", async () => {
    // 864x496 is the real draft geometry. 2x = 1728x992, under 1080 -- the exact job that today
    // gets a learned upscale and then a naive ffmpeg stretch back up.
    const b = body({ width: 864, height: 496, delivery_width: 1920, delivery_height: 1080 });
    expect(b.scale).toBe(4);
  });

  it("a source that 2x already clears goes out as 2, not a reflexive 4", async () => {
    // 1280x720 * 2 = 2560x1440, past a 1080p delivery. Overshooting further buys nothing.
    const b = body({ width: 1280, height: 720, delivery_width: 1920, delivery_height: 1080 });
    expect(b.scale).toBe(2);
  });

  it("CONTROL: the same call DOES emit a different factor, so the two above discriminate", async () => {
    // Without this pair being produced by one code path, `scale: 4` and `scale: 2` could each be a
    // constant reached by different branches that never compare anything.
    const small = body({ width: 400, height: 200, delivery_width: 1280, delivery_height: 536 });
    const large = body({ width: 1280, height: 536, delivery_width: 1280, delivery_height: 536 });
    expect(small.scale).not.toBe(large.scale);
  });

  it("NO target on the wire -> today's behaviour, byte for byte", async () => {
    // The pre-core-1.11.0 shape, and the shape a miss produces. Must be the module default, and
    // must NOT be a guess derived from the source alone.
    const b = body({ width: 864, height: 496 });
    expect(b.scale).toBe(2);
  });

  it("NO measured source -> today's behaviour, even with a target present", async () => {
    // The lookup-miss case from core's side. A target with nothing to compare it against cannot
    // derive anything, and inventing a source would be the guess this whole change removes.
    const b = body({ delivery_width: 1920, delivery_height: 1080 });
    expect(b.scale).toBe(2);
  });

  it("AN EXPLICIT SCALE REACHES THE WIRE UNCHANGED, even when derivation disagrees", async () => {
    // core#174, one field over: we do not substitute for a request the user actually made. Source
    // 864x496 to 1080p derives 4; the user asked for 2 and gets 2.
    const b = body({ width: 864, height: 496, delivery_width: 1920, delivery_height: 1080 }, { scale: 2 });
    expect(b.scale).toBe(2);
  });

  it("and an explicit 4 survives a target that would only need 2", async () => {
    // The mirror, so "explicit wins" is not accidentally "the larger value wins".
    const b = body({ width: 1280, height: 720, delivery_width: 1920, delivery_height: 1080 }, { scale: 4 });
    expect(b.scale).toBe(4);
  });

  it("the rest of the RunPod body is untouched by any of this", async () => {
    // The factor is the only thing that moved. A change to the transport payload would be a
    // regression in a path this PR has no business altering.
    const b = body({ width: 864, height: 496, delivery_width: 1920, delivery_height: 1080 });
    expect(b.project).toBe("p1");
    expect(b.clip_key).toBe("renders/p/shot_01.mp4");
    expect(b.output_key).toBe("renders/p/shot_01_up.mp4");
    expect(b.model).toBe("realesr-animevideov3");
    // and no delivery_* leaks onto the wire: the handler takes a factor, not a target
    expect(b.delivery_width).toBeUndefined();
    expect(b.delivery_height).toBeUndefined();
  });
});
