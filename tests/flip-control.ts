// THE shared end-frame flip control. One function, imported by every door test that declares
// `usage.first_last`, rather than a copy per door each asserting the others must not drift.
//
// WHAT IT IS FOR. `first_last: true` is a DECLARATION. Five doors carry it and, as of cf#954, only
// one has been PROVEN to honour it: two send `last_frame_image` where the published schema says
// `last_image` (cf#922) and two send array shapes nobody has controlled. A door that accepts an
// end frame and silently discards it produces a perfectly plausible clip, so nothing about the
// output betrays it. This is the instrument that does.
//
// THE TRICK, and the reason it works: render with an end frame that is a HORIZONTAL FLIP of the
// start frame. Honoured and ignored then give different readings, because a door that discarded
// the end frame ends near the START image while one that used it ends near the FLIPPED image.
// Without the flip, start and end look alike and both verdicts produce the same numbers.
//
// THE CONTROL OF THE CONTROL. `startVsEnd` is the discriminator's own discriminator: if the two
// INPUT images barely differ, no reading of the output can separate the two verdicts, and the
// honest answer is VOID rather than a confident "honoured". A flip control that can only ever
// report `honoured` is worth less than no control at all, which is why `verdictsReachable` in the
// test file asserts every outcome including VOID is producible.

export interface FlipReadings {
  /** distance between the two INPUT images. Near zero voids the whole test. */
  startVsEnd: number;
  /** delivered FIRST frame against each input */
  firstVsStart: number;
  firstVsEnd: number;
  /** delivered LAST frame against each input */
  lastVsStart: number;
  lastVsEnd: number;
}

export type FlipVerdict = "honoured" | "ignored" | "void" | "ambiguous";

/** A delivered frame must be at least this many times closer to one input than the other before we
 *  call it a match. Noise should not decide a capability question. */
export const MATCH_MARGIN = 3;

/** The inputs must differ by at least this much for the test to mean anything. Expressed against
 *  the observed frame distances rather than as an absolute, so it does not assume a pixel scale. */
export const MIN_INPUT_SEPARATION = 5;

export function endFrameVerdict(r: FlipReadings): FlipVerdict {
  // Control first: if the two inputs are alike, nothing downstream can discriminate.
  const closest = Math.min(r.firstVsStart, r.firstVsEnd, r.lastVsStart, r.lastVsEnd);
  if (!(r.startVsEnd > MIN_INPUT_SEPARATION) || !(r.startVsEnd > closest * MATCH_MARGIN)) return "void";

  const firstIsStart = r.firstVsStart * MATCH_MARGIN < r.firstVsEnd;
  const lastIsEnd = r.lastVsEnd * MATCH_MARGIN < r.lastVsStart;
  const lastIsStart = r.lastVsStart * MATCH_MARGIN < r.lastVsEnd;

  if (firstIsStart && lastIsEnd) return "honoured";
  // The door animated away from the start and came back to it: the end frame did nothing.
  if (firstIsStart && lastIsStart) return "ignored";
  return "ambiguous";
}

/** Mean absolute difference between two equally sized single-channel frames. */
export function frameDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || a.length === 0) throw new Error("frameDistance: size mismatch or empty");
  let t = 0;
  for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]);
  return t / a.length;
}

/** The full reading, not a bare verdict. A caller asserts on the NUMBERS in its own test; the
 *  verdict is a convenience over them, never a replacement for them.
 *
 *  `controlSeparation` is deliberately surfaced rather than folded into a boolean: it is the line
 *  that makes the other four readings separable at all, and a helper that hides it lets a
 *  symmetric or near-identical input pair report a confident nothing. Assert on it. */
export interface FlipReport {
  verdict: FlipVerdict;
  readings: FlipReadings;
  /** How far apart the two INPUT images are. The test means nothing if this is small. */
  controlSeparation: number;
  /** False when the inputs are too alike for any output reading to discriminate. */
  controlOk: boolean;
}

export function endFrameReport(r: FlipReadings): FlipReport {
  const verdict = endFrameVerdict(r);
  return { verdict, readings: r, controlSeparation: r.startVsEnd, controlOk: verdict !== "void" };
}

// HOW TO SUPPLY THE FLIPPED FRAME. DEFAULT TO A `data:` URI. Measured by joan on
// seedance-v1-5-pro-i2v, 2026-09-27, after doing it the hard way first.
//
// The flipped frame does not exist anywhere public: you make it locally, so you have to get local
// bytes to the vendor. The obvious move is to host or proxy it, and that is the move that fails.
//
//   THE EVIDENCE, in the endpoint's own words. A bad value on the end-frame key returns:
//     "Input must be a public http(s) URL, a data: URI, or a base64-encoded file"
//   A `data:` URI is a FIRST-CLASS accepted form. It needs no bucket, no presigning, no proxy, and
//   no public URL, and the bytes the vendor reads are byte-identical to the ones you measure
//   against, which removes re-encoding from the comparison as well.
//
//   WHAT HAPPENS IF YOU HOST IT INSTEAD, measured rather than predicted: serving the flip through
//   images.weserv.nl was verified from the caller (HTTP 200, and 2.71 mean-abs-diff against the
//   local flip, i.e. re-encode noise only) and the VENDOR answered
//     "Could not download the input from images.weserv.nl (HTTP 403)"
//   Reachable by us, 403 to them. That cost a render, and it cost it to the person who had already
//   written the warning on the line below. The compliant path was more expensive than the
//   convenient one, so the convenient one got used; a default in this file is the fix for that,
//   because a warning that costs more to obey than to ignore is not a mechanism.
//
// SIZE IS THE ONLY REAL CONSTRAINT: keep the flip small (256x144 at moderate JPEG quality is about
// 4KB, ~5.4KB base64) so the request body stays sane. Scale it to match the start frame, or the
// door may reject or letterbox the pair.
//
// OTHER SOURCING NOTES, same measurement session:
//  - If you DO use a URL, it must be reachable BY THE VENDOR, not merely by us. A Wikimedia thumb
//    URL 400s; a resolved direct URL worked. That failure arrives as a render error rather than as
//    a bad verdict, so it is loud, but it is still a wasted render.
//  - RunPod public endpoints do NO submit-time validation of the envelope. `{"input": {}}` is
//    ACCEPTED, starts a worker, retries, and FAILS after ~47s. Unknown input keys are silently
//    ignored because the worker model does not forbid extras. So a malformed probe is NOT free,
//    and the ABSENCE of a schema error proves nothing about whether a key was read.
