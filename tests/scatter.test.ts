import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const env = {
  ALLOW_UNAUTHENTICATED: "true",
  ASSETS: {
    fetch: async () =>
      new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
  },
  SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
  DB: {
    prepare: () => ({
      bind: () => ({
        run: async () => ({}),
        first: async () => null,
        all: async () => ({ results: [] }),
      }),
    }),
  },
  R2_RENDERS: { get: async () => null, put: async () => {}, head: async () => null },
} as unknown as Env;

describe("film scatter is retired", () => {
  it("POST /api/storyboard/render/scatter is 404", async () => {
    const res = await worker.fetch(
      new Request("https://studio.example/api/storyboard/render/scatter", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bundleKey: "bundles/verify.tar.gz",
          shotIds: ["shot_01", "shot_02"],
          motion_backend: "seedance",
        }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(404);
  });

  it("GET /api/render/film/scatter-x is 410", async () => {
    const res = await worker.fetch(
      new Request("https://studio.example/api/render/film/scatter-x"),
      env,
      ctx,
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error?: string; jobId?: string };
    expect(body.error).toMatch(/Scatter is retired/i);
    expect(body.jobId).toBe("scatter-x");
  });

  it("GET /api/storyboard/render/scatter-x is 410", async () => {
    const res = await worker.fetch(
      new Request("https://studio.example/api/storyboard/render/scatter-x"),
      env,
      ctx,
    );
    expect(res.status).toBe(410);
  });
});
