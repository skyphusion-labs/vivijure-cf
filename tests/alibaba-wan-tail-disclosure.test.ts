import { describe, it, expect } from "vitest";
import worker from "../modules/alibaba-wan/src/index";
import { clampDuration } from "../modules/alibaba-wan/src/wan";

/** cf#929. Wan 2.6 keeps the mouth articulating after the driving line ends. The vendor's behaviour is
 *  the vendor's business; ours is that nothing we published let a user predict it. Measured on clip job
 *  clips-67f35a6b-f823-48e5-9413-0aa61c5fe8bc: a 1.4s line in a 5s clip, mouth motion 3.256 while
 *  speaking and 3.787 during silence -- 1.16x LOUDER, against InfiniteTalk's 10.4x quieter on the same
 *  keyframe and the same Cast track.
 *
 *  These assert the DISCLOSURE, not the behaviour. They go red if someone trims the manifest copy back
 *  to the version that implied the mouth tracks the line. */
async function manifest() {
  const res = await worker.fetch(new Request("https://m/module.json"), {} as never);
  return (await res.json()) as {
    version: string;
    ui?: { blurb?: string; limits?: string[] };
    usage?: { min_seconds?: number; duration_steps?: number[] };
  };
}

describe("alibaba-wan discloses the post-line tail (cf#929)", () => {
  it("the blurb says the mouth keeps moving after the line ends", async () => {
    const m = await manifest();
    expect(m.ui?.blurb ?? "").toMatch(/keeps moving after the line ends/i);
  });

  it("a limits entry names the tail explicitly", async () => {
    const m = await manifest();
    const limits = m.ui?.limits ?? [];
    expect(limits.some((l) => /after the line ends/i.test(l))).toBe(true);
  });

  it("a limits entry names the short-line case that makes the tail unavoidable", async () => {
    const m = await manifest();
    const limits = m.ui?.limits ?? [];
    expect(limits.some((l) => /shorter than 5 seconds/i.test(l))).toBe(true);
  });

  it("a limits entry says the duration grid rounds UP, not that it is a menu", async () => {
    const m = await manifest();
    const limits = m.ui?.limits ?? [];
    expect(limits.some((l) => /rounded UP/i.test(l))).toBe(true);
  });

  it("the disclosed rounding matches what clampDuration actually does", async () => {
    // The disclosure is only honest if the code agrees with it. A line under the floor rounds up.
    expect(clampDuration(1)).toBe(5);
    expect(clampDuration(2)).toBe(5);
    expect(clampDuration(6)).toBe(10);
    expect(clampDuration(11)).toBe(15);
    const m = await manifest();
    expect(m.usage?.min_seconds).toBe(5);
    expect(m.usage?.duration_steps).toEqual([5, 10, 15]);
  });
});
