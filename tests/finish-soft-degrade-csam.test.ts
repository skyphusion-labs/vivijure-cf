import { describe, expect, it } from "vitest";
import {
  csamRefusalInCompletedOutput,
  isCsamRefusalReason,
  softDegradeInCompletedOutput,
  softDegradeInFailedEnvelope,
} from "../modules/_shared/finish-soft-degrade";
import { isCsamRefusal } from "../modules/cloud-keyframe/src/image-gen";

// cf#595: a CSAM door return is structured ok:false, which is the same shape as a
// polish miss. The discriminator must not absorb it. A no-face degrade is the control.
//
// GHSA-qgx2-5crw-9m4j: THIS SUITE PASSED WHILE THE DEFECT WAS LIVE, and the reason is the point.
// Every positive case below the original line was a string containing the literal token `csam` --
// including "CSAM child sexual content", which contains BOTH spellings and so passes on the narrow
// needle alone. A test written against the same single spelling as the implementation cannot observe
// a divergence from a second implementation elsewhere. The suite was pinning the defect rather than
// covering it, on the safety line. The wordings block below is what it was missing.

/** The three wordings the keyframe door anticipates and the shared needle used to miss entirely. */
const MISSED_WORDINGS = [
  "child sexual abuse material detected in frame 12",
  "refused: child pornography",
  "provider refused: sexual content involving a minor",
];

describe("isCsamRefusalReason", () => {
  it("matches the house needle, case-insensitive", () => {
    expect(isCsamRefusalReason("csam detected")).toBe(true);
    expect(isCsamRefusalReason("CSAM child sexual content")).toBe(true);
    expect(isCsamRefusalReason("no detectable face in clip")).toBe(false);
    expect(isCsamRefusalReason("wall-clock guard expired after 900s")).toBe(false);
    expect(isCsamRefusalReason("")).toBe(false);
    expect(isCsamRefusalReason(undefined)).toBe(false);
  });

  // GHSA-qgx2-5crw-9m4j. Each of these is a refusal the provider can word without ever emitting
  // the token `csam`, and each one used to read as an ordinary polish degrade.
  it.each(MISSED_WORDINGS)("matches a refusal worded without the token `csam`: %s", (text) => {
    expect(isCsamRefusalReason(text)).toBe(true);
  });

  it("agrees with the keyframe door on every one of them, because there is now ONE needle", () => {
    // The old docstring CLAIMED these were the same function. This asserts it instead.
    for (const text of [...MISSED_WORDINGS, "csam detected", "no detectable face in clip", ""]) {
      expect(isCsamRefusalReason(text)).toBe(isCsamRefusal(text));
    }
  });
});

describe("soft-degrade discriminators refuse CSAM", () => {
  it("COMPLETED + ok:false + csam is not a degrade", () => {
    const output = { ok: false, detail: "csam detected" };
    expect(softDegradeInCompletedOutput(output)).toBeNull();
    expect(csamRefusalInCompletedOutput(output)).toBe("csam detected");
  });

  it("COMPLETED + ok:false + no-face IS a degrade (control)", () => {
    const output = { ok: false, detail: "no detectable face in clip" };
    expect(softDegradeInCompletedOutput(output)).toBe("no detectable face in clip");
    expect(csamRefusalInCompletedOutput(output)).toBeNull();
  });

  it("FAILED envelope + csam is not a lifted degrade", () => {
    expect(
      softDegradeInFailedEnvelope({
        status: "FAILED",
        error: "csam detected",
        output: { ok: false, detail: "csam detected" },
      }),
    ).toBeNull();
  });

  it("FAILED envelope + wall-clock IS a lifted degrade (control)", () => {
    expect(
      softDegradeInFailedEnvelope({
        status: "FAILED",
        error: "wall-clock guard expired after 900s",
        output: { ok: false },
      }),
    ).toBe("wall-clock guard expired after 900s");
  });
});

// GHSA-qgx2-5crw-9m4j: the three CONSUMERS, not just the matcher.
//
// Testing `isCsamRefusalReason` alone would not have caught this either, because the harm is what
// the consumers do with a false: at :104 and :120 the refusal is returned as a degrade reason and
// the film carries on with a passthrough clip, and at :130 the caller's CSAM branch never fires.
// So each wording is driven through all three entry points on both envelope shapes.
describe("GHSA-qgx2-5crw-9m4j: a refusal without the token `csam` is never a degrade", () => {
  it.each(MISSED_WORDINGS)("COMPLETED + ok:false + detail=%s -> hard fail, not a degrade", (text) => {
    const output = { ok: false, detail: text };
    expect(softDegradeInCompletedOutput(output)).toBeNull();
    expect(csamRefusalInCompletedOutput(output)).toBe(text);
  });

  it.each(MISSED_WORDINGS)("FAILED envelope carrying %s -> hard fail, not a lifted degrade", (text) => {
    expect(
      softDegradeInFailedEnvelope({ status: "FAILED", error: text, output: { ok: false, detail: text } }),
    ).toBeNull();
  });

  it.each(MISSED_WORDINGS)("FAILED envelope with the wording ONLY at the top level: %s", (text) => {
    // `softDegradeInFailedEnvelope` checks the envelope error as well as the door's reason, because
    // RunPod lifts a bare `error` to the top level. Both arms have to see it.
    expect(
      softDegradeInFailedEnvelope({ status: "FAILED", error: text, output: { ok: false } }),
    ).toBeNull();
  });

  it("the control still degrades, so the guard is not simply refusing everything", () => {
    const output = { ok: false, detail: "no detectable face in clip" };
    expect(softDegradeInCompletedOutput(output)).toBe("no detectable face in clip");
    expect(csamRefusalInCompletedOutput(output)).toBeNull();
    expect(
      softDegradeInFailedEnvelope({ status: "FAILED", error: "upscale produced zero bytes", output: { ok: false } }),
    ).toBe("upscale produced zero bytes");
  });
});
