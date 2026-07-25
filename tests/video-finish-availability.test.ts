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

describe("the reason addresses THIS panel's reader (local#226, mirrored)", () => {
  // local#226 established that parity is the SET and the BIAS, never the BYTES: the two panels
  // deliberately word this differently because the reader is a different person. vivijure-local's
  // copy of this file guards its own side (it must NAME the operator's knob, VIDEO_FINISH_URL, and
  // must NOT say "ask whoever operates this studio"). This is the missing mirror.
  //
  // WHY THIS DIRECTION IS THE DANGEROUS ONE. The local string is the more informative of the two,
  // so the natural future tidy-up is to copy it HERE, to "make the panels consistent". Local's
  // guard would pass unchanged (local is untouched) and, without this assertion, nothing on the
  // hosted side would object -- so a paying TENANT would be told to set VIDEO_FINISH_URL, an
  // environment variable on a host they have no access to. That is exactly the defect local#226
  // fixed, pointed at the other panel.
  //
  // The assertion is deliberately NEGATIVE and pattern-based rather than a byte-for-byte pin: the
  // wording here is still an open design question (bundled with cf#229 / cf#234, on whether this
  // panel's convention should also name the tenant's action). Pinning the exact string would make
  // this test fail the very decision it is waiting for -- the failure mode that made local#236's
  // identity pin defend a bug. This forbids the one thing that is wrong under any of those
  // outcomes: telling a hosted tenant to set a host environment variable.
  it("never instructs a hosted tenant to set a host environment variable", () => {
    expect(VIDEO_FINISH_UNAVAILABLE_REASON).not.toMatch(/VIDEO_FINISH_URL|Set [A-Z_]+/);
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
