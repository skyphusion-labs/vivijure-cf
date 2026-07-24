import { describe, expect, it } from "vitest";

import {
  NO_REASON,
  isUnavailable,
  reasonFor,
  unavailableHooks,
  unavailableList,
  type ModulesPayload,
} from "../public/hook-availability-checks.js";

// cf#98. GET /api/storyboard/models is projected from the INSTALLED plan.enhance
// modules, and installed is not servable: a hosted tenant without the AI binding /
// GATEWAY_ID got a full planning-model picker whose every option 500s at hPlan.
// The core now reports what it cannot serve; this normalizes that report.
//
// The bias here is deliberate and asymmetric: junk resolves to "no restriction",
// never to "everything is broken". A parse failure must not black out a working
// studio, which would be a worse bug than the one being fixed.

const payload = (host: unknown): ModulesPayload => ({ modules: [], host } as ModulesPayload);

describe("unavailableHooks", () => {
  it("reads the hooks the host says it cannot serve, with reasons verbatim", () => {
    const map = unavailableHooks(
      payload({
        dispatch: true,
        hooks_unavailable: {
          "plan.enhance": "AI Gateway not configured (AI + GATEWAY_ID)",
        },
      }),
    );
    expect(map).toEqual({ "plan.enhance": "AI Gateway not configured (AI + GATEWAY_ID)" });
  });

  it("is INERT on every deploy that does not report the field", () => {
    // This is today's reality on every studio in the estate, so it is the case that
    // must never regress: no field, no restriction, no behaviour change at all.
    expect(unavailableHooks(payload({ dispatch: true }))).toEqual({});
    expect(unavailableHooks(payload(undefined))).toEqual({});
    expect(unavailableHooks({ modules: [] })).toEqual({});
  });

  it("never blacks out a studio because it could not parse the payload", () => {
    // The asymmetry, asserted. Every one of these is garbage in, and every one
    // yields "no restriction" rather than "nothing works".
    expect(unavailableHooks(null)).toEqual({});
    expect(unavailableHooks(undefined)).toEqual({});
    expect(unavailableHooks("nope" as never)).toEqual({});
    expect(unavailableHooks(payload("nope"))).toEqual({});
    expect(unavailableHooks(payload({ hooks_unavailable: "nope" }))).toEqual({});
    expect(unavailableHooks(payload({ hooks_unavailable: ["plan.enhance"] }))).toEqual({});
    expect(unavailableHooks(payload({ hooks_unavailable: null }))).toEqual({});
  });

  it("still refuses the control when the host gives no readable reason", () => {
    // Unavailable-with-no-reason must NOT degrade into available. We keep the
    // control gated and admit we do not know why, which is the honest pair.
    const map = unavailableHooks(payload({ hooks_unavailable: { "plan.enhance": "" } }));
    expect(map["plan.enhance"]).toBe(NO_REASON);
    expect(isUnavailable(map, "plan.enhance")).toBe(true);
    const map2 = unavailableHooks(payload({ hooks_unavailable: { "plan.enhance": 42 } }));
    expect(map2["plan.enhance"]).toBe(NO_REASON);
  });

  it("trims a padded reason but does not otherwise rewrite the operator's words", () => {
    const map = unavailableHooks(
      payload({ hooks_unavailable: { score: "  music backend unbound  " } }),
    );
    expect(map.score).toBe("music backend unbound");
  });

  it("carries hooks it has never heard of", () => {
    // The point of the projection: a hook invented next year is honest for free,
    // with no change to this file.
    const map = unavailableHooks(
      payload({ hooks_unavailable: { "some.future.hook": "not wired on this host" } }),
    );
    expect(isUnavailable(map, "some.future.hook")).toBe(true);
    expect(reasonFor(map, "some.future.hook")).toBe("not wired on this host");
  });
});

describe("isUnavailable / reasonFor", () => {
  const map = { "plan.enhance": "AI Gateway not configured" };

  it("answers only for hooks actually reported", () => {
    expect(isUnavailable(map, "plan.enhance")).toBe(true);
    expect(isUnavailable(map, "score")).toBe(false);
    expect(reasonFor(map, "score")).toBeNull();
  });

  it("does not report a hook unavailable off a junk lookup", () => {
    expect(isUnavailable(map, "")).toBe(false);
    expect(isUnavailable(map, null)).toBe(false);
    expect(isUnavailable(null, "plan.enhance")).toBe(false);
    // Inherited Object.prototype keys must not read as a reported hook.
    expect(isUnavailable(map, "toString")).toBe(false);
    expect(isUnavailable(map, "constructor")).toBe(false);
  });
});

describe("unavailableList", () => {
  it("sorts for stable rendering", () => {
    const map = unavailableHooks(
      payload({ hooks_unavailable: { score: "b", "plan.enhance": "a", "cast.image": "c" } }),
    );
    expect(unavailableList(map).map((e) => e.hook)).toEqual(["cast.image", "plan.enhance", "score"]);
  });

  it("is empty when nothing is restricted", () => {
    expect(unavailableList({})).toEqual([]);
    expect(unavailableList(null)).toEqual([]);
  });
});
