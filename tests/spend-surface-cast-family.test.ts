import { describe, it, expect } from "vitest";
import { isSpendRoute } from "../src/rate-limit";
import { API_ROUTES } from "../src/index";

// fc#2250 item 3 -- THE CAST-FAMILY SPEND SURFACE, DERIVED FROM THE ROUTER.
//
// `POST /api/cast/:id/voice-sample` invokes a paid `motion.backend` (src/cast-voice-sample.ts
// startCastVoiceSample -> invokeModule with hook "motion.backend"; Seedance by default, and the
// caller picks Veo / Kling / any installed talking door via `motion_backend`). It reached `main`
// in neither `SPEND_PATTERNS` nor core's storage-submit list, so a consumer token could loop
// `{"seconds":10}` for unlimited paid video jobs: no rate limiter, no daily ceiling, no quota.
//
// WHY A NEW FILE RATHER THAN A LINE IN AN EXISTING ONE. Two tests already existed over this
// surface and NEITHER could see this route, which is the finding:
//
//   * tests/spend-surface-render-children.test.ts derives its population from API_ROUTES, which is
//     the right shape, but scopes it to the `/api/storyboard/renders/:id/*` prefix with a stated
//     reason. A cast route is out of that population BY CONSTRUCTION, so that file passes green
//     while the cast family drifts. This file is the same instrument pointed at the family where
//     the defect actually occurred.
//   * tests/rate-limit.test.ts asserts against a TRANSCRIBED array of paths, which cannot fail for
//     a route nobody thought of -- it re-encodes the same hand-written enumeration whose drift is
//     the defect.
//
// tests/render-door-ledger.test.ts also lists this route in its `NOT_DOORS` set, and that entry is
// CORRECT and deliberately left alone: `NOT_DOORS` there means "not one of the eight film-render
// doors that go through core's three start functions", which voice-sample genuinely is not (it
// invokes a module directly and starts no film job). Spend metering and render-door capability are
// different taxonomies; conflating them is how a route ends up exempted from the wrong list.
//
// Properties this file is built to have, mirroring cf#423 because a list-versus-list check is
// otherwise trivially vacuous:
//
//   1. DERIVED, NOT TRANSCRIBED. The population comes from API_ROUTES. A cast-child POST route
//      added later is in neither bucket and fails here until it is classified.
//   2. A PRINTED DENOMINATOR. Every assertion reports `n of m`, so a matcher that silently
//      extracts zero rows is a HARNESS failure rather than a clean pass.
//   3. DECLARED NON-SPEND WITH A REASON, each one stated, so an omission and a deliberate
//      exclusion never look the same.
//   4. A DISCRIMINATION CONTROL. The non-spend routes must NOT be metered, so a matcher that
//      answered true for everything under the prefix fails instead of passing everything.
//   5. AN EXACT PARTITION, BOTH DIRECTIONS, so a pattern that goes dead through a rename fails as
//      loudly as a route that was never added.

// The cast-child POST routes that dispatch no GPU and no paid model call. Stated with reasons.
//
// NOTE the deliberate distinction these reasons turn on: a route that writes caller-supplied BYTES
// is metered by the STORAGE ceiling (core's STORAGE_SUBMIT_PATTERNS), not by the spend limiter,
// which exists for GPU / paid-model submits. Both of those meters matter and they are separate
// lists; this file is only about the second one.
const NOT_SPEND: Record<string, string> = {
  "/api/cast/:id/portrait":
    "stores caller-supplied bytes (or copies one served artifact); dispatches no module and starts no job. Metered by the storage ceiling.",
  "/api/cast/:id/ref":
    "stores caller-supplied reference bytes; dispatches nothing. Metered by the storage ceiling.",
  "/api/cast/:id/source":
    "stores caller-supplied source bytes; dispatches nothing. Metered by the storage ceiling.",
  "/api/cast/:id/voice-sample/keep":
    "points the cast row at a clip the already-metered sample run produced; generates nothing new.",
  "/api/cast/:id/voice-sample/attach":
    "stores a clip the filmmaker already has (up to 32MB); dispatches no module. Metered by the storage ceiling.",
};

const PREFIX = "/api/cast/:id/";

/** Concrete path for a pattern, so isSpendRoute sees what the router would have matched. */
function concrete(pattern: string): string {
  return pattern.replace(":id", "7");
}

const castChildren = API_ROUTES.filter(
  (r) => r.method === "POST" && r.pattern.startsWith(PREFIX),
).map((r) => r.pattern);

describe("fc#2250 item 3 -- every cast-child POST route is classified for spend", () => {
  it("HARNESS FLOOR: the derived population is non-empty and plausible", () => {
    // A zero here means the extraction broke, not that the studio has no cast-child routes.
    // Without this floor every assertion below passes vacuously on an empty array.
    console.log(
      `[fc2250] derived ${castChildren.length} cast-child POST routes from ${API_ROUTES.length} API_ROUTES:`,
      castChildren.slice().sort().join(" "),
    );
    expect(castChildren.length).toBeGreaterThanOrEqual(8);
  });

  it("classifies every cast-child POST route as spend or declared-non-spend", () => {
    const metered = castChildren.filter((p) => isSpendRoute("POST", concrete(p)));
    const declared = castChildren.filter((p) => p in NOT_SPEND);
    const unclassified = castChildren.filter(
      (p) => !isSpendRoute("POST", concrete(p)) && !(p in NOT_SPEND),
    );
    console.log(
      `[fc2250] classified ${metered.length + declared.length} of ${castChildren.length} ` +
        `(metered=${metered.length} declared-non-spend=${declared.length} unclassified=${unclassified.length})`,
    );
    expect(
      unclassified,
      `cast-child POST route(s) reach the router but are neither in SPEND_PATTERNS nor declared ` +
        `in NOT_SPEND with a reason. If the route dispatches GPU or paid model work, add it to ` +
        `SPEND_PATTERNS in src/rate-limit.ts. If it dispatches nothing, add it to NOT_SPEND here ` +
        `with the reason why: ${unclassified.join(", ")}`,
    ).toEqual([]);
    expect(metered.length + declared.length).toBe(castChildren.length);
  });

  it("does NOT meter the declared non-spend routes (the discrimination control)", () => {
    // If isSpendRoute answered true for everything under this prefix, every other assertion in
    // this file would still pass. This is the row that can only be green if it discriminates.
    const wronglyMetered = Object.keys(NOT_SPEND).filter((p) => isSpendRoute("POST", concrete(p)));
    console.log(
      `[fc2250] declared non-spend: ${Object.keys(NOT_SPEND).length}, wrongly metered: ${wronglyMetered.length}`,
    );
    expect(Object.keys(NOT_SPEND).length).toBeGreaterThan(0);
    expect(wronglyMetered).toEqual([]);
  });

  it("every declared non-spend route is actually registered (no dead declarations)", () => {
    // A NOT_SPEND entry for a route that no longer exists is a stale exemption that would silently
    // absolve a future route of the same name.
    const orphaned = Object.keys(NOT_SPEND).filter((p) => !castChildren.includes(p));
    expect(
      orphaned,
      `NOT_SPEND names route(s) the router does not register: ${orphaned.join(", ")}`,
    ).toEqual([]);
  });

  it("meters /voice-sample specifically, and only under POST (fc#2250 regression)", () => {
    // The route this file was written for. startCastVoiceSample invokes a paid motion.backend.
    expect(isSpendRoute("POST", "/api/cast/7/voice-sample")).toBe(true);
    // GET is the poll and DELETE clears the row; neither spends.
    expect(isSpendRoute("GET", "/api/cast/7/voice-sample")).toBe(false);
  });

  it("does not match near-miss voice-sample paths (matcher anchoring)", () => {
    // /keep and /attach must NOT be caught by the new pattern: they are declared non-spend above,
    // so an unanchored regex would quietly contradict this file's own partition.
    expect(isSpendRoute("POST", "/api/cast/7/voice-sample/keep")).toBe(false);
    expect(isSpendRoute("POST", "/api/cast/7/voice-sample/attach")).toBe(false);
    expect(isSpendRoute("POST", "/api/cast/7/voice-samplex")).toBe(false);
    expect(isSpendRoute("POST", "/api/cast/7/voice-sample/")).toBe(false);
    expect(isSpendRoute("POST", "/api/cast/voice-sample")).toBe(false);
  });
});
