import { describe, it, expect } from "vitest";
import { endFrameVerdict, endFrameReport, frameDistance, type FlipReadings, type FlipVerdict } from "./flip-control";

// The real reading from the fal-wan-27 flip-control render (vivijure#826).
const HONOURED: FlipReadings = { startVsEnd: 62.25, firstVsStart: 2.01, firstVsEnd: 62.89, lastVsStart: 62.63, lastVsEnd: 3.75 };

describe("cf#954: the flip control must be able to return every verdict", () => {
  // THE CONTROL OF THE CONTROL. A discriminator that can only produce the reassuring answer is
  // decoration. This test exists to prove each outcome is reachable before any door is judged.
  it("reaches all four verdicts", () => {
    const seen = new Set<FlipVerdict>();
    seen.add(endFrameVerdict(HONOURED));
    // door ignored the end frame: the last frame came back to the START image
    seen.add(endFrameVerdict({ startVsEnd: 62.25, firstVsStart: 2.01, firstVsEnd: 62.89, lastVsStart: 3.4, lastVsEnd: 61.9 }));
    // the two inputs barely differ, so nothing can be concluded
    seen.add(endFrameVerdict({ startVsEnd: 0.8, firstVsStart: 0.7, firstVsEnd: 0.9, lastVsStart: 0.8, lastVsEnd: 0.75 }));
    // last frame sits between the two: no clean call
    seen.add(endFrameVerdict({ startVsEnd: 62.25, firstVsStart: 2.01, firstVsEnd: 62.89, lastVsStart: 30.0, lastVsEnd: 28.0 }));
    expect([...seen].sort()).toEqual(["ambiguous", "honoured", "ignored", "void"]);
  });

  it("calls the real fal-wan-27 reading HONOURED", () => {
    expect(endFrameVerdict(HONOURED)).toBe("honoured");
  });

  it("calls a discarded end frame IGNORED, which is the reading that matters", () => {
    expect(endFrameVerdict({ startVsEnd: 62.25, firstVsStart: 2.01, firstVsEnd: 62.89, lastVsStart: 3.4, lastVsEnd: 61.9 })).toBe("ignored");
  });

  it("VOIDS itself when the two inputs are too alike to discriminate", () => {
    // Without the flip, start and end look the same and BOTH verdicts produce identical numbers.
    // Reporting "honoured" here would be the instrument measuring itself.
    expect(endFrameVerdict({ startVsEnd: 1.2, firstVsStart: 1.0, firstVsEnd: 1.1, lastVsStart: 1.1, lastVsEnd: 1.0 })).toBe("void");
  });

  it("VOIDS when the inputs differ but not enough against the frame distances", () => {
    expect(endFrameVerdict({ startVsEnd: 6, firstVsStart: 5, firstVsEnd: 7, lastVsStart: 7, lastVsEnd: 5 })).toBe("void");
  });

  it("frameDistance is zero for identical frames and positive otherwise", () => {
    const a = new Uint8Array([0, 10, 20, 30]);
    expect(frameDistance(a, new Uint8Array([0, 10, 20, 30]))).toBe(0);
    expect(frameDistance(a, new Uint8Array([10, 10, 20, 30]))).toBeCloseTo(2.5);
  });

  it("frameDistance refuses mismatched or empty input rather than returning a number", () => {
    expect(() => frameDistance(new Uint8Array([1, 2]), new Uint8Array([1]))).toThrow();
    expect(() => frameDistance(new Uint8Array([]), new Uint8Array([]))).toThrow();
  });
});

describe("cf#954: the report surfaces the numbers, not just a verdict", () => {
  it("returns the control separation so a caller can assert on it", () => {
    const rep = endFrameReport(HONOURED);
    expect(rep.verdict).toBe("honoured");
    expect(rep.controlSeparation).toBe(62.25);
    expect(rep.controlOk).toBe(true);
    expect(rep.readings).toEqual(HONOURED);
  });

  it("marks controlOk false when the inputs were too alike to discriminate", () => {
    const rep = endFrameReport({ startVsEnd: 1.2, firstVsStart: 1.0, firstVsEnd: 1.1, lastVsStart: 1.1, lastVsEnd: 1.0 });
    expect(rep.verdict).toBe("void");
    expect(rep.controlOk).toBe(false);
  });
});
