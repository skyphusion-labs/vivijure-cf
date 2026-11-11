import { describe, it, expect, vi, beforeEach } from "vitest";

// cf#1404: POST /api/storyboard/renders/:id/regen-shot takes an optional keyframe `seed`. Without one the
// regen re-sends the row's stored settings, and the backend (no random seed, vivijure-backend#563) returns
// the stored still for an unchanged shot. These drive the REAL route through the worker; only the core
// start function, the row read and the bundle read are stubbed, to capture what the door hands core.

const h = vi.hoisted(() => ({ film: [] as Array<Record<string, unknown>> }));

vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_e: unknown, args: Record<string, unknown>) => {
      h.film.push(args);
      return { film_id: "film-regen", phase: "keyframe", scenes: args.scenes, project: "p", created_at: 0 };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/renders-db", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/renders-db")>();
  return {
    ...actual,
    insertRender: vi.fn(async () => {}),
    getRenderIdByPublicId: vi.fn(async () => 1),
    getRenderByIdForUser: vi.fn(async () => PARENT_ROW),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => SCENES) };
});

import worker from "../src/index";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import type { Env } from "../src/env";

const SCENES = [
  { shot_id: "shot_01", prompt: "wide, the greenhouse at dusk", seconds: 4 },
  { shot_id: "shot_02", prompt: "close on her face", seconds: 4 },
];
const PUB = "11111111-1111-4111-8111-111111111111";
const PARENT_ROW = {
  id: 1, job_id: "film-parent", project: "p", bundle_key: "bundles/greenhouse.tar.gz", status: "COMPLETED",
  quality_tier: "final", render_overrides: null, mode: "keyframes-only", output: null,
  keyframes: SCENES.map((s) => ({ shot_id: s.shot_id, key: `renders/p/${s.shot_id}.png` })), locked_shots: null,
};
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const binding = (name: string, configSchema: Record<string, unknown>) => ({
  fetch: async () => new Response(JSON.stringify({
    name, version: "0.1.0", api: MODULE_API, hooks: ["keyframe"], ui: { order: 10, locality: "cloud" },
    config_schema: configSchema,
  }), { status: 200, headers: { "content-type": "application/json" } }),
});
const envWith = (kf: ReturnType<typeof binding>) => ({
  ALLOW_UNAUTHENTICATED: "true",
  ASSETS: { fetch: async () => new Response("ASSET") },
  SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
  DB: { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }) }) },
  R2_RENDERS: { get: async () => null, put: async () => {}, head: async () => null },
  MODULE_KEYFRAME: kf,
}) as unknown as Env;
const SEEDED = envWith(binding("keyframe", { seed: { type: "int", default: -1, min: -1, label: "seed" } }));
const UNSEEDED = envWith(binding("cloud-keyframe", { model: { type: "string", default: "x", label: "model" } }));
const regen = (env: Env, body: unknown) => worker.fetch(new Request(`https://studio.example/api/storyboard/renders/${PUB}/regen-shot`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}), env, ctx);

// The module scan is cached per isolate (cf#515). Both envs bind MODULE_KEYFRAME, so without a reset the
// second env would be served the first env's catalog.
beforeEach(() => { h.film.length = 0; _resetModuleDiscoveryCache(); });

describe("cf#1404 regen-shot takes a keyframe seed", () => {
  it("hands the seed to a keyframe module that declares one, and says so", async () => {
    const res = await regen(SEEDED, { shotId: "shot_02", seed: 4242 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, seed: 4242 });
    expect(h.film).toHaveLength(1);
    expect((h.film[0].keyframe_config as Record<string, unknown>).seed).toBe(4242);
    expect(h.film[0].scenes).toEqual([{ shot_id: "shot_02", prompt: "close on her face", seconds: 4 }]);
  });

  it("without a seed the stored settings go unchanged, and the answer says seed: null", async () => {
    const res = await regen(SEEDED, { shotId: "shot_02" });
    expect(await res.json()).toMatchObject({ ok: true, seed: null });
    expect((h.film[0].keyframe_config as Record<string, unknown>).seed).not.toBe(4242);
  });

  it("a module with no seed in its schema is not handed one; the answer says seed: null", async () => {
    const res = await regen(UNSEEDED, { shotId: "shot_02", seed: 4242 });
    expect(await res.json()).toMatchObject({ ok: true, seed: null });
    expect("seed" in (h.film[0].keyframe_config as Record<string, unknown>)).toBe(false);
  });

  for (const bad of [-1, 1.5, "7", 2_147_483_648, null, true]) {
    it(`refuses seed ${JSON.stringify(bad)} before anything starts`, async () => {
      const res = await regen(SEEDED, { shotId: "shot_02", seed: bad });
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("seed must be a whole number from 0 to 2147483647");
      expect(h.film).toHaveLength(0);
    });
  }

  it("the largest seed the backend takes is accepted", async () => {
    const res = await regen(SEEDED, { shotId: "shot_01", seed: 2_147_483_647 });
    expect(res.status).toBe(200);
    expect((h.film[0].keyframe_config as Record<string, unknown>).seed).toBe(2_147_483_647);
  });
});
