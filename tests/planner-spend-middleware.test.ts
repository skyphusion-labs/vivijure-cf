import { describe, it, expect } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { SPEND_RETRY_AFTER_SECONDS, type RateLimitBinding } from "../src/rate-limit";

// cf#256: the planner/chat routes run operator-billed paid AI, so they must pass the SAME spend
// middleware the render routes pass. isSpendRoute unit tests pin the pattern; this file pins the
// WIRING -- the real worker.fetch entrypoint, the real gate, the real 429 -- because a route can
// match a regex the middleware never consults.

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const PLANNER_ROUTES = [
  "/api/storyboard/plan",
  "/api/storyboard/refine",
  "/api/storyboard/enhance",
  "/api/chat",
];

/** Env with a limiter that allows the first `allow` calls, then reports over-limit. */
function makeEnv(allow: number) {
  const keys: string[] = [];
  const limiter: RateLimitBinding = {
    limit: async ({ key }) => {
      keys.push(key);
      return { success: keys.length <= allow };
    },
  };
  const env = {
    ALLOW_UNAUTHENTICATED: "true",
    SPEND_RATE_LIMITER: limiter,
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
  } as unknown as Env;
  return { env, keys };
}

const post = (path: string, body: unknown = {}) =>
  new Request(`https://studio.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify(body),
  });

describe("planner spend limiting through the real middleware (cf#256)", () => {
  it("consults the limiter on every planner route, keyed by client IP", async () => {
    for (const path of PLANNER_ROUTES) {
      const { env, keys } = makeEnv(10);
      const res = await worker.fetch(post(path), env, ctx);
      // The body is deliberately empty, so the handler rejects it 400. That is the point: the
      // request was ALLOWED through the limiter and reached the handler, and the limiter was
      // consulted for this path with the caller IP as the key.
      expect(keys).toEqual(["203.0.113.7"]);
      expect(res.status).toBe(400);
    }
  });

  it("a burst past the limit 429s with Retry-After, on every planner route", async () => {
    for (const path of PLANNER_ROUTES) {
      const { env, keys } = makeEnv(2);
      expect((await worker.fetch(post(path), env, ctx)).status).toBe(400); // allowed
      expect((await worker.fetch(post(path), env, ctx)).status).toBe(400); // allowed
      const denied = await worker.fetch(post(path), env, ctx);
      expect(denied.status).toBe(429);
      expect(denied.headers.get("retry-after")).toBe(String(SPEND_RETRY_AFTER_SECONDS));
      expect(await denied.json()).toMatchObject({ error: expect.stringContaining("rate limited") });
      expect(keys).toHaveLength(3);
    }
  });

  it("a BROKEN limiter denies the planner routes 503 (the fail-closed posture covers them too)", async () => {
    const env = {
      ALLOW_UNAUTHENTICATED: "true",
      ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    } as unknown as Env; // no SPEND_RATE_LIMITER binding at all
    for (const path of PLANNER_ROUTES) {
      const res = await worker.fetch(post(path), env, ctx);
      expect(res.status).toBe(503);
    }
  });

  // CONTROL: the harness can tell a metered route from a free one, so the assertions above are not
  // just "everything 429s". A free planner-adjacent POST never touches the limiter.
  it("does NOT consult the limiter for a free planner route", async () => {
    const { env, keys } = makeEnv(0); // any consultation would deny
    const res = await worker.fetch(post("/api/storyboard/yaml", { storyboard: { scenes: [] } }), env, ctx);
    expect(keys).toEqual([]);
    expect(res.status).not.toBe(429);
  });
});
