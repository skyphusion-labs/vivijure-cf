// cf#896: the panel doors accept the snake_case spellings the iOS client sends, and APPLY them.
//
// vivijure-ios StoryboardRenderRequest (Sources/VivijureKit/Models.swift) encodes every panel field
// twice, camelCase and snake_case, plus `storyboard` and a top-level `keyframe_backend`. Refusing those
// would have broken every iOS render. Accepting them is only half the job: an alias that passes the
// check and is then dropped is the silent defect this issue is about. So these cases read what reached
// the job start (core's startFilmJob, mocked to record its arguments), not just the status code.

import { describe, it, expect, vi } from "vitest";

const h = vi.hoisted(() => ({ film: [] as Array<Record<string, unknown>>, rows: [] as Array<Record<string, unknown>> }));

vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_e: unknown, args: Record<string, unknown>) => {
      h.film.push(args);
      return { film_id: "film-ios", phase: "keyframe", scenes: args.scenes, project: "p", created_at: 0 };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/renders-db", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/renders-db")>();
  return { ...actual, insertRender: vi.fn(async (_e: unknown, row: Record<string, unknown>) => { h.rows.push(row); }) };
});

import worker from "../src/index";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";
import type { Env } from "../src/env";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const moduleBinding = (name: string, hooks: string[]) => ({
  fetch: async () =>
    new Response(JSON.stringify({ name, version: "0.1.0", api: MODULE_API, hooks, ui: { order: 10, locality: "cloud" } }),
      { status: 200, headers: { "content-type": "application/json" } }),
});
const env = {
  ALLOW_UNAUTHENTICATED: "true",
  ASSETS: { fetch: async () => new Response("ASSET") },
  SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
  DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) }) },
  R2_RENDERS: { get: async () => null, put: async () => {}, head: async () => null },
  MODULE_KEYFRAME: moduleBinding("keyframe", ["keyframe"]),
  MODULE_CLOUD_KEYFRAME: moduleBinding("cloud-keyframe", ["keyframe"]),
  MODULE_SEEDANCE: moduleBinding("seedance", ["motion.backend"]),
} as unknown as Env;

const BUNDLE = "bundles/Ios_Board.tar.gz";
const SCENES = [{ shot_id: "shot_01", prompt: "a lighthouse at dawn", seconds: 4 }];

/** The body StoryboardRenderRequest(...) encodes with every optional set. Swift omits nil optionals,
 *  so a real submit carries a subset of these keys and never any other key. */
function iosBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  const tier = "draft";
  return {
    storyboard: { title: "Ios Board", scenes: [{ id: "shot_01", prompt: "a lighthouse at dawn" }] },
    bundle_key: BUNDLE, bundleKey: BUNDLE,
    quality_tier: tier, qualityTier: tier,
    project: "Ios_Board",
    castLoras: {}, cast_loras: {},
    keyframesOnly: false, keyframes_only: false,
    motion_backend: "seedance",
    keyframe_backend: "cloud-keyframe",
    scenes: SCENES,
    ...over,
  };
}

async function submit(body: Record<string, unknown>) {
  h.film = [];
  h.rows = [];
  const res = await worker.fetch(new Request("https://studio.example/api/storyboard/render", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  }), env, ctx);
  return { status: res.status, text: await res.text(), args: h.film[0], row: h.rows[0] };
}

describe("the iOS StoryboardRenderRequest body (cf#896)", () => {
  it("gets through the field check and starts the job", async () => {
    const r = await submit(iosBody());
    expect(r.status, r.text).toBe(201);
    expect(r.args, "the job never started").toBeDefined();
    expect(r.row?.qualityTier).toBe("draft");
  });

  it("applies quality_tier when it is the only spelling sent", async () => {
    const body = iosBody();
    delete body.qualityTier;
    const r = await submit(body);
    expect(r.status, r.text).toBe(201);
    // The door records the tier it ran at on the render row. Before cf#896 this was final: the door
    // read only qualityTier and dropped quality_tier.
    expect(r.row?.qualityTier).toBe("draft");
  });

  it("applies bundle_key when it is the only spelling sent", async () => {
    const body = iosBody();
    delete body.bundleKey;
    const r = await submit(body);
    expect(r.status, r.text).toBe(201);
    expect(r.args!.bundle_key).toBe(BUNDLE);
  });

  it("carries a top-level keyframe_backend into renderOverrides, so the door it names is used", async () => {
    const r = await submit(iosBody());
    expect(r.status, r.text).toBe(201);
    expect(r.args!.keyframe_backend).toBe("cloud-keyframe");
  });

  it("refuses two spellings with different values", async () => {
    const r = await submit(iosBody({ quality_tier: "final" }));
    expect(r.status).toBe(400);
    expect(r.text).toContain("got quality_tier and qualityTier with different values");
    expect(r.args).toBeUndefined();
  });

  it("still refuses a field no spelling of which the door reads", async () => {
    const r = await submit(iosBody({ resolution: "480p" }));
    expect(r.status).toBe(400);
    expect(r.text).toContain("does not read this field: resolution");
    expect(r.args).toBeUndefined();
  });
});
