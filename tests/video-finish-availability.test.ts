// cf#118: the host reports which hooks the video-finish tier takes down with it.
//
// BOTH DIRECTIONS ARE TESTED, per cf#98. A negative-only suite over a capability that is dead
// everywhere passes without proving anything, so the BOUND case is asserted too: a host that binds
// the tier must report the field ABSENT, which is the panel's positive control (its controls light
// up because the host said nothing, not because nobody set a field).
//
// The SET is the contract with the panel, so it is asserted exactly rather than by containment:
// naming too few hooks leaves buttons that cannot deliver, naming too many hides capability that
// works, and only an exact assertion catches the second one.

import { describe, expect, it } from "vitest";
import worker from "../src/index";
import {
  VIDEO_FINISH_GATED_HOOKS,
  VIDEO_FINISH_UNAVAILABLE_REASON,
  videoFinishHooksUnavailable,
} from "../src/video-finish-availability";

const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

function env(over: Record<string, unknown> = {}): Parameters<typeof worker.fetch>[1] {
  return {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("asset") },
    ...over,
  } as unknown as Parameters<typeof worker.fetch>[1];
}

async function modulesBody(e: Parameters<typeof worker.fetch>[1]): Promise<Record<string, unknown>> {
  const res = await worker.fetch(new Request("https://studio.example/api/modules"), e, ctx);
  return (await res.json()) as Record<string, unknown>;
}

describe("videoFinishHooksUnavailable", () => {
  it("names EXACTLY the hooks the execution paths take down, no more", () => {
    // score + master: their product (the audio bed) can only reach the film through the mux, which
    // is downstream of an assemble that degrades. film.finish + notify: both are driven from
    // transitionToDone, which degradeAssembleUnavailable bypasses -- they never run at all.
    expect(Object.keys(videoFinishHooksUnavailable({ VIDEO_FINISH_VPC: undefined } as never)).sort()).toEqual(
      ["film.finish", "master", "notify", "score"],
    );
    expect([...VIDEO_FINISH_GATED_HOOKS].sort()).toEqual(["film.finish", "master", "notify", "score"]);
  });

  it("does NOT name the per-shot hooks, which are exactly what a VPC-less host still delivers", () => {
    const named = Object.keys(videoFinishHooksUnavailable({ VIDEO_FINISH_VPC: undefined } as never));
    for (const survives of ["keyframe", "motion.backend", "finish", "speech", "dialogue", "image.generate", "cast.image"]) {
      expect(named, `${survives} still works on a clips delivery`).not.toContain(survives);
    }
  });

  it("reports NOTHING when the tier is bound (absent key means available)", () => {
    expect(videoFinishHooksUnavailable({ VIDEO_FINISH_VPC: {} as never })).toEqual({});
  });
});

describe("GET /api/modules projection", () => {
  it("carries the reason VERBATIM for every gated hook when the tier is unbound", async () => {
    const body = await modulesBody(env());
    const host = body.host as { hooks_unavailable?: Record<string, string> };
    expect(host?.hooks_unavailable, JSON.stringify(body.host)).toBeDefined();
    for (const hook of VIDEO_FINISH_GATED_HOOKS) {
      expect(host.hooks_unavailable![hook]).toBe(VIDEO_FINISH_UNAVAILABLE_REASON);
    }
  });

  it("POSITIVE CONTROL: a host that BINDS the tier reports no video-finish hook at all", async () => {
    const body = await modulesBody(env({ VIDEO_FINISH_VPC: { fetch: async () => new Response("ok") } }));
    const host = body.host as { hooks_unavailable?: Record<string, string> };
    for (const hook of VIDEO_FINISH_GATED_HOOKS) {
      expect(host?.hooks_unavailable?.[hook], `${hook} must not be reported on a bound host`).toBeUndefined();
    }
  });

  it("MERGES with the AI-gateway gate rather than replacing it (cf#98 stays one channel)", async () => {
    // No AI gateway AND no video-finish: the host must report both, not whichever was computed last.
    const body = await modulesBody(env());
    const host = body.host as { hooks_unavailable?: Record<string, string> };
    expect(Object.keys(host.hooks_unavailable ?? {}).sort()).toEqual(
      ["film.finish", "master", "notify", "plan.enhance", "score"],
    );
  });
});
