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

describe("the reason addresses THIS host's reader (local#226, guarded symmetrically)", () => {
  // WHY THIS EXISTS, and it is not symmetry for its own sake. The self-host panel's copy of this
  // reason names VIDEO_FINISH_URL, because there the reader OWNS the machine. Its test pins that,
  // and pins the tenant phrasing ABSENT. This side had no reader assertion at all, which made the
  // guard one-sided in the dangerous direction: someone "harmonising" the two panels would most
  // naturally copy the LOCAL string here (it is the more informative one), local's test would still
  // pass untouched, and nothing on this side would object -- leaving a hosted TENANT told to set an
  // env var they have no access to. That is the local#226 defect mirrored, and the undefended
  // direction was the one that fails silently. Caught by Joan reading the two suites side by side.
  it("names NO host env var: a hosted tenant has no host to configure", () => {
    expect(VIDEO_FINISH_UNAVAILABLE_REASON).not.toMatch(/VIDEO_FINISH_URL/);
    // Any "Set FOO_BAR" instruction is the same defect wearing a different variable name.
    expect(VIDEO_FINISH_UNAVAILABLE_REASON).not.toMatch(/\bSet [A-Z][A-Z0-9_]+/);
  });

  it("still says what the tenant DOES get, so 'unavailable' cannot read as 'broken'", () => {
    expect(VIDEO_FINISH_UNAVAILABLE_REASON).toMatch(/per-shot clips/);
  });

  // NOT asserted here, deliberately: a positive /Ask whoever operates this studio/ match, which is
  // the convention cf's plan.enhance reason follows. This string carries no action clause today,
  // and whether it should is a COPY decision on a pinned string rather than a test decision --
  // raised with the lead rather than changed under a test. If it gains one, this is where the
  // positive assertion belongs, and the guard closes from both ends instead of only blocking the
  // wrong string.
  //
  // WHY NEGATIVE AND PATTERN-BASED RATHER THAN A BYTE-FOR-BYTE PIN (the local#236 lesson): the
  // wording above is still an open design question, bundled with cf#229 / cf#234. A pin on the
  // exact string would make this test FAIL the very decision it is waiting for, which is precisely
  // how local#236's identity pin ended up defending a bug instead of catching it. A guard should
  // forbid the failure, not fix the wording.
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
