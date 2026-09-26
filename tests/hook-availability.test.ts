// cf#98: the host reports hooks it cannot SERVE, so the panel never advertises a dead step.
//
// Installed is not servable. /api/storyboard/models projects planning models from INSTALLED
// plan.enhance modules; a deploy without the AI binding or a usable GATEWAY_ID has the module and
// cannot run it, so the picker filled with options whose every choice 500s at hPlan. The wire
// payload never carried the fact, so no frontend work could fix it -- the local#201 broken-button
// class.

import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { aiGatewayReady, PLANNER_UNAVAILABLE_REASON } from "../src/ai-binding";
import {
  VIDEO_FINISH_CAPABILITY_KEY,
  VIDEO_FINISH_GATED_HOOKS,
  VIDEO_FINISH_UNAVAILABLE_REASON,
  VIDEO_FINISH_UNPROVISIONABLE_REASON,
} from "../src/video-finish-availability";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const req = (path: string) => new Request(`https://studio.example${path}`, { method: "GET" });

function envWith(over: Record<string, unknown> = {}): Env {
  return {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET") },
    ...over,
  } as unknown as Env;
}

const AI = { run: async () => ({}) };

describe("aiGatewayReady (the hoisted gate)", () => {
  it("false without the AI binding", async () => {
    expect(await aiGatewayReady(envWith({ GATEWAY_ID: "gw" }))).toBe(false);
  });

  it("false when GATEWAY_ID is absent", async () => {
    expect(await aiGatewayReady(envWith({ AI }))).toBe(false);
  });

  it("false when GATEWAY_ID is BOUND BUT EMPTY", async () => {
    // The case the old `env.AI`-only check said yes to. A bound-but-empty gateway id fails at call
    // time exactly like an absent one, so reporting it as available advertises a chat that 500s.
    expect(await aiGatewayReady(envWith({ AI, GATEWAY_ID: "   " }))).toBe(false);
  });

  it("false when resolving the secret THROWS, rather than propagating", async () => {
    // "We could not even find out" has the same answer as "no" for the caller's question.
    const boom = { get: async () => { throw new Error("secrets store down"); } };
    expect(await aiGatewayReady(envWith({ AI, GATEWAY_ID: boom }))).toBe(false);
  });

  it("true with both", async () => {
    expect(await aiGatewayReady(envWith({ AI, GATEWAY_ID: "gw-1" }))).toBe(true);
  });
});

describe("GET /api/modules host.hooks_unavailable", () => {
  it("reports plan.enhance unavailable, with the reason VERBATIM, when the gateway is not configured", async () => {
    const res = await worker.fetch(req("/api/modules"), envWith(), ctx);
    const body = (await res.json()) as { host?: { hooks_unavailable?: Record<string, string> } };
    expect(body.host?.hooks_unavailable?.["plan.enhance"]).toBe(PLANNER_UNAVAILABLE_REASON);
  });

  it("OMITS the block entirely when the host can serve everything -- absence means available", async () => {
    // "Serves everything" grew a second requirement in cf#118: a host with no VIDEO_FINISH_URL
    // cannot deliver score / master / film.finish / notify, so it is no longer a host that serves
    // everything. Binding the tier here keeps this test asserting what it was written to assert
    // (the block is OMITTED, not emptied) instead of quietly becoming a test that the video-finish
    // report does not exist.
    const res = await worker.fetch(
      req("/api/modules"),
      envWith({ AI, GATEWAY_ID: "gw-1", VIDEO_FINISH_URL: "https://video-finish.skyphusion.org" }),
      ctx,
    );
    const body = (await res.json()) as { host?: { hooks_unavailable?: unknown } };
    expect(body.host?.hooks_unavailable).toBeUndefined();
  });

  it("the reason is written for a TENANT, not only an operator", async () => {
    // It is printed verbatim to someone who very likely cannot fix it, so it must say what to DO.
    // Pinned because the text IS the product here, and a later 'tidy-up' toward terse operator
    // jargon would silently regress the thing the field exists for.
    expect(PLANNER_UNAVAILABLE_REASON).toMatch(/Ask whoever operates this studio/);
    expect(PLANNER_UNAVAILABLE_REASON).toMatch(/unavailable/i);
    // ...while still naming the knob, so an operator reading the same string can act on it.
    expect(PLANNER_UNAVAILABLE_REASON).toMatch(/GATEWAY_ID/);
  });
});

// control-plane#136: the READER half of the newly-writable state, verified through the ROUTE.
//
// WHY THIS IS NOT COVERED BY tests/video-finish-availability.test.ts. That file proves the RESOLVER
// picks the right sentence for a given env. It does not prove the sentence reaches the wire, and the
// wire is what the panel reads. The plane now writes VIDEO_FINISH_TIER_STATE on a tenant studio
// (control-plane#136), so the contract that matters end to end is: var set -> GET /api/modules
// carries the unprovisionable sentence on every key the tier gates. Until that var could be written
// at all, this path was unreachable in production and untested at this level.
describe("GET /api/modules with VIDEO_FINISH_TIER_STATE set (control-plane#136)", () => {
  const modulesHost = async (over: Record<string, unknown>) => {
    const res = await worker.fetch(req("/api/modules"), envWith(over), ctx);
    const body = (await res.json()) as { host?: { hooks_unavailable?: Record<string, string> } };
    return body.host?.hooks_unavailable ?? {};
  };

  it("serves the UNPROVISIONABLE sentence on every gated key when the plane declared it", async () => {
    const map = await modulesHost({ VIDEO_FINISH_TIER_STATE: "unprovisionable" });
    for (const key of [VIDEO_FINISH_CAPABILITY_KEY, ...VIDEO_FINISH_GATED_HOOKS]) {
      expect(map[key], "missing " + key).toBe(VIDEO_FINISH_UNPROVISIONABLE_REASON);
    }
  });

  it("CONTROL: the same studio with NO var serves the provisionable sentence instead", async () => {
    // The discriminating half. Without it, the assertion above could pass on a host that serves one
    // sentence for both states, which is precisely the bug the two sentences exist to fix.
    const map = await modulesHost({});
    expect(map[VIDEO_FINISH_CAPABILITY_KEY]).toBe(VIDEO_FINISH_UNAVAILABLE_REASON);
    expect(VIDEO_FINISH_UNPROVISIONABLE_REASON).not.toBe(VIDEO_FINISH_UNAVAILABLE_REASON);
  });

  it("an OBSERVED tier beats the label: a bound studio reports nothing at all", async () => {
    // The plane can set the var on a studio that later gets the binding. The panel must not then
    // tell a tenant a working capability can never be turned on for them.
    const map = await modulesHost({
      VIDEO_FINISH_TIER_STATE: "unprovisionable",
      VIDEO_FINISH_URL: "https://video-finish.skyphusion.org",
    });
    expect(map[VIDEO_FINISH_CAPABILITY_KEY]).toBeUndefined();
  });

  it("an unrecognised value falls back to the CONSERVATIVE sentence, never to silence", async () => {
    // A typo or a future value the plane has not taught this bundle about must not read as
    // available: silence is what a WORKING tier reports, and claiming that would be the worst
    // possible direction to fail in.
    const map = await modulesHost({ VIDEO_FINISH_TIER_STATE: "unreachable-ish" });
    expect(map[VIDEO_FINISH_CAPABILITY_KEY]).toBe(VIDEO_FINISH_UNAVAILABLE_REASON);
  });
});
