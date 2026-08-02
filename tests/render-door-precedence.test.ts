import { describe, it, expect, vi } from "vitest";

// cf#334 step 3 -- the BEFORE picture, written before the extraction touched anything.
//
// The shared pre-flight runs its guards in ONE order. The doors did not: hSubmitRender shape-checked
// its overrides bag before validating scenes, hStartFilm did the reverse. Unifying that is the point,
// and it is also the only thing about this refactor a caller can observe.
//
// So this file pins, per door, the exact status AND message for a request with a SINGLE defect. Those
// must not move: one defect has one right answer and the extraction must not change it. A request
// with TWO defects may be told about a different one first after the extraction, and that is disclosed
// in the PR rather than smuggled; nothing here asserts multi-defect ordering, because that is the part
// that legitimately changes.
//
// It also documents something I got wrong on the first pass and would have shipped: the two doors use
// DIFFERENT field names in their refusals ("bundleKey" vs "bundle_key"), so a shared guard with a
// hardcoded message silently rewrites one door's contract.

const h = vi.hoisted(() => ({ started: [] as Array<Record<string, unknown>> }));

vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_e: unknown, args: Record<string, unknown>) => {
      h.started.push(args);
      return { film_id: "film-prec", phase: "keyframe", scenes: args.scenes, project: "p", created_at: 0 };
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
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";
import type { Env } from "../src/env";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const moduleBinding = (name: string, hooks: string[], locality: string) => ({
  fetch: async () =>
    new Response(JSON.stringify({ name, version: "0.1.0", api: MODULE_API, hooks, ui: { order: 10, locality } }),
      { status: 200, headers: { "content-type": "application/json" } }),
});
const base = {
  ALLOW_UNAUTHENTICATED: "true",
  ASSETS: { fetch: async () => new Response("ASSET") },
  SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
  MODULE_KEYFRAME: moduleBinding("keyframe-sdxl", ["keyframe"], "cloud"),
  MODULE_ALIBABA_WAN: moduleBinding("alibaba-wan", ["motion.backend"], "byo"),
};
const env = base as unknown as Env;
// Same env with NO keyframe module, for the one refusal that is a 503 rather than a 400.
const envNoKeyframe = { ...base, MODULE_KEYFRAME: undefined } as unknown as Env;

const post = (path: string, body: unknown) =>
  new Request(`https://studio.example${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

const BUNDLE = "bundles/p.tar.gz";
const SCENES = [{ shot_id: "shot_01", prompt: "a shot", seconds: 4 }];

interface Case { name: string; body: Record<string, unknown>; status: number; contains: string; env?: Env }

// One defect per case. Anything that would introduce a second defect is deliberately left valid.
const PANEL: Case[] = [
  { name: "no bundleKey", body: { scenes: SCENES, motion_backend: "alibaba-wan" },
    status: 400, contains: "bundleKey required" },
  { name: "unsafe bundleKey", body: { bundleKey: "../../etc/passwd", scenes: SCENES, motion_backend: "alibaba-wan" },
    status: 400, contains: "bundleKey must be a plain relative key under bundles/" },
  { name: "renderOverrides not an object", body: { bundleKey: BUNDLE, scenes: SCENES, motion_backend: "alibaba-wan", renderOverrides: "nope" },
    status: 400, contains: "renderOverrides must be a JSON object" },
  { name: "renderOverrides.config entry not an object", body: { bundleKey: BUNDLE, scenes: SCENES, motion_backend: "alibaba-wan", renderOverrides: { config: { "alibaba-wan": "burn" } } },
    status: 400, contains: "renderOverrides.config.alibaba-wan" },
  { name: "no scenes", body: { bundleKey: BUNDLE, motion_backend: "alibaba-wan" },
    status: 400, contains: "scenes[] required" },
  { name: "unknown motion backend", body: { bundleKey: BUNDLE, scenes: SCENES, motion_backend: "no-such-backend" },
    status: 400, contains: "no-such-backend" },
  { name: "no keyframe module installed", body: { bundleKey: BUNDLE, scenes: SCENES, motion_backend: "alibaba-wan" },
    status: 503, contains: "no keyframe module installed", env: envNoKeyframe },
];

const AGENT: Case[] = [
  { name: "no bundle_key", body: { scenes: SCENES, motion_backend: "alibaba-wan" },
    status: 400, contains: "bundle_key required" },
  { name: "unsafe bundle_key", body: { bundle_key: "../../etc/passwd", scenes: SCENES, motion_backend: "alibaba-wan" },
    status: 400, contains: "bundle_key must be a plain relative key under bundles/" },
  { name: "no scenes", body: { bundle_key: BUNDLE, motion_backend: "alibaba-wan" },
    status: 400, contains: "scenes[] required" },
  { name: "keyframe_config not an object", body: { bundle_key: BUNDLE, scenes: SCENES, motion_backend: "alibaba-wan", keyframe_config: "nope" },
    status: 400, contains: "keyframe_config must be a JSON object" },
  { name: "film_finish_config entry not an object", body: { bundle_key: BUNDLE, scenes: SCENES, motion_backend: "alibaba-wan", film_finish_config: { subtitle: "x" } },
    status: 400, contains: "film_finish_config.subtitle" },
  { name: "unknown motion backend", body: { bundle_key: BUNDLE, scenes: SCENES, motion_backend: "no-such-backend" },
    status: 400, contains: "no-such-backend" },
];

// The scatter door. Its refusals use the panel's `bundleKey` spelling but its OWN scenes contract
// (it takes shotIds, not scenes), so it is a third contract rather than a copy of either door above.
const SCATTER: Case[] = [
  { name: "no bundleKey", body: { shotIds: ["shot_01", "shot_02"], motion_backend: "alibaba-wan" },
    status: 400, contains: "bundleKey required" },
  { name: "unsafe bundleKey", body: { bundleKey: "../../etc/passwd", shotIds: ["shot_01", "shot_02"], motion_backend: "alibaba-wan" },
    status: 400, contains: "bundleKey must be a plain relative key under bundles/" },
  { name: "fewer than two shotIds", body: { bundleKey: BUNDLE, shotIds: ["shot_01"], motion_backend: "alibaba-wan" },
    status: 400, contains: "shotIds[] required" },
  { name: "unknown motion backend", body: { bundleKey: BUNDLE, shotIds: ["shot_01", "shot_02"], motion_backend: "no-such-backend" },
    status: 400, contains: "no-such-backend" },
];

async function run(path: string, c: Case) {
  h.started = [];
  const res = await worker.fetch(post(path, c.body), c.env ?? env, ctx);
  return { res, text: await res.text() };
}

describe("cf#334: single-defect refusals are per-door contracts and must not move", () => {
  for (const c of PANEL) {
    it(`panel main render: ${c.name}`, async () => {
      const { res, text } = await run("/api/storyboard/render", c);
      expect(res.status, `body: ${text}`).toBe(c.status);
      expect(text).toContain(c.contains);
      expect(h.started.length, "must refuse BEFORE any GPU spend").toBe(0);
    });
  }
  for (const c of AGENT) {
    it(`agent door: ${c.name}`, async () => {
      const { res, text } = await run("/api/render/film", c);
      expect(res.status, `body: ${text}`).toBe(c.status);
      expect(text).toContain(c.contains);
      expect(h.started.length, "must refuse BEFORE any GPU spend").toBe(0);
    });
  }

  for (const c of SCATTER) {
    it(`scatter door: ${c.name}`, async () => {
      const { res, text } = await run("/api/storyboard/render/scatter", c);
      expect(res.status, `body: ${text}`).toBe(c.status);
      expect(text).toContain(c.contains);
      expect(h.started.length, "must refuse BEFORE any GPU spend").toBe(0);
    });
  }

  it("CONTROL: the same requests WITHOUT their defect are accepted", async () => {
    // Without this, every case above would pass identically if the doors refused everything, and the
    // file would be asserting that the studio is broken rather than that its refusals are precise.
    h.started = [];
    const panel = await worker.fetch(post("/api/storyboard/render", { bundleKey: BUNDLE, scenes: SCENES, motion_backend: "alibaba-wan" }), env, ctx);
    expect(panel.status, "the panel door must accept the clean request").toBe(201);
    h.started = [];
    const agent = await worker.fetch(post("/api/render/film", { bundle_key: BUNDLE, scenes: SCENES, motion_backend: "alibaba-wan" }), env, ctx);
    expect(agent.status, "the agent door must accept the clean request").toBe(201);
  });

  it("the two doors genuinely disagree about the field name, which a shared guard must preserve", async () => {
    const panel = await run("/api/storyboard/render", PANEL[0]);
    const agent = await run("/api/render/film", AGENT[0]);
    expect(panel.text).toContain("bundleKey required");
    expect(agent.text).toContain("bundle_key required");
    expect(panel.text).not.toContain("bundle_key required");
  });
});
