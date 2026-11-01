import { describe, it, expect, vi } from "vitest";

// The wiring: routes, the door calls, the etag write. R2 here enforces onlyIf the way the docs describe,
// which is my reading of R2 and not R2 itself. A live run is what proves the conditional write.
const h = vi.hoisted(() => ({ started: [] as Array<Record<string, unknown>>, bundled: [] as unknown[], quotaFull: false }));
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
vi.mock("@skyphusion-labs/vivijure-core/storage-quota", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/storage-quota")>();
  return {
    ...actual,
    checkStorageQuota: vi.fn(async (...a: Parameters<typeof actual.checkStorageQuota>) =>
      h.quotaFull ? { ok: false, status: 507, message: "storage is full" } : actual.checkStorageQuota(...a)),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => []) };
});

import { insertParent, loadParent, saveParent } from "../src/film-parent-store";
import { buildParentDoc } from "../src/film-parent";
import worker from "../src/index";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";

function r2() {
  const store = new Map<string, { body: string; etag: string }>();
  let n = 0;
  return {
    store,
    async get(key: string) {
      const v = store.get(key);
      return v ? { etag: v.etag, json: async () => JSON.parse(v.body), text: async () => v.body } : null;
    },
    async head(key: string) {
      const v = store.get(key);
      return v ? { etag: v.etag, size: v.body.length } : null;
    },
    async put(key: string, body: string, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      const cur = store.get(key);
      if (opts?.onlyIf?.etagDoesNotMatch === "*" && cur) return null;
      if (opts?.onlyIf?.etagMatches && cur?.etag !== opts.onlyIf.etagMatches) return null;
      const etag = `e${++n}`;
      store.set(key, { body, etag });
      return { etag };
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix }: { prefix: string }) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
}

function moduleBinding(name: string, hooks: string[]) {
  return {
    fetch: async () => new Response(JSON.stringify({
      name, version: "0.1.0", api: MODULE_API, hooks,
      ui: { order: 10, locality: "cloud" },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  };
}

const DB = {
  prepare: () => ({
    bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) }),
    first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }),
  }),
  batch: async () => [],
};

function env(bucket = r2()) {
  return {
    bucket,
    ALLOW_UNAUTHENTICATED: "true",
    SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
    DB, R2_RENDERS: bucket,
    MODULE_KEYFRAME: moduleBinding("keyframe", ["keyframe"]),
    MODULE_TALK: moduleBinding("talk", ["motion.backend"]),
  } as never as Record<string, unknown> & { bucket: ReturnType<typeof r2> };
}

const waits: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => waits.push(p), passThroughOnException() {} } as never;
const settle = async () => {
  while (waits.length) await waits.shift();
};

const BODY = {
  project: "Long",
  idempotency_key: "one",
  storyboard: { title: "t", projectName: "Master", full_prompt: "x", style_prefix: "", style_category: "", style_preset: "", use_characters: [], cast_rules: "", duration_seconds: 16, clip_seconds: 4, scenes: [1, 2, 3, 4].map((i) => ({ shot_id: `s${i}`, prompt: `p${i}`, seconds: 4 })) },
  character_refs: {},
  part_size: 2,
  shared: { motion_backend: "talk", style: "photoreal", delivery_width: 832, delivery_height: 464 },
  spend_ceiling_usd: 10,
  cost_usd_per_shot_est: 0.5,
};
const post = (path: string, body: unknown) => new Request(`https://studio.example${path}`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: "Bearer t" },
  body: JSON.stringify(body),
});

describe("POST /api/film", () => {
  it("starts part 0 through the real door, with its frame, and only that part", async () => {
    h.started = [];
    const e = env();
    const res = await worker.fetch(post("/api/film", BODY), e as never, ctx);
    await settle();
    expect(res.status).toBe(201);
    const json = (await res.json()) as { film_id: string; parts: number };
    expect(json.parts).toBe(2);
    expect(h.started, "create only writes: a submit must not run where it can be cut off").toHaveLength(0);
    await worker.fetch(new Request(`https://studio.example/api/film/${json.film_id}`), e as never, ctx);
    expect(h.started).toHaveLength(1);
    const tag = json.film_id.slice("feature-".length, "feature-".length + 8);
    expect(h.started[0].project).toBe(`Long_${tag}_p00`);
    // The real assembler made this key, and the door took the project from it. Same project for every
    // part would make the parts overwrite each other's clips.
    expect(String(h.started[0].bundle_key)).toMatch(new RegExp(`^bundles/Long_${tag}_p00-[0-9a-f]{16}\\.tar\\.gz$`));
    expect([h.started[0].delivery_width, h.started[0].delivery_height, h.started[0].reuse_finished]).toEqual([832, 464, true]);
    expect(e.bucket.store.has(`film-parents/active/${json.film_id}`)).toBe(true);
  });

  it("the same key returns the same film and starts nothing", async () => {
    h.started = [];
    const e = env();
    const first = (await (await worker.fetch(post("/api/film", BODY), e as never, ctx)).json()) as { film_id: string };
    await settle();
    const res = await worker.fetch(post("/api/film", BODY), e as never, ctx);
    await settle();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { film_id: string }).film_id).toBe(first.film_id);
    expect(h.started).toHaveLength(0);
    const changed = await worker.fetch(post("/api/film", { ...BODY, spend_ceiling_usd: 99 }), e as never, ctx);
    expect(changed.status, "the same key with a different body is refused").toBe(409);
  });

  it("refuses with no key, and with a bad body, before writing anything", async () => {
    const e = env();
    expect((await worker.fetch(post("/api/film", { ...BODY, idempotency_key: undefined }), e as never, ctx)).status).toBe(400);
    expect((await worker.fetch(post("/api/film", { ...BODY, spend_ceiling_usd: 0 }), e as never, ctx)).status).toBe(400);
    expect(e.bucket.store.size).toBe(0);
  });
});

describe("the router's spend checks reach a part", () => {
  const limiter = (ok: boolean) => ({ limit: async () => ({ success: ok }) });

  it("the routes are on both lists, and a poll is not", async () => {
    const { isSpendRoute } = await import("../src/rate-limit");
    const { isPanelStorageSubmitRoute } = await import("../src/storage-submit-routes");
    for (const p of ["/api/film", "/api/film/x/parts/0/retry", "/api/film/x/resume"]) {
      expect(isSpendRoute("POST", p), p).toBe(true);
      expect(isPanelStorageSubmitRoute("POST", p), p).toBe(true);
    }
    expect(isSpendRoute("POST", "/api/film/x/ceiling")).toBe(true);
    expect(isSpendRoute("GET", "/api/film/x")).toBe(false);
  });

  it("a limiter refusal stops the create at the door", async () => {
    h.started = [];
    const e = env();
    (e as Record<string, unknown>).SPEND_RATE_LIMITER = limiter(false);
    expect((await worker.fetch(post("/api/film", BODY), e as never, ctx)).status).toBe(429);
    expect(e.bucket.store.size).toBe(0);
  });

  it("a part started by a GET is held by the limiter, not bought", async () => {
    h.started = [];
    const e = env();
    const created = (await (await worker.fetch(post("/api/film", BODY), e as never, ctx)).json()) as { film_id: string };
    (e as Record<string, unknown>).SPEND_RATE_LIMITER = limiter(false);
    const view = (await (await worker.fetch(new Request(`https://studio.example/api/film/${created.film_id}`), e as never, ctx)).json()) as { stop_reason: string; parts: Array<{ status: string }> };
    expect(h.started).toEqual([]);
    expect(view.stop_reason).toMatch(/rate limited/);
    expect(view.parts[0].status).toBe("pending");
  });
});

describe("the storage quota reaches a part", () => {
  it("a part started by a GET is held when storage is full", async () => {
    h.started = [];
    const e = env();
    const created = (await (await worker.fetch(post("/api/film", BODY), e as never, ctx)).json()) as { film_id: string };
    h.quotaFull = true;
    const read = await worker.fetch(new Request(`https://studio.example/api/film/${created.film_id}`), e as never, ctx);
    h.quotaFull = false;
    const view = (await read.json()) as { stop_reason: string; parts: Array<{ status: string }> };
    expect(h.started).toEqual([]);
    expect(view.stop_reason).toBe("storage is full");
    expect(view.parts[0].status).toBe("pending");
  });
});

describe("the etag write", () => {
  it("a second writer holding the old etag loses", async () => {
    const e = env();
    const doc = buildParentDoc("feature-x", BODY, 0);
    expect(await insertParent(e as never, doc)).toBe(true);
    expect(await insertParent(e as never, doc), "the id exists").toBe(false);
    const a = await loadParent(e as never, "feature-x");
    const b = await loadParent(e as never, "feature-x");
    expect(await saveParent(e as never, a!)).toBe(true);
    expect(await saveParent(e as never, b!), "b read before a wrote").toBe(false);
    expect(await saveParent(e as never, a!), "a moved its own etag on").toBe(true);
  });

  it("a stopped parent leaves the cron list", async () => {
    const e = env();
    const doc = buildParentDoc("feature-x", BODY, 0);
    await insertParent(e as never, doc);
    const a = await loadParent(e as never, "feature-x");
    a!.doc.phase = "stopped";
    await saveParent(e as never, a!);
    expect(e.bucket.store.has("film-parents/active/feature-x")).toBe(false);
  });
});

describe("GET /api/film/:id", () => {
  it("404s an unknown film", async () => {
    const res = await worker.fetch(new Request("https://studio.example/api/film/feature-none", { headers: { authorization: "Bearer t" } }), env() as never, ctx);
    expect(res.status).toBe(404);
  });
});
