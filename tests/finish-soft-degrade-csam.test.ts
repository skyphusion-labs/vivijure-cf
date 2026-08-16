import { describe, expect, it } from "vitest";
import {
  csamRefusalInCompletedOutput,
  isCsamRefusalReason,
  softDegradeInCompletedOutput,
  softDegradeInFailedEnvelope,
} from "../modules/_shared/finish-soft-degrade";

// cf#595: a CSAM door return is structured ok:false, which is the same shape as a
// polish miss. The discriminator must not absorb it. A no-face degrade is the control.

describe("isCsamRefusalReason", () => {
  it("matches the house needle, case-insensitive", () => {
    expect(isCsamRefusalReason("csam detected")).toBe(true);
    expect(isCsamRefusalReason("CSAM child sexual content")).toBe(true);
    expect(isCsamRefusalReason("no detectable face in clip")).toBe(false);
    expect(isCsamRefusalReason("wall-clock guard expired after 900s")).toBe(false);
    expect(isCsamRefusalReason("")).toBe(false);
    expect(isCsamRefusalReason(undefined)).toBe(false);
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
