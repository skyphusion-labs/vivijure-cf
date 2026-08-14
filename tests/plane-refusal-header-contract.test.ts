// Pin the plane-refusal header string that this repo READS and the control plane EMITS (cf#403).
//
// THE DEFECT THIS EXISTS TO PREVENT. The same wire header is a string literal in two repositories
// with no shared package and no cross-repo CI fetch. A rename on either side without the other
// restores the forever-pend that cf#398 closed: planeRefusalReason() returns null, every module
// falls through to pending, no error surfaces. Behavioural suites in this repo (cf#398) construct
// refusals with THIS side's constant, so they stay green while the plane still speaks the old name.
//
// THE CONTROL. Both repos pin the exact same literal in their own unit suite. Renaming either
// constant without updating its pin fails that repo's CI. Renaming both pins to different values
// is a deliberate dual-repo edit; that is the remaining process cost of not sharing a package.
// The plane pin lives at vivijure-control-plane/tests/plane-refusal-header-contract.test.ts.
//
// This imports the REAL export. A second local "x-vivijure-plane-refusal" here would re-create the
// gap: the suite could pass while modules/_shared/runpod-route.ts had already moved.

import { describe, it, expect } from "vitest";
import { PLANE_REFUSAL_HEADER } from "../modules/_shared/runpod-route";

/** Byte-equal to vivijure-control-plane `PLANE_REFUSAL_HEADER` in src/runpod-proxy-poll.ts. */
const CONTRACTED_PLANE_REFUSAL_HEADER = "x-vivijure-plane-refusal";

describe("plane-refusal header wire contract (cf#403)", () => {
  it("exports PLANE_REFUSAL_HEADER equal to the contracted literal the plane emits", () => {
    expect(PLANE_REFUSAL_HEADER).toBe(CONTRACTED_PLANE_REFUSAL_HEADER);
  });

  it("is the exact header name, not a reason value or a longer prefix", () => {
    // Guards against accidental "x-vivijure-plane-refusal:" or a reason baked into the name.
    expect(PLANE_REFUSAL_HEADER).toMatch(/^x-[a-z0-9-]+$/);
    expect(PLANE_REFUSAL_HEADER.includes(":")).toBe(false);
    expect(PLANE_REFUSAL_HEADER.length).toBeLessThan(64);
  });
});
