import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  projectSlug,
  bundleKeyMatchesProject,
  projectSlugFromBundleKey,
  resolveProjectForBundle,
} from "../modules/_shared/bundle-project";

const HASHED = "bundles/neon_courier-fa68fa014b049a43.tar.gz";

describe("bundle-project (backend tenancy mirror)", () => {
  it("projectSlug matches the backend _slug rule", () => {
    expect(projectSlug("neon courier")).toBe("neon_courier");
    expect(projectSlug("a/b")).toBe("a_b");
    expect(projectSlug("  ")).toBe("untitled");
  });

  it("projectSlugFromBundleKey strips the content-addressed hash, not the whole stem", () => {
    expect(projectSlugFromBundleKey(HASHED)).toBe("neon_courier");
    expect(projectSlugFromBundleKey("bundles/a-film.tar.gz")).toBe("a-film");
    expect(projectSlugFromBundleKey("bundles/neon_courier/foo.tar.gz")).toBe("neon_courier");
    expect(projectSlugFromBundleKey("custom/key")).toBeNull();
  });

  it("bundleKeyMatchesProject accepts the three backend layouts", () => {
    expect(bundleKeyMatchesProject(HASHED, "neon_courier")).toBe(true);
    expect(bundleKeyMatchesProject("bundles/neon_courier.tar.gz", "neon_courier")).toBe(true);
    expect(bundleKeyMatchesProject("bundles/neon_courier/x.tar.gz", "neon_courier")).toBe(true);
    expect(bundleKeyMatchesProject(HASHED, "neon_courier-fa68fa014b049a43")).toBe(true);
    expect(bundleKeyMatchesProject(HASHED, "loadtest_gpu_keyframe")).toBe(false);
    expect(bundleKeyMatchesProject(HASHED, "loadtest_own_gpu_backend")).toBe(false);
  });

  it("resolveProjectForBundle keeps a matching caller and remaps a mismatch", () => {
    expect(resolveProjectForBundle(HASHED, "neon_courier")).toBe("neon_courier");
    expect(resolveProjectForBundle(HASHED, "  neon_courier  ")).toBe("neon_courier");
    expect(resolveProjectForBundle(HASHED, "loadtest_gpu_keyframe")).toBe("neon_courier");
    expect(resolveProjectForBundle(HASHED, "loadtest_own_gpu_backend")).toBe("neon_courier");
    expect(resolveProjectForBundle(HASHED, undefined)).toBe("neon_courier");
    expect(resolveProjectForBundle(HASHED, "")).toBe("neon_courier");
  });

  it("a hyphenated project name is not eaten by the hash suffix", () => {
    expect(projectSlugFromBundleKey("bundles/keeper_log-3ed2f8a957ea4607.tar.gz")).toBe("keeper_log");
    expect(resolveProjectForBundle("bundles/keeper_log-3ed2f8a957ea4607.tar.gz", "other")).toBe("keeper_log");
  });
});

const h = vi.hoisted(() => ({ started: [] as Array<Record<string, unknown>> }));

vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_e: unknown, args: Record<string, unknown>) => {
      h.started.push(args);
      return { film_id: "film-align", phase: "keyframe", scenes: args.scenes, project: args.project, created_at: 0 };
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
const env = {
  ALLOW_UNAUTHENTICATED: "true",
  ASSETS: { fetch: async () => new Response("ASSET") },
  SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
  MODULE_KEYFRAME: {
    fetch: async () =>
      new Response(JSON.stringify({ name: "keyframe-sdxl", version: "0.1.0", api: MODULE_API, hooks: ["keyframe"], ui: { order: 10, locality: "cloud" } }),
        { status: 200, headers: { "content-type": "application/json" } }),
  },
  MODULE_ALIBABA_WAN: {
    fetch: async () =>
      new Response(JSON.stringify({ name: "alibaba-wan", version: "0.1.0", api: MODULE_API, hooks: ["motion.backend"], ui: { order: 10, locality: "byo" } }),
        { status: 200, headers: { "content-type": "application/json" } }),
  },
} as unknown as Env;

const post = (path: string, body: unknown) =>
  new Request(`https://studio.example${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });

const SCENES = [{ shot_id: "shot_01", prompt: "a shot", seconds: 4 }];

describe("film doors remap a mismatched project before startFilmJob", () => {
  beforeEach(() => { h.started = []; });

  it("panel /api/storyboard/render remaps loadtest slug onto the bundle project", async () => {
    const res = await worker.fetch(post("/api/storyboard/render", {
      bundleKey: HASHED, project: "loadtest_gpu_keyframe", scenes: SCENES, motion_backend: "alibaba-wan",
    }), env, ctx);
    expect(res.status, await res.text()).toBe(201);
    expect(h.started).toHaveLength(1);
    expect(h.started[0].project).toBe("neon_courier");
    expect(h.started[0].bundle_key).toBe(HASHED);
  });

  it("agent /api/render/film remaps loadtest_own_gpu_backend onto the bundle project", async () => {
    const res = await worker.fetch(post("/api/render/film", {
      bundle_key: HASHED, project: "loadtest_own_gpu_backend", scenes: SCENES, motion_backend: "alibaba-wan",
    }), env, ctx);
    expect(res.status, await res.text()).toBe(201);
    expect(h.started).toHaveLength(1);
    expect(h.started[0].project).toBe("neon_courier");
    expect(h.started[0].bundle_key).toBe(HASHED);
  });

  it("keeps an already-matching project", async () => {
    const res = await worker.fetch(post("/api/render/film", {
      bundle_key: HASHED, project: "neon_courier", scenes: SCENES, motion_backend: "alibaba-wan",
    }), env, ctx);
    expect(res.status, await res.text()).toBe(201);
    expect(h.started[0].project).toBe("neon_courier");
  });
});
