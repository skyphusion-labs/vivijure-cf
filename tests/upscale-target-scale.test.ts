/// <reference types="node" />
// The upscale must TARGET the delivery resolution instead of applying a blind 2x.
//
// MEASURED 2026-08-16 against the LIVE serve pin, not origin/main:
//   `ghcr.io/skyphusion-labs/vivijure-upscale:1.1.1-serve` (fleet compose default).
//   Tagged v1.1.2 is the same handler train. Both still do:
//
//     final_scale = 4 if int(inp.get("scale", 2) or 2) >= 4 else 2
//
// The handler HARD-CLAMPS to exactly 2 or 4, and `int()` TRUNCATES, so a fractional request
// is silently rounded DOWN rather than refused. Asking for 2.18 gets you 2 and no error -- a
// plausible wrong value, which is the failure mode this whole defect is made of. So the panel
// must choose deliberately from {2, 4}; it must never compute a float.
//
// origin/main #109 honours `target_height`. That commit is untagged and not on this pin, so
// this suite still asserts the 2|4 contract. A height knob against the live pin would lie.
//
//   handler.py:281 -- `out_w, out_h = _capped(sw * final_scale, sh * final_scale, MAX_LONG_EDGE)`
//
// and both models are 4x NATIVE (handler.py:10): a scale-2 request runs the same 4x model and then
// rescales DOWN on the GPU. **So scale 4 does not increase model memory over scale 2.** That
// matters because #585's CUDA-OOM was a MODEL decision (RealESRGAN_x4plus, the heavy RRDB), which
// this change does not touch. Choosing 4 is a resize decision, not a memory one.
//
// WHY THE DRAFT PATH IS THE REAL BUG. 864x496 with a blind 2x lands at 1728x992, which is BELOW a
// 1080p delivery, so ffmpeg then stretches it back UP to 1920x1080. The learned 4x output was
// computed on the GPU and thrown away down to 992 lines, then naively re-expanded. Downsample
// followed by upsample, inside one pipeline.
//
// NON-DEFAULT PROBES THROUGHOUT. Every target here is deliberately NOT 1920x1080, because
// `?? 1920` honoured and `?? 1920` substituted are byte-identical -- which is exactly why nothing
// caught the original defect. A test asserting 1920 appears would pass against the bug.

import { describe, it, expect } from "vitest";
import { chooseUpscaleScale, UPSCALE_FACTORS } from "../modules/finish-upscale/src/finish";

/** Deliberately not 1920x1080, and not a multiple of it. */
const TARGET = { width: 1280, height: 536 };

describe("chooseUpscaleScale: the factor is DERIVED from the delivery target", () => {
  it("only ever returns a factor the handler will actually honour", () => {
    // The handler clamps to 2|4 and truncates floats. Anything else is silently mangled.
    expect([...UPSCALE_FACTORS]).toEqual([2, 4]);
    const seen = new Set<number>();
    for (const w of [200, 400, 640, 864, 1280, 1920]) {
      for (const h of [100, 200, 268, 496, 720, 1080]) {
        seen.add(chooseUpscaleScale({ width: w, height: h }, TARGET).scale);
      }
    }
    for (const s of seen) expect([2, 4]).toContain(s);
    // CONTROL: the sweep must actually have produced BOTH factors, or this proves nothing about
    // the choice being derived -- a function returning a constant 2 would pass a subset check.
    expect([...seen].sort()).toEqual([2, 4]);
  });

  it("picks 2 when 2 already reaches the target on both axes", () => {
    // 640x268 * 2 = 1280x536, exactly the target. Nothing larger is needed.
    const c = chooseUpscaleScale({ width: 640, height: 268 }, TARGET);
    expect(c.scale).toBe(2);
    expect(c.derived).toBe(true);
    expect(c.undershoots).toBe(false);
  });

  it("THE DRAFT BUG: picks 4 when 2 would land BELOW the target", () => {
    // 400x200 * 2 = 800x400, under on both axes -> would be stretched back up by ffmpeg.
    // 400x200 * 4 = 1600x800, clears the target -> one learned upscale, then a downsample.
    const c = chooseUpscaleScale({ width: 400, height: 200 }, TARGET);
    expect(c.scale).toBe(4);
    expect(c.derived).toBe(true);
    expect(c.undershoots).toBe(false);
  });

  it("undershooting on EITHER axis alone is enough to step up", () => {
    // Wide but short: width clears at 2x, height does not. The axis that fails decides.
    const c = chooseUpscaleScale({ width: 900, height: 200 }, TARGET);
    expect(c.scale).toBe(4);
    expect(c.derived).toBe(true);
  });

  it("says so HONESTLY when even 4x cannot reach the target", () => {
    // 200x100 * 4 = 800x400, still under. There is no larger factor the handler accepts, so the
    // only honest answer is the largest available PLUS a flag -- never a silent shortfall.
    const c = chooseUpscaleScale({ width: 200, height: 100 }, TARGET);
    expect(c.scale).toBe(4);
    expect(c.undershoots).toBe(true);
  });

  it("UNKNOWN source dimensions are reported as NOT DERIVED, never as a confident default", () => {
    // This is the defect's own shape and the reason `derived` exists. A defaulted factor and a
    // derived one must not be the same observation; that indistinguishability is what let a blind
    // `?? 1920` survive in the film path with nothing able to flag it.
    for (const src of [{ width: 0, height: 0 }, { width: 864, height: 0 }, { width: Number.NaN, height: 496 }]) {
      const c = chooseUpscaleScale(src, TARGET);
      expect(c.derived).toBe(false);
      expect([2, 4]).toContain(c.scale);
    }
  });

  it("an UNKNOWN target is also not derived -- the target is half the input", () => {
    const c = chooseUpscaleScale({ width: 864, height: 496 }, { width: 0, height: 0 });
    expect(c.derived).toBe(false);
  });

  it("a source ALREADY at the target still supersamples rather than returning an unhonoured 1", () => {
    // The handler has no scale-1 path, and Conrad's ruling keeps the upscale on for owned iron.
    // 2x then downsample is real supersampling; returning 1 would be silently truncated to... 2
    // anyway by `int(1) >= 4 ? 4 : 2`, so making it explicit is the honest form.
    const c = chooseUpscaleScale({ width: 1280, height: 536 }, TARGET);
    expect(c.scale).toBe(2);
    expect(c.derived).toBe(true);
    expect(c.undershoots).toBe(false);
  });
});
