import { describe, it, expect, vi, beforeEach } from "vitest";

// cf#927. A bundle object that is not gzip makes the real readBundleScenes throw.
// RFK and the agent door must answer 503, not an unhandled 500, and must not start a film.
// A missing object is not that case: core returns [] and RFK answers 400.

const h = vi.hoisted(() => ({
  fromKeyframes: 0,
  started: 0,
}));

vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async () => {
      h.started += 1;
      return { film_id: "film-927", phase: "keyframe", scenes: [], project: "p", created_at: 0 };
    }),
    startFilmFromKeyframes: vi.fn(async () => {
      h.fromKeyframes += 1;
      return { film_id: "film-927-kf", phase: "clips", scenes: [], project: "p", created_at: 0 };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/renders-db", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/renders-db")>();
  return { ...actual, insertRender: vi.fn(async () => true) };
});

import worker from "../src/index";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";
import type { Env } from "../src/env";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

const NOT_GZIP = new TextEncoder().encode("this is not a gzip bundle");

// Uint8Array.buffer is ArrayBufferLike. Copy into a real ArrayBuffer so the
// stub matches R2's arrayBuffer() return type under tsc.
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

function r2(body: ArrayBuffer | null) {
  return {
    get: async () => (body === null ? null : { arrayBuffer: async () => body }),
    put: async () => {},
    head: async () => null,
  };
}

function moduleBinding(name: string, hooks: string[]) {
  // No usage bag. A partial bag fails validateManifest and the module is dropped, which
  // reads as "no motion.backend module installed" before the bundle is read.
  return {
    fetch: async () =>
      new Response(
        JSON.stringify({
          name, version: "0.1.0", api: MODULE_API, hooks,
          ui: { order: 10, locality: "cloud" },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  };
}

const DB = {
  prepare: () => ({
    bind: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    }),
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ success: true }),
  }),
  batch: async () => [],
};

function env(renders: ReturnType<typeof r2>): Env {
  return {
    ALLOW_UNAUTHENTICATED: "true",
    DB,
    ASSETS: { fetch: async () => new Response("ASSET") },
    SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
    R2_RENDERS: renders,
    MODULE_KEYFRAME: moduleBinding("keyframe-sdxl", ["keyframe"]),
    MODULE_MOTION: moduleBinding("silent-look-door", ["motion.backend"]),
  } as unknown as Env;
}

function post(path: string, body: unknown): Request {
  return new Request(`https://studio.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  _resetModuleDiscoveryCache();
  h.fromKeyframes = 0;
  h.started = 0;
});

describe("cf#927 a non-gzip bundle is undetermined dialogue", () => {
  it("render-from-keyframes returns 503 and does not start a film", async () => {
    const res = await worker.fetch(
      post("/api/storyboard/render-from-keyframes", { bundleKey: "bundles/bad.tar.gz" }),
      env(r2(asArrayBuffer(NOT_GZIP))),
      ctx,
    );
    expect(res.status).toBe(503);
    const parsed = (await res.json()) as { error?: string };
    expect(parsed.error ?? "").toMatch(/could not determine whether this storyboard has spoken lines/);
    expect(h.fromKeyframes).toBe(0);
  });

  it("a missing bundle is still 'no scenes', not 503", async () => {
    const res = await worker.fetch(
      post("/api/storyboard/render-from-keyframes", { bundleKey: "bundles/missing.tar.gz" }),
      env(r2(null)),
      ctx,
    );
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error?: string };
    expect(parsed.error ?? "").toMatch(/no storyboard scenes/);
    expect(h.fromKeyframes).toBe(0);
  });

  it("the agent door returns 503 and does not start a film", async () => {
    const res = await worker.fetch(
      post("/api/render/film", {
        bundle_key: "bundles/bad.tar.gz",
        scenes: [{ shot_id: "shot_01", prompt: "a shot", seconds: 4 }],
        motion_backend: "silent-look-door",
      }),
      env(r2(asArrayBuffer(NOT_GZIP))),
      ctx,
    );
    expect(res.status).toBe(503);
    const parsed = (await res.json()) as { error?: string };
    expect(parsed.error ?? "").toMatch(/could not determine whether this storyboard has spoken lines/);
    expect(h.started).toBe(0);
  });
});
