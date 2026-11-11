import { describe, it, expect, vi } from "vitest";

// vivijure-cf#1389 (core#431): the join refuses parts of different frame rates. A part whose interpolation
// soft-degraded ships at 24 fps beside siblings at 48, so a long film now pins ONE rate for every part, as it
// already pins the frame. The agent door takes delivery_fps and forwards it to startFilmJob, where core lets
// it win over the rate the finish chain produced.

const h = vi.hoisted(() => ({ lastArgs: {} as Record<string, unknown>, started: 0 }));
vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_env: unknown, args: { scenes?: unknown }) => {
      h.lastArgs = args;
      h.started++;
      return { film_id: "film-1389-test", project: "p", phase: "keyframe", scenes: args.scenes, created_at: 0 };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/renders-db", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/renders-db")>();
  return { ...actual, insertRender: vi.fn(async () => {}) };
});
vi.mock("@skyphusion-labs/vivijure-core/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => []) };
});

import worker from "../src/index";
import { buildParentDoc, partInputs, type CreateParentBody } from "../src/film-parent";
import { parentDefaultDeliveryFps } from "../src/parent-delivery-fps";
import { MODULE_API, type RegisteredModule } from "@skyphusion-labs/vivijure-core/modules/types";
import type { Env } from "../src/env";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const manifestFetcher = (manifest: unknown) => ({
  fetch: async () => new Response(JSON.stringify(manifest), { status: 200, headers: { "content-type": "application/json" } }),
});
function env(): Env {
  return {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET") },
    SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
    MODULE_KEYFRAME: manifestFetcher({ name: "cloud-keyframe", version: "0.1.0", api: MODULE_API, hooks: ["keyframe"] }),
    MODULE_SEEDANCE: manifestFetcher({ name: "seedance", version: "0.2.2", api: MODULE_API, hooks: ["motion.backend"], ui: { order: 10, locality: "cloud" } }),
  } as unknown as Env;
}
const post = (path: string, body: unknown) => new Request(`https://studio.example${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const submit = (extra: Record<string, unknown>) => worker.fetch(
  post("/api/render/film", { bundle_key: "bundles/verify.tar.gz", scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }], motion_backend: "seedance", ...extra }),
  env(), ctx,
);

describe("POST /api/render/film delivery_fps (cf#1389)", () => {
  it("forwards a whole rate to startFilmJob", async () => {
    h.started = 0;
    const res = await submit({ delivery_fps: 48 });
    expect(res.status).toBe(201);
    expect(h.started).toBe(1);
    expect(h.lastArgs.delivery_fps).toBe(48);
  });
  it("CONTROL: sends none when omitted", async () => {
    const res = await submit({});
    expect(res.status).toBe(201);
    expect("delivery_fps" in h.lastArgs).toBe(false);
  });
  for (const bad of [0, -24, 23.976, "48", null]) {
    it(`refuses ${JSON.stringify(bad)} by name, before any job`, async () => {
      h.started = 0;
      const res = await submit({ delivery_fps: bad });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error?: string }).error).toMatch(/delivery_fps must be a whole number above 0/);
      expect(h.started).toBe(0);
    });
  }
});

const finishMod = (name: string, binding: string) =>
  ({ name, version: "1.0.0", api: MODULE_API, binding, hooks: ["finish"], ui: { order: 1 } }) as unknown as RegisteredModule;
const MODS = [finishMod("finish-rife", "MODULE_FINISH_RIFE"), finishMod("finish-upscale", "MODULE_FINISH_UPSCALE")];

describe("parentDefaultDeliveryFps: the rate the shared finish chain would ship at", () => {
  it("no finish config is 24", () => {
    expect(parentDefaultDeliveryFps(MODS, undefined)).toBe(24);
    expect(parentDefaultDeliveryFps(MODS, {})).toBe(24);
  });
  it("RIFE at its default factor is 48; with upscale beside it, still 48", () => {
    expect(parentDefaultDeliveryFps(MODS, { "finish-rife": {} })).toBe(48);
    expect(parentDefaultDeliveryFps(MODS, { "finish-rife": {}, "finish-upscale": {}, "finish-order": ["finish-rife"] })).toBe(48);
  });
  it("reads the factor and the off switch from the config the step runs on", () => {
    expect(parentDefaultDeliveryFps(MODS, { "finish-rife": { interpolation_factor: 3 } })).toBe(72);
    expect(parentDefaultDeliveryFps(MODS, { "finish-rife": { interpolate: false } })).toBe(24);
  });
  it("a module this studio does not serve adds nothing (its part refuses it by name, cf#593)", () => {
    expect(parentDefaultDeliveryFps([], { "finish-rife": {} })).toBe(24);
  });
});

function parentBody(shared: Record<string, unknown>): CreateParentBody {
  return {
    project: "Long",
    storyboard: { title: "t", scenes: Array.from({ length: 4 }, (_, i) => ({ shot_id: `s${i}`, prompt: `p${i}`, seconds: 4 })) },
    character_refs: { A: { key: "a" } },
    part_size: 2,
    shared: { motion_backend: "seedance", style: "photoreal", delivery_width: 1920, delivery_height: 1080, ...shared },
    spend_ceiling_usd: 1000,
    cost_usd_per_shot_est: 1,
    pause_after_first_part: false,
    idempotency_key: "k-1389",
  } as unknown as CreateParentBody;
}

describe("a long film pins one rate for every part (cf#1389)", () => {
  it("the caller's shared.delivery_fps goes to every part, and wins over the default", () => {
    const doc = buildParentDoc("feature-1389", parentBody({ delivery_fps: 30 }), 0, undefined, "", 48);
    expect(doc.shared.delivery_fps).toBe(30);
    for (const part of doc.parts) expect(partInputs(doc, part).submit.delivery_fps).toBe(30);
  });
  it("with none, the default passed in is stored once and sent to every part", () => {
    const doc = buildParentDoc("feature-1389", parentBody({}), 0, undefined, "", 48);
    expect(doc.parts.length).toBe(2);
    expect(doc.shared.delivery_fps).toBe(48);
    for (const part of doc.parts) expect(partInputs(doc, part).submit.delivery_fps).toBe(48);
  });
  it("with none and no default passed, it is 24", () => {
    expect(buildParentDoc("feature-1389", parentBody({}), 0).shared.delivery_fps).toBe(24);
  });
  it("the byte prediction is made at the pinned rate", () => {
    let seen = 0;
    buildParentDoc("feature-1389", parentBody({}), 0, (_w, _h, fps) => { seen = fps; return 0; }, "", 48);
    expect(seen).toBe(48);
  });
  it("a film made before this (no stored rate) sends its parts none, as before", () => {
    const doc = buildParentDoc("feature-1389", parentBody({}), 0);
    delete (doc.shared as { delivery_fps?: number }).delivery_fps;
    expect("delivery_fps" in partInputs(doc, doc.parts[0]).submit).toBe(false);
  });
  for (const bad of [0, 23.5, "30"]) {
    it(`the parent refuses shared.delivery_fps ${JSON.stringify(bad)}`, () => {
      expect(() => buildParentDoc("feature-1389", parentBody({ delivery_fps: bad }), 0)).toThrow(/shared\.delivery_fps must be a whole number above 0/);
    });
  }
  it("POST /api/film refuses a bad shared.delivery_fps before the film is stored", async () => {
    const res = await worker.fetch(post("/api/film", parentBody({ delivery_fps: 0 })), env(), ctx);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toMatch(/shared\.delivery_fps/);
  });
});
