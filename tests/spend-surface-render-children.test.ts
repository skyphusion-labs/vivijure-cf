import { describe, it, expect } from "vitest";
import { isSpendRoute } from "../src/rate-limit";
import { API_ROUTES } from "../src/index";

// cf#423 -- THE RENDER-CHILD SPEND SURFACE, DERIVED FROM THE ROUTER.
//
// `SPEND_PATTERNS` in src/rate-limit.ts is a hand-maintained list, and it has now drifted TWICE in
// the same family. cf#256 found three render-child routes (regen-shot, finalize, add-narration)
// dispatching GPU work with no meter; this PR's parent added a fourth, /retry, and did not add it
// to the list either. Both times the list was correct-looking and wrong, and nothing could tell
// anyone, because NO TEST COMPARED THE LIST TO THE ROUTER.
//
// tests/rate-limit.test.ts asserts the list against a TRANSCRIBED array of paths. That test cannot
// fail for a route nobody thought of: it re-encodes the same hand-written enumeration whose drift
// is the defect. This file derives the population from the exported API_ROUTES instead, so a
// render-child route added later lands in neither bucket and fails here until it is classified.
//
// Scope is deliberately the `/api/storyboard/renders/:id/*` family and not every POST route in the
// studio. That family is where this defect has actually occurred, twice; it is small enough to
// enumerate honestly today; and a guard that refuses on the ~60 routes nobody has classified is a
// guard people switch off.
//
// Properties this file is built to have, because a list-versus-list check is otherwise trivially
// vacuous:
//
//   1. DERIVED, NOT TRANSCRIBED. The population comes from API_ROUTES. A new render-child POST
//      route is in neither NOT_SPEND nor the spend set and fails this file.
//   2. A PRINTED DENOMINATOR. Every assertion reports `n of m`. A matcher that silently extracts
//      zero rows is a HARNESS failure here, not a clean pass.
//   3. A DECLARED NON-SPEND WITH A REASON. add-audio is the one render-child POST that dispatches
//      nothing. It is the control that proves isSpendRoute DISCRIMINATES inside this family rather
//      than answering true for everything under the prefix -- without it, a matcher that returned
//      true unconditionally would pass every other assertion in this file.
//   4. AN EXACT PARTITION, BOTH DIRECTIONS. Spend routes must be metered AND non-spend routes must
//      not be, so the guard fails on a pattern that has gone dead (a rename silently un-metering a
//      route) exactly as loudly as on a route that was never added.

// The one render-child POST that submits nothing: it muxes an artifact that already exists. Stated
// here with its reason, so an omission and a deliberate exclusion never look the same.
const NOT_SPEND: Record<string, string> = {
  "/api/storyboard/renders/:id/add-audio":
    "muxes an already-rendered artifact; dispatches no module and starts no job",
};

const PREFIX = "/api/storyboard/renders/:id/";

/** Concrete path for a pattern, so isSpendRoute sees what the router would have matched. */
function concrete(pattern: string): string {
  return pattern.replace(":id", "abc-123");
}

const renderChildren = API_ROUTES.filter(
  (r) => r.method === "POST" && r.pattern.startsWith(PREFIX),
).map((r) => r.pattern);

describe("cf#423 -- every render-child POST route is classified for spend", () => {
  it("HARNESS FLOOR: the derived population is non-empty and plausible", () => {
    // A zero here means the extraction broke, not that the studio has no render-child routes.
    // Without this floor every assertion below passes vacuously on an empty array.
    console.log(
      `[cf423] derived ${renderChildren.length} render-child POST routes from ${API_ROUTES.length} API_ROUTES:`,
      renderChildren.slice().sort().join(" "),
    );
    expect(renderChildren.length).toBeGreaterThanOrEqual(7);
  });

  it("classifies every render-child POST route as spend or declared-non-spend", () => {
    const metered = renderChildren.filter((p) => isSpendRoute("POST", concrete(p)));
    const declared = renderChildren.filter((p) => p in NOT_SPEND);
    const unclassified = renderChildren.filter(
      (p) => !isSpendRoute("POST", concrete(p)) && !(p in NOT_SPEND),
    );
    console.log(
      `[cf423] classified ${metered.length + declared.length} of ${renderChildren.length} ` +
        `(metered=${metered.length} declared-non-spend=${declared.length} unclassified=${unclassified.length})`,
    );
    // The message names the offending routes, so a failure here says WHICH route is unmetered
    // rather than only that a count moved.
    expect(
      unclassified,
      `render-child POST route(s) reach the router but are neither in SPEND_PATTERNS nor declared ` +
        `in NOT_SPEND with a reason. If the route dispatches GPU or paid work, add it to ` +
        `SPEND_PATTERNS in src/rate-limit.ts. If it dispatches nothing, add it to NOT_SPEND here ` +
        `with the reason why: ${unclassified.join(", ")}`,
    ).toEqual([]);
    expect(metered.length + declared.length).toBe(renderChildren.length);
  });

  it("does NOT meter the declared non-spend routes (the discrimination control)", () => {
    // If isSpendRoute answered true for everything under this prefix, every other assertion in
    // this file would still pass. This is the row that can only be green if it discriminates.
    const wronglyMetered = Object.keys(NOT_SPEND).filter((p) => isSpendRoute("POST", concrete(p)));
    console.log(
      `[cf423] declared non-spend: ${Object.keys(NOT_SPEND).length}, wrongly metered: ${wronglyMetered.length}`,
    );
    expect(Object.keys(NOT_SPEND).length).toBeGreaterThan(0);
    expect(wronglyMetered).toEqual([]);
  });

  it("every declared non-spend route is actually registered (no dead declarations)", () => {
    // A NOT_SPEND entry for a route that no longer exists is a stale exemption that would silently
    // absolve a future route of the same name.
    const orphaned = Object.keys(NOT_SPEND).filter((p) => !renderChildren.includes(p));
    expect(orphaned, `NOT_SPEND names route(s) the router does not register: ${orphaned.join(", ")}`).toEqual([]);
  });

  it("meters /retry specifically, and only under POST (cf#423 regression)", () => {
    // The route this file was written for. retryFailedRender calls startFilmJob and
    // animateFromPreview -- the same GPU submit paths as animate-cloud and animate-hybrid.
    expect(isSpendRoute("POST", "/api/storyboard/renders/abc-123/retry")).toBe(true);
    expect(isSpendRoute("GET", "/api/storyboard/renders/abc-123/retry")).toBe(false);
  });

  it("does not match near-miss retry paths (matcher anchoring)", () => {
    expect(isSpendRoute("POST", "/api/storyboard/renders/abc-123/retryx")).toBe(false);
    expect(isSpendRoute("POST", "/api/storyboard/renders/abc-123/retry/")).toBe(false);
    expect(isSpendRoute("POST", "/api/storyboard/renders/abc-123/retry/again")).toBe(false);
    expect(isSpendRoute("POST", "/api/storyboard/renders/retry")).toBe(false);
  });
});
