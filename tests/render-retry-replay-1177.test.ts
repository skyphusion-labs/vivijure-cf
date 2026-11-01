import { describe, it, expect, vi } from "vitest";

// cf#1177: a retry must not spend on a film that differs from the original, and say so only afterwards.
const h = vi.hoisted(() => ({ started: [] as Array<Record<string, unknown>> }));
vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_e: unknown, args: Record<string, unknown>) => {
      h.started.push(args);
      return { film_id: `film-${h.started.length}`, project: args.project, phase: "keyframe", scenes: args.scenes, created_at: 0 };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => [{ shot_id: "shot_01", prompt: "x", seconds: 4 }]) };
});
const rows = vi.hoisted(() => new Map<string, Record<string, unknown>>());
vi.mock("@skyphusion-labs/vivijure-core/renders-db", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/renders-db")>();
  return { ...actual, getRenderByIdForUser: vi.fn(async () => rows.get("row") ?? null), getRenderIdByPublicId: vi.fn(async () => 1) };
});

import worker from "../src/index";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";

const mod = (name: string, hooks: string[]) => ({
  fetch: async () => new Response(JSON.stringify({ name, version: "0.1.0", api: MODULE_API, hooks, ui: { order: 10, locality: "cloud" } }), { status: 200, headers: { "content-type": "application/json" } }),
});
function env() {
  const store = new Map<string, string>();
  const stmt = { first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
  return {
    store,
    ALLOW_UNAUTHENTICATED: "true",
    SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
    DB: { prepare: () => ({ bind: () => stmt, ...stmt }), batch: async () => [] },
    R2_RENDERS: {
      get: async (k: string) => { const v = store.get(k); return v === undefined ? null : { json: async () => JSON.parse(v), text: async () => v }; },
      head: async () => null,
      put: async (k: string, v: string) => { store.set(k, v); return { etag: "e" }; },
      delete: async () => {},
      list: async () => ({ objects: [], truncated: false }),
    },
    MODULE_KEYFRAME: mod("keyframe", ["keyframe"]),
    MODULE_TALK: mod("talk", ["motion.backend"]),
  };
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as never;
const PUBLIC = "11111111-1111-4111-8111-111111111111";
const post = (path: string, body: unknown) => new Request(`https://s.example${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const row = (over: Record<string, unknown> = {}) => ({ id: 1, public_id: "r", job_id: "film-1", project: "p", status: "FAILED", mode: "full", bundle_key: "bundles/p.tar.gz", quality_tier: "final", keyframes: [], render_overrides: null, ...over });
const ORIGINAL = { project: "p", bundle_key: "bundles/p.tar.gz", scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }], motion_backend: "talk", film_titles: { title: { text: "T" } }, audio_key: undefined, idempotency_key: "first" };
const retry = (e: unknown, body: unknown = {}) => worker.fetch(post("/api/storyboard/renders/11111111-1111-4111-8111-111111111111/retry", body), e as never, ctx);

describe("cf#1177 a retry", () => {
  it("replays the original request with reuse on, and a fresh key", async () => {
    h.started = [];
    const e = env();
    expect((await worker.fetch(post("/api/render/film", ORIGINAL), e as never, ctx)).status).toBe(201);
    expect(e.store.has("renders/film-1/submit-args.json"), "the door stores what it was sent").toBe(true);
    rows.set("row", row());
    const res = await retry(e, { idempotency_key: "again" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { ok: boolean; jobId: string };
    expect(body.ok).toBe(true);
    expect(body.jobId).toBe("film-2");
    expect(h.started).toHaveLength(2);
    expect(h.started[1].film_titles, "what a row cannot hold").toEqual({ title: { text: "T" } });
    expect(h.started[1].reuse_finished).toBe(true);
    expect(h.started[1].idempotency_key).toBe("again");
  });

  it("replays a render that came in by the panel door, through that door", async () => {
    h.started = [];
    const e = env();
    const sent = { project: "p", bundleKey: "bundles/p.tar.gz", keyframesOnly: true, scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }], renderOverrides: { keyframe_backend: "keyframe" } };
    expect((await worker.fetch(post("/api/storyboard/render", sent), e as never, ctx)).status).toBe(201);
    expect(JSON.parse(e.store.get("renders/film-1/submit-args.json") as string).door).toBe("render");
    rows.set("row", row({ mode: "keyframes-only" }));
    expect((await retry(e)).status).toBe(201);
    expect(h.started).toHaveLength(2);
    expect(h.started[1].keyframes_only, "only the panel door takes this").toBe(true);
    expect(h.started[1].reuse_finished).toBe(true);
    expect(h.started[0].reuse_finished, "a first submit does not reuse").toBe(false);
  });

  it("with no key does not reuse the first submit's key, so it is not deduplicated against it", async () => {
    h.started = [];
    const e = env();
    await worker.fetch(post("/api/render/film", ORIGINAL), e as never, ctx);
    rows.set("row", row());
    await retry(e);
    expect(h.started[1].idempotency_key).toBeUndefined();
  });

  it("with no stored request starts nothing, and says what would be lost", async () => {
    h.started = [];
    rows.set("row", row({ job_id: "film-old" }));
    const res = await retry(env());
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/cast_loras.*accept_rederive/s);
    expect(h.started).toEqual([]);
  });

  it("accept_rederive runs the old path, and still declares the degrade", async () => {
    h.started = [];
    rows.set("row", row({ job_id: "film-old", render_overrides: { motion_backend: "talk" } }));
    const res = await retry(env(), { accept_rederive: true });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { degraded?: string }).degraded).toMatch(/re-derived/);
    expect(h.started).toHaveLength(1);
  });

  it("only exact true accepts it", async () => {
    h.started = [];
    rows.set("row", row({ job_id: "film-old" }));
    expect((await retry(env(), { accept_rederive: "true" })).status).toBe(409);
    expect(h.started).toEqual([]);
  });

  it("refuses a part of a long film, with a stored request or accept_rederive, and spends nothing", async () => {
    h.started = [];
    const e = env();
    await worker.fetch(post("/api/render/film", ORIGINAL), e as never, ctx);
    h.started = [];
    rows.set("row", row({ project: "Long_3c5aae7e_p01" }));
    const res = await retry(e);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/parts\/:n\/retry/);
    expect((await retry(e, { accept_rederive: true })).status).toBe(409);
    expect(h.started).toEqual([]);
  });

  for (const route of ["regen-shot", "finalize", "animate-cloud", "animate-hybrid", "add-narration", "add-audio"]) {
    it(`${route} refuses a part of a long film, and starts nothing`, async () => {
      h.started = [];
      rows.set("row", row({ project: "Long_3c5aae7e_p01", status: "COMPLETED", mode: "keyframes-only" }));
      const res = await worker.fetch(post(`/api/storyboard/renders/${PUBLIC}/${route}`, { shotId: "shot_01", audioKey: "a", script: "x" }), env() as never, ctx);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/part of a long film/);
      expect(h.started).toEqual([]);
    });

    it(`${route} still reaches its own checks on an ordinary render`, async () => {
      rows.set("row", row({ project: "Ordinary", status: "COMPLETED", mode: "keyframes-only" }));
      const res = await worker.fetch(post(`/api/storyboard/renders/${PUBLIC}/${route}`, { shotId: "shot_01", audioKey: "a", script: "x" }), env() as never, ctx);
      expect(res.status, "the control: the guard refuses only a part").not.toBe(409);
    });
  }

  it("finish-retry refuses a part, by its job", async () => {
    const e = env();
    e.store.set("renders/film-p/film-job.json", JSON.stringify({ project: "Long_3c5aae7e_p01" }));
    const res = await worker.fetch(post("/api/render/film/film-p/finish-retry", {}), e as never, ctx);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error, "finish-retry answers 409 for its own reasons too").toMatch(/part of a long film/);
  });

  it("render-from-keyframes refuses a part's project", async () => {
    h.started = [];
    const res = await worker.fetch(post("/api/storyboard/render-from-keyframes", { bundleKey: "bundles/Long_3c5aae7e_p01-0123456789abcdef.tar.gz", scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }] }), env() as never, ctx);
    expect(res.status).toBe(409);
    expect(h.started).toEqual([]);
  });

  describe("a direct submit naming a part", () => {
    const PART = "Long_3c5aae7e_p01";
    const SCENES = [{ shot_id: "shot_01", prompt: "x", seconds: 4 }];
    const cases: Array<[string, string, Record<string, unknown>, Record<string, unknown>]> = [
      ["film, by project", "/api/render/film", { project: PART, bundle_key: "bundles/p.tar.gz", scenes: SCENES, motion_backend: "talk" }, { project: "Ordinary", bundle_key: "bundles/Ordinary.tar.gz", scenes: SCENES, motion_backend: "talk" }],
      ["film, by bundle", "/api/render/film", { bundle_key: `bundles/${PART}-0123456789abcdef.tar.gz`, scenes: SCENES, motion_backend: "talk" }, { bundle_key: "bundles/Ordinary-0123456789abcdef.tar.gz", scenes: SCENES, motion_backend: "talk" }],
      ["render, by bundle", "/api/storyboard/render", { bundleKey: `bundles/${PART}-0123456789abcdef.tar.gz`, keyframesOnly: true, scenes: SCENES, renderOverrides: { keyframe_backend: "keyframe" } }, { bundleKey: "bundles/Ordinary-0123456789abcdef.tar.gz", keyframesOnly: true, scenes: SCENES, renderOverrides: { keyframe_backend: "keyframe" } }],
    ];
    for (const [name, path, part, ordinary] of cases) {
      it(`${name}: refused, and the ordinary one is not`, async () => {
        h.started = [];
        const refused = await worker.fetch(post(path, part), env() as never, ctx);
        expect(refused.status).toBe(409);
        expect(((await refused.json()) as { error: string }).error).toMatch(/part of a long film/);
        expect(h.started).toEqual([]);
        expect((await worker.fetch(post(path, ordinary), env() as never, ctx)).status).toBe(201);
        expect(h.started).toHaveLength(1);
      });
    }

    it("clips, by project: refused, and the ordinary one is not", async () => {
      const shots = [{ shot_id: "shot_01", keyframe_url: "https://g/k", prompt: "x", seconds: 3 }];
      const refused = await worker.fetch(post("/api/render/clips", { project: PART, shots, motion_backend: "talk" }), env() as never, ctx);
      expect(refused.status).toBe(409);
      const ok = await worker.fetch(post("/api/render/clips", { project: "Ordinary", shots, motion_backend: "talk" }), env() as never, ctx);
      expect(ok.status).not.toBe(409);
    });

    it("a body that is not JSON still gets the door's own answer", async () => {
      const req = new Request("https://s.example/api/render/film", { method: "POST", headers: { "content-type": "application/json" }, body: "not json" });
      const res = await worker.fetch(req, env() as never, ctx);
      expect(res.status).not.toBe(409);
    });
  });

  it("the name test matches what a parent builds, and not an ordinary project", async () => {
    const { buildParentDoc, isParentPartProject } = await import("../src/film-parent");
    const doc = buildParentDoc("feature-3c5aae7e1234", {
      project: "My_film_2", storyboard: { scenes: [{ id: "a", target_seconds: 3 }, { id: "b", target_seconds: 3 }] }, character_refs: {}, part_size: 1,
      shared: { motion_backend: "m", style: "photoreal", delivery_width: 1, delivery_height: 1 }, spend_ceiling_usd: 1, cost_usd_per_shot_est: 0.1,
    }, 0);
    expect(doc.parts.map((p) => isParentPartProject(p.project))).toEqual([true, true]);
    for (const p of ["Two_OClock", "film_p01", "abc_12345678", "x_123_p01"]) expect(isParentPartProject(p), p).toBe(false);
  });

  it("refuses a running render before anything else, stored request or not", async () => {
    h.started = [];
    const e = env();
    await worker.fetch(post("/api/render/film", ORIGINAL), e as never, ctx);
    h.started = [];
    rows.set("row", row({ status: "IN_PROGRESS" }));
    const res = await retry(e);
    expect(res.status).toBe(400);
    expect(h.started).toEqual([]);
  });

  it("a replay the door refuses reports that, and starts nothing", async () => {
    h.started = [];
    const e = env();
    await worker.fetch(post("/api/render/film", ORIGINAL), e as never, ctx);
    const stored = JSON.parse(e.store.get("renders/film-1/submit-args.json") as string) as { body: string };
    e.store.set("renders/film-1/submit-args.json", JSON.stringify({ door: "film", body: JSON.stringify({ ...JSON.parse(stored.body), motion_backend: "gone" }) }));
    h.started = [];
    rows.set("row", row());
    const res = await retry(e);
    expect(res.status).toBe(400);
    expect(h.started).toEqual([]);
  });
});
