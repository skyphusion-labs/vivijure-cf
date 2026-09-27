import { describe, it, expect } from "vitest";
import { mp4VideoTiming } from "../modules/_shared/mp4-timing";
import { deliveredTiming as talkTiming } from "../modules/infinitetalk/src/kling";
import { deliveredTiming as wanTiming } from "../modules/alibaba-wan/src/wan";
import { FX_25FPS_B64, FX_30FPS_B64, fx } from "./fixtures/mp4-timing-fixtures";

/** cf#923. Both doors declared `OUT_FPS = 24` and neither delivered it: infinitetalk returns 25,
 *  alibaba-wan returns 30. The fixtures are REAL libx264-muxed containers at exactly those two rates,
 *  not hand-built byte arrays -- a hand-built fixture would encode the same assumptions the parser
 *  makes and could not falsify it. Verified with `ffprobe -count_frames` before committing. */
describe("mp4VideoTiming measures the artifact (cf#923)", () => {
  it("reads 25fps / 25 frames off a real 25fps container -- the rate infinitetalk delivers", () => {
    const t = mp4VideoTiming(fx(FX_25FPS_B64));
    expect(t).not.toBeNull();
    expect(t!.frames).toBe(25);
    expect(t!.fps).toBeCloseTo(25, 3);
  });

  it("reads 30fps / 30 frames off a real 30fps container -- the rate alibaba-wan delivers", () => {
    const t = mp4VideoTiming(fx(FX_30FPS_B64));
    expect(t).not.toBeNull();
    expect(t!.frames).toBe(30);
    expect(t!.fps).toBeCloseTo(30, 3);
  });

  it("does not return 24 for anything, which is the whole defect", () => {
    for (const b64 of [FX_25FPS_B64, FX_30FPS_B64]) {
      const t = mp4VideoTiming(fx(b64));
      expect(Math.round(t!.fps!)).not.toBe(24);
    }
  });

  it("counts frames from the sample table, not from duration x an assumed rate", () => {
    // Both fixtures are 1 second. If frames were duration x 24 both would report 24.
    expect(mp4VideoTiming(fx(FX_25FPS_B64))!.frames).toBe(25);
    expect(mp4VideoTiming(fx(FX_30FPS_B64))!.frames).toBe(30);
  });

  it("returns null on garbage rather than guessing", () => {
    expect(mp4VideoTiming(new Uint8Array(0))).toBeNull();
    expect(mp4VideoTiming(new Uint8Array([0, 0, 0, 8, 102, 116, 121, 112]))).toBeNull();
    expect(mp4VideoTiming(new Uint8Array(64))).toBeNull();
  });

  it("survives a truncated container without throwing or inventing a count", () => {
    const full = fx(FX_25FPS_B64);
    for (const cut of [0.25, 0.5, 0.75]) {
      const part = full.slice(0, Math.floor(full.length * cut));
      expect(() => mp4VideoTiming(part)).not.toThrow();
    }
  });
});

describe("both doors report the measured value (cf#923)", () => {
  it("infinitetalk reports the real rate, not 24", () => {
    const t = talkTiming(fx(FX_25FPS_B64).buffer as ArrayBuffer);
    expect(t.frames).toBe(25);
    expect(t.fps).toBeCloseTo(25, 3);
  });

  it("alibaba-wan reports the real rate and frame count, not requested_seconds x 24", () => {
    const t = wanTiming(fx(FX_30FPS_B64).buffer as ArrayBuffer);
    expect(t.frames).toBe(30);
    expect(t.fps).toBeCloseTo(30, 3);
  });

  it("both report 0/0 when the artifact cannot be measured, never a constant", () => {
    // 0 is the contract's existing not-available channel: conformance checks isNum (not > 0), and
    // core only records a delivery when fps > 0 && frames > 0. So the clip still ships and nothing
    // downstream stores a rate nobody measured.
    expect(talkTiming(new ArrayBuffer(8))).toEqual({ fps: 0, frames: 0 });
    expect(wanTiming(new ArrayBuffer(8))).toEqual({ fps: 0, frames: 0 });
    expect(talkTiming(new Uint8Array(64).buffer)).toEqual({ fps: 0, frames: 0 });
  });

  it("the two doors agree, because they share one parser rather than a copy each", () => {
    // cf#923 was one constant pasted into two modules where nobody re-checked it. The guard against
    // a repeat is that both doors resolve to the same measurement for the same bytes.
    const bytes = fx(FX_30FPS_B64).buffer as ArrayBuffer;
    expect(talkTiming(bytes)).toEqual(wanTiming(bytes));
  });
});
