/// <reference types="node" />
// The core ^1.11.0 bump is LOAD-TEST INFRASTRUCTURE, not a version number.
//
// THE DEFECT IT REMOVES. Before core#176, an all-degraded finish stage and a clean one were
// BYTE-IDENTICAL in the summary the panel reads:
//
//   clean:     { total: 5, done: 5, failed: 0, pending: 0, adopted: 0 }
//   degraded:  { total: 5, done: 5, failed: 0, pending: 0, adopted: 0 }
//
// A soft degrade is a SUCCESS by design (#249/#77: a polish step never fails the chain), so it
// lands in `done` and nothing anywhere counted it. Degradation is precisely what a load test exists
// to surface, and the surface could not express it.
//
// This file pins the capability at the seam cf actually uses. `summarizeFilm` is what
// src/index.ts calls (three sites) to answer the panel, so asserting on it -- rather than on
// summarizeFinish, which cf never imports -- is what makes this a claim about the panel rather than
// about a function that happens to exist.
//
// NON-DEFAULT PROBE: 3 degraded of 5. A one-of-two fixture could be satisfied by a coincidence or a
// hardcoded 1; 3-of-5 cannot be, and it also pins that the count is a COUNT rather than a boolean.

import { describe, it, expect } from "vitest";
import { summarizeFilm } from "@skyphusion-labs/vivijure-core/film-orchestrator";

/** Five finished shots, three of which soft-degraded. All are `done` -- that is the point. */
function jobWithDegrades() {
  const shot = (id: string, degraded?: string) => ({
    shot_id: id,
    clip_key: `renders/p/${id}.mp4`,
    chain: ["MODULE_UPSCALE"],
    idx: 0,
    status: "done" as const,
    applied: degraded ? [`passthrough:${degraded}`] : ["upscale:2x"],
    ...(degraded ? { degraded } : {}),
  });
  return {
    film_id: "f1", project: "p", phase: "finish", scenes: [],
    finish_shots: [
      shot("a"),
      shot("b", "door-run-failed"),
      shot("c"),
      shot("d", "door-token-not-yet-visible"),
      shot("e", "door-unbound-mid-job"),
    ],
  };
}

describe("core ^1.11.0: a degraded finish stage is visible to the panel", () => {
  it("summarizeFilm reports the degraded COUNT on the surface cf actually reads", () => {
    const s = summarizeFilm(jobWithDegrades() as never, null) as unknown as {
      finish?: { total: number; done: number; failed: number; degraded?: number };
    };

    expect(s.finish).toBeDefined();                 // denominator: no finish block means no claim
    // The load-bearing assertion. On core 1.10.0 this field does not exist and reads `undefined`,
    // which is exactly the invisibility this bump removes.
    expect(s.finish!.degraded).toBe(3);

    // and the fields that made it invisible are unchanged, so this is ADDITIVE rather than a
    // reinterpretation of what `done` means
    expect(s.finish!.total).toBe(5);
    expect(s.finish!.done).toBe(5);
    expect(s.finish!.failed).toBe(0);
  });

  it("CONTROL: a clean stage reports ZERO degraded, so the count discriminates", () => {
    // Without this, `degraded: 3` could come from a field that counts something else entirely, or
    // from a constant. A clean job must produce a DIFFERENT answer on the same code path.
    const clean = {
      film_id: "f1", project: "p", phase: "finish", scenes: [],
      finish_shots: [
        { shot_id: "a", clip_key: "k", chain: ["X"], idx: 0, status: "done", applied: ["upscale:2x"] },
        { shot_id: "b", clip_key: "k", chain: ["X"], idx: 0, status: "done", applied: ["upscale:2x"] },
      ],
    };
    const s = summarizeFilm(clean as never, null) as unknown as { finish?: { done: number; degraded?: number } };
    expect(s.finish!.done).toBe(2);
    expect(s.finish!.degraded).toBe(0);
  });

  it("the two states are now DISTINGUISHABLE, which is the whole point of the bump", () => {
    const dirty = summarizeFilm(jobWithDegrades() as never, null) as unknown as { finish?: Record<string, unknown> };
    const clean = summarizeFilm({
      film_id: "f1", project: "p", phase: "finish", scenes: [],
      finish_shots: [{ shot_id: "a", clip_key: "k", chain: ["X"], idx: 0, status: "done", applied: ["upscale:2x"] }],
    } as never, null) as unknown as { finish?: Record<string, unknown> };

    // Before core#176 these differed only in `total`/`done`, so a five-shot all-degraded film and a
    // five-shot clean film were the same object. Assert the discriminating field explicitly rather
    // than inferring it from the pair.
    expect(dirty.finish!.degraded).not.toBe(clean.finish!.degraded);
  });
});
