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
  VIDEO_FINISH_ADVISORY_HOOKS,
  VIDEO_FINISH_CAPABILITY_KEY,
  VIDEO_FINISH_GATED_HOOKS,
  VIDEO_FINISH_UNAVAILABLE_REASON,
  VIDEO_FINISH_UNPROVISIONABLE_REASON,
  videoFinishHooksUnavailable,
  videoFinishReason,
  videoFinishState,
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
  it("names EXACTLY what is unavailable, no more (cf#229: score is NOT)", () => {
    // master: enterMasterOrMux runs AFTER assemble, and assemble degrades to done, so it never
    // runs. film.finish + notify: both driven from transitionToDone, which degradeAssembleUnavailable
    // bypasses -- they never run either. capability:video-finish: the binding itself, which is the
    // thing actually absent and the only honest key for a control that does nothing but mux.
    //
    // score is ABSENT from this set on purpose and that is the whole of cf#229: bed generation
    // (src/score-bed.ts) touches no VPC binding and the film path never calls the score hook at all,
    // so reporting it unavailable claims more than the truth and would grey out a working control.
    expect(Object.keys(videoFinishHooksUnavailable({ VIDEO_FINISH_URL: undefined } as never)).sort()).toEqual(
      ["capability:video-finish", "film.finish", "master", "notify"],
    );
    expect([...VIDEO_FINISH_GATED_HOOKS].sort()).toEqual(["film.finish", "master", "notify"]);
  });

  it("REGRESSION GUARD (cf#229): score is never reported unavailable", () => {
    // The named failure, not a wording: a studio that can generate a bed must never be told it
    // cannot serve score. This is the assertion that fails if someone folds the advisory hooks back
    // into the gated set to simplify them.
    const named = Object.keys(videoFinishHooksUnavailable({ VIDEO_FINISH_URL: undefined } as never));
    for (const advisory of VIDEO_FINISH_ADVISORY_HOOKS) {
      expect(named, advisory + " RUNS on a VPC-less studio; only its delivery is dead").not.toContain(advisory);
    }
    expect([...VIDEO_FINISH_ADVISORY_HOOKS]).toEqual(["score"]);
  });

  it("the capability key can never be mistaken for a hook name", () => {
    // Hook names use dots (film.finish, motion.backend, plan.enhance). The capability namespace uses
    // a colon precisely so no module can ever declare it and no reader can mistake it for something
    // a module provides. If this fails, the two namespaces have started to collide.
    expect(VIDEO_FINISH_CAPABILITY_KEY).toMatch(/^capability:/);
    for (const hook of [...VIDEO_FINISH_GATED_HOOKS, ...VIDEO_FINISH_ADVISORY_HOOKS]) {
      expect(hook).not.toContain(":");
    }
  });

  it("does NOT name the per-shot hooks, which are exactly what a VPC-less host still delivers", () => {
    const named = Object.keys(videoFinishHooksUnavailable({ VIDEO_FINISH_URL: undefined } as never));
    for (const survives of ["keyframe", "motion.backend", "finish", "speech", "dialogue", "image.generate", "cast.image"]) {
      expect(named, `${survives} still works on a clips delivery`).not.toContain(survives);
    }
  });

  it("reports NOTHING when the tier is bound (absent key means available)", () => {
    expect(videoFinishHooksUnavailable({ VIDEO_FINISH_URL: "https://video-finish.skyphusion.org" })).toEqual({});
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

  // ROLLINS' PROPERTY, restored from the closed #236: the guard was one-sided in a second way.
  // It blocked the string becoming WRONG for this reader, and said nothing about it becoming
  // USELESS. Without this, "Video finishing is not yet provisioned for this studio; finished
  // renders deliver as per-shot clips." can be shortened to "Video finishing is not available."
  // and nothing objects -- which is exactly "unavailable" degrading into something that reads as
  // "broken". The honest-degrade doctrine lives on the difference between "you got less" and "it
  // failed", and nothing was guarding it.
  //
  // ASSERTS THE PROPERTY, NOT THE PHRASE, deliberately, and this is a correction to the version
  // in #236 rather than a copy of it. #236 matched the literal /per-shot clips/. The wording here
  // is an open design question (cf#229 / cf#234, now with cp#112 as an input: a THIRD state exists
  // for tenants who can never get the tier without a re-upload path, so this sentence is likely to
  // be rewritten). Checked against plausible rewordings: the literal phrase fails two of three
  // ("individual shot clips", "separate clips, one per shot"), while every one of them still names
  // the clips. Pinning the phrase would make this test fail the decision it is waiting for -- the
  // same trap as local#236's identity pin. A guard should forbid the failure, not fix the wording.
  it("still says what the tenant DOES get, so 'unavailable' cannot read as 'broken'", () => {
    expect(VIDEO_FINISH_UNAVAILABLE_REASON).toMatch(/clips/);
  });
});

describe("GET /api/modules projection", () => {
  it("carries the reason VERBATIM for every gated hook when the tier is unbound", async () => {
    const body = await modulesBody(env());
    const host = body.host as { hooks_unavailable?: Record<string, string> };
    expect(host?.hooks_unavailable, JSON.stringify(body.host)).toBeDefined();
    for (const key of [VIDEO_FINISH_CAPABILITY_KEY, ...VIDEO_FINISH_GATED_HOOKS]) {
      expect(host.hooks_unavailable![key]).toBe(VIDEO_FINISH_UNAVAILABLE_REASON);
    }
  });

  it("POSITIVE CONTROL: a host that BINDS the tier reports no video-finish hook at all", async () => {
    const body = await modulesBody(env({ VIDEO_FINISH_URL: { fetch: async () => new Response("ok") } }));
    const host = body.host as { hooks_unavailable?: Record<string, string> };
    for (const key of [VIDEO_FINISH_CAPABILITY_KEY, ...VIDEO_FINISH_GATED_HOOKS]) {
      expect(host?.hooks_unavailable?.[key], key + " must not be reported on a bound host").toBeUndefined();
    }
  });

  it("MERGES with the AI-gateway gate rather than replacing it (cf#98 stays one channel)", async () => {
    // No AI gateway AND no video-finish: the host must report both, not whichever was computed last.
    const body = await modulesBody(env());
    const host = body.host as { hooks_unavailable?: Record<string, string> };
    expect(Object.keys(host.hooks_unavailable ?? {}).sort()).toEqual(
      ["capability:video-finish", "film.finish", "master", "notify", "plan.enhance"],
    );
  });
});

describe("the third state (cf#240 lane D, input cp#112; copy swapped cf#243)", () => {
  // cp#112 established that the tier reached studios provisioned AFTER the knob was set and nobody
  // else, which is why "not yet provisioned" was a promise the plane could not keep for them and
  // why this is a THIRD state rather than a binary. cp#112 then SHIPPED the re-upload path
  // (refresh-studio-bindings, plane v1.8.0), collapsing that population back into `provisionable`,
  // so what `unprovisionable` now names is a studio the PLANE declares unreachable. The copy is
  // swapped as of cf#243; the sentences and their properties are asserted at the bottom.
  it("a bound tier is available, and available has no sentence at all", () => {
    expect(videoFinishState({ VIDEO_FINISH_URL: "https://video-finish.skyphusion.org" })).toBe("available");
    expect(videoFinishReason("available")).toBeNull();
  });

  it("an unbound tier defaults to provisionable, which is what lane A makes true for everyone", () => {
    expect(videoFinishState({ VIDEO_FINISH_URL: undefined } as never)).toBe("provisionable");
  });

  it("an operator/plane can declare the studio unreachable by any operator action", () => {
    expect(
      videoFinishState({ VIDEO_FINISH_URL: undefined, VIDEO_FINISH_TIER_STATE: "unprovisionable" } as never),
    ).toBe("unprovisionable");
  });

  it("an OBSERVATION beats a label: a bound tier is available whatever the var says", () => {
    // The failure this forbids is a stale var outliving the provisioning it described, with the
    // panel then telling a studio that HAS a working tier that it has none.
    expect(
      videoFinishState({ VIDEO_FINISH_URL: "https://video-finish.skyphusion.org", VIDEO_FINISH_TIER_STATE: "unprovisionable" } as never),
    ).toBe("available");
  });

  it("an unrecognised var value falls back to the default rather than inventing a state", () => {
    expect(
      videoFinishState({ VIDEO_FINISH_URL: undefined, VIDEO_FINISH_TIER_STATE: "banana" } as never),
    ).toBe("provisionable");
  });

  it("EVERY state's sentence obeys the tenant-reader properties, not just today's", () => {
    // Property, never phrase (#239): the copy swap is coming, and a guard that pinned bytes would
    // fail the very decision it is waiting for. What must hold under ANY rewrite: never instruct a
    // tenant to set a host env var, and always say what they DO get.
    for (const state of ["provisionable", "unprovisionable"] as const) {
      const reason = videoFinishReason(state);
      expect(reason, state).toBeTruthy();
      expect(reason!, state).not.toMatch(/VIDEO_FINISH_URL|Set [A-Z_]+/);
      expect(reason!, state).toMatch(/clips/);
    }
  });

  it("the two sentences DIVERGE now, and the unreachable one makes no promise nobody can keep", () => {
    // The swap this replaced (cf#243). It was held identical while cp#112 was open, because a
    // re-upload path collapses `unprovisionable` back into `provisionable`; cp#112 shipped exactly
    // that path, so what is left in this state is a studio the PLANE declares unreachable.
    expect(VIDEO_FINISH_UNPROVISIONABLE_REASON).not.toBe(VIDEO_FINISH_UNAVAILABLE_REASON);
    // "not yet" is the promise word: correct where somebody can keep it, wrong where nobody can.
    expect(VIDEO_FINISH_UNAVAILABLE_REASON).toMatch(/not yet/i);
    expect(VIDEO_FINISH_UNPROVISIONABLE_REASON).not.toMatch(/not yet/i);
    // and it must not send the reader to an operator who cannot act either.
    expect(VIDEO_FINISH_UNPROVISIONABLE_REASON).not.toMatch(/ask |operator|whoever operates/i);
  });

  it("the swap reaches NOBODY until the plane writes the var, and nothing writes it yet", () => {
    // Census 2026-07-25 (CF-side third credential, D1-side admin surface, agreeing): binding+channel
    // 0, channel-only 0, neither 1 (the rollins-e2e testbed, refreshed + bytes move queued). Every
    // studio with no binding and no var resolves to `provisionable`, so this asserts the sentence
    // above is unreachable in production rather than merely unused. The panel is honest either way;
    // what makes the estate honest is the bindings refresh and the bytes move, not this constant.
    expect(videoFinishState({ VIDEO_FINISH_URL: undefined } as never)).toBe("provisionable");
    expect(videoFinishReason("provisionable")).toBe(VIDEO_FINISH_UNAVAILABLE_REASON);
  });
});
