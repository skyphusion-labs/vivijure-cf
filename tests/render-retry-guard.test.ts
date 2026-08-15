import { describe, it, expect, vi, beforeEach } from "vitest";

// cf#423 -- THE RETRYABLE STATUS GUARD.
//
// src/render-retry.ts is 144 lines with a GPU submit at the end of it and, until this file, no
// tests at all. `RETRYABLE = new Set(["FAILED", "CANCELLED", "TIMED_OUT"])` is the ONLY thing
// standing between a POST to /api/storyboard/renders/:id/retry and a second full film job for a
// render that is still running. Widening that set -- by edit, by merge, or by a refactor that
// reaches for a looser "not COMPLETED" predicate -- left the entire suite green.
//
// What makes this file a guard rather than a decoration:
//
//   1. THE POPULATION IS COMPILER-DERIVED. STATUS_EXPECTATION is a Record keyed on core's
//      RunpodStatus union, so a seventh status added upstream fails `npm run typecheck` (the CI
//      gate) until someone decides whether it may be retried. A hand-written array would silently
//      not cover it, which is the same defect as the spend list this PR also fixes.
//   2. IT ASSERTS WHICH REFUSAL FIRED, NOT MERELY THAT ONE DID. retryFailedRender has several
//      refusal paths (no keyframe module, no motion backend, no keyframes on the row, empty
//      bundle). Asserting only `ok: false` is satisfied by ALL of them, so a deleted status guard
//      would still look refused. Each refusal row therefore requires the 400 AND the diagnostic
//      naming the offending status.
//   3. IT ASSERTS NOTHING WAS SUBMITTED. A refusal that still dispatched work is the failure this
//      guard exists to prevent, and a status code cannot report it. startFilmJob and
//      animateFromPreview are spied; both must be called ZERO times on a refusal.
//   4. IT CARRIES A POSITIVE CONTROL. The three terminal statuses must get PAST the guard. Without
//      that row, a guard that refused everything unconditionally would pass every assertion here.

const h = vi.hoisted(() => ({ film: 0, animate: 0 }));

vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async () => {
      h.film += 1;
      return { film_id: "f", phase: "keyframe", scenes: [], project: "p", created_at: 0 };
    }),
  };
});

vi.mock("../src/finalize-from-keyframes", async (orig) => {
  const actual = await orig<typeof import("../src/finalize-from-keyframes")>();
  return {
    ...actual,
    animateFromPreview: vi.fn(async () => {
      h.animate += 1;
      return { ok: true, view: {} };
    }),
  };
});

import { retryFailedRender } from "../src/render-retry";
import type { RunpodStatus } from "@skyphusion-labs/vivijure-core/runpod-submit";

// COMPILER-DERIVED POPULATION. A Record over the union is exhaustive: add a status to core's
// RunpodStatus and this object stops typechecking until it is classified here.
const STATUS_EXPECTATION: Record<RunpodStatus, "retryable" | "refused"> = {
  // Terminal failures. Re-submitting these is the whole point of the route.
  FAILED: "retryable",
  TIMED_OUT: "retryable",
  // NOTE (cf#423): CANCELLED is retryable in the SHIPPED code and this row pins that behaviour as
  // it stands today, deliberately -- this file is a guard against silent drift, not a place to
  // change the contract. Whether CANCELLED BELONGS in the retryable set is a separate open
  // question: modules/keyframe (cf#298) documents CANCELLED as a status RunPod books on jobs that
  // ran to completion and wrote their artifacts, in which case retrying one re-spends GPU on work
  // that already succeeded. Raised for a ruling; not changed here.
  CANCELLED: "retryable",
  // Non-terminal. A retry here dispatches a SECOND job for work that is still in flight.
  IN_QUEUE: "refused",
  IN_PROGRESS: "refused",
  COMPLETED: "refused",
};

const REFUSED = (Object.keys(STATUS_EXPECTATION) as RunpodStatus[]).filter(
  (s) => STATUS_EXPECTATION[s] === "refused",
);
const RETRYABLE_STATUSES = (Object.keys(STATUS_EXPECTATION) as RunpodStatus[]).filter(
  (s) => STATUS_EXPECTATION[s] === "retryable",
);

function row(status: string) {
  return {
    id: 1,
    public_id: "r-1",
    project: "p",
    status,
    mode: "full",
    bundle_key: "bundles/p/b.zip",
    quality_tier: "final",
    keyframes: [],
    render_overrides: null,
  } as never;
}

const env = {} as never;

describe("cf#423 -- retryFailedRender status guard", () => {
  beforeEach(() => {
    h.film = 0;
    h.animate = 0;
  });

  it("HARNESS FLOOR: both populations are non-empty", () => {
    // A zero on either side makes the corresponding block below vacuous.
    console.log(
      `[cf423] status population: ${Object.keys(STATUS_EXPECTATION).length} total, ` +
        `${RETRYABLE_STATUSES.length} retryable (${RETRYABLE_STATUSES.join(",")}), ` +
        `${REFUSED.length} refused (${REFUSED.join(",")})`,
    );
    expect(RETRYABLE_STATUSES.length).toBeGreaterThan(0);
    expect(REFUSED.length).toBeGreaterThan(0);
  });

  for (const status of REFUSED) {
    it(`REFUSES ${status} with the status diagnostic, and submits nothing`, async () => {
      const r = await retryFailedRender(env, row(status));
      expect(r.ok).toBe(false);
      if (r.ok) return;
      // The DIAGNOSTIC, not just the status: several other refusal paths also return 400.
      expect(r.status).toBe(400);
      expect(r.error).toContain("only FAILED / CANCELLED / TIMED_OUT rows can be retried");
      expect(r.error).toContain(status);
      // The assertion that actually protects the wallet.
      expect(h.film, `startFilmJob was called for a ${status} row`).toBe(0);
      expect(h.animate, `animateFromPreview was called for a ${status} row`).toBe(0);
    });
  }

  for (const status of RETRYABLE_STATUSES) {
    it(`POSITIVE CONTROL: ${status} gets PAST the status guard`, async () => {
      // Proves the guard discriminates. Without this, a guard that refused every status would
      // satisfy every REFUSED row above. This row does not assert a successful submit -- the env
      // has no modules installed, so it refuses further down for a DIFFERENT, named reason -- it
      // asserts only that the refusal is no longer the STATUS one.
      const r = await retryFailedRender(env, row(status));
      if (!r.ok) {
        expect(r.error).not.toContain("only FAILED / CANCELLED / TIMED_OUT rows can be retried");
      }
    });
  }
});
