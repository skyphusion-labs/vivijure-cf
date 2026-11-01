import { describe, it, expect, vi } from "vitest";

// The wiring: routes, the door calls, the etag write. R2 here enforces onlyIf the way the docs describe,
// which is my reading of R2 and not R2 itself. A live run is what proves the conditional write.
const h = vi.hoisted(() => ({
  started: [] as Array<Record<string, unknown>>,
  bundled: [] as unknown[],
  fromKeyframes: [] as Array<Record<string, unknown>>,
  jobs: new Map<string, Record<string, unknown>>(),
  quotaFull: false,
}));
vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    advanceFilmJob: vi.fn(async (_e: unknown, id: string) => {
      const job = h.jobs.get(id);
      return job ? { job, clipJob: null } : null;
    }),
    startFilmFromKeyframes: vi.fn(async (_e: unknown, args: Record<string, unknown>) => {
      h.fromKeyframes.push(args);
      return { film_id: "film-retake", project: args.project, phase: "clips", scenes: args.scenes, created_at: 0 };
    }),
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
  const uploadedAt = new Map<string, Date>();
  let n = 0;
  return {
    store,
    uploadedAt,
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
    async list({ prefix, limit }: { prefix: string; limit?: number }) {
      // In key order, as R2 lists, with the limit applied.
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit ?? 1000);
      return { objects: keys.map((key) => ({ key, uploaded: uploadedAt.get(key) ?? new Date() })) };
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

describe("a persist that throws after the film is out", () => {
  it("still answers 201 and writes the history row", async () => {
    const wan = await import("../src/wan-lora-projection");
    const spy = vi.spyOn(wan, "persistWanLoraProjectionOnFilm").mockRejectedValue(new Error("R2 500"));
    h.started = [];
    const inserted: unknown[][] = [];
    const e = env();
    (e as Record<string, unknown>).DB = {
      ...DB,
      prepare: (sql: string) => ({
        bind: (...a: unknown[]) => {
          if (/INSERT INTO renders/i.test(sql)) inserted.push(a);
          return { first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
        },
        first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }),
      }),
    };
    const res = await worker.fetch(post("/api/render/film", { project: "p", bundle_key: "bundles/p.tar.gz", scenes: [{ shot_id: "shot_01", prompt: "x", seconds: 4 }], motion_backend: "talk" }), e as never, ctx);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
    expect(res.status).toBe(201);
    expect(h.started).toHaveLength(1);
    expect(inserted.length, "the row is what the sweep and the adopt read").toBeGreaterThan(0);
  });
});

describe("GET /api/film", () => {
  it("lists newest first, includes finished films, skips markers, and starts nothing", async () => {
    h.started = [];
    const e = env();
    const a = buildParentDoc("feature-old", BODY, 1000);
    const b = buildParentDoc("feature-new", BODY, 2000);
    await insertParent(e as never, a);
    await insertParent(e as never, b);
    const loaded = await loadParent(e as never, "feature-old");
    loaded!.doc.phase = "done";
    await saveParent(e as never, loaded!);
    const res = await worker.fetch(new Request("https://studio.example/api/film"), e as never, ctx);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { films: Array<{ film_id: string; phase: string; parts?: unknown }> };
    expect(json.films.map((f) => [f.film_id, f.phase])).toEqual([["feature-new", "planned"], ["feature-old", "done"]]);
    expect(json.films[0].parts).toBeUndefined();
    expect(h.started, "a list must not advance anything").toEqual([]);
  });

  it("the limit reaches the listing", async () => {
    const { listParents } = await import("../src/film-parent-store");
    const e = env();
    await insertParent(e as never, buildParentDoc("feature-a", BODY, 1));
    await insertParent(e as never, buildParentDoc("feature-b", BODY, 2));
    await insertParent(e as never, buildParentDoc("feature-c", BODY, 3));
    expect((await listParents(e as never, 2)).map((d) => d.film_id)).toEqual(["feature-c", "feature-b"]);
  });
});

describe("the cron list", () => {
  it("a repeat create does not put a finished film back", async () => {
    const e = env();
    const created = (await (await worker.fetch(post("/api/film", BODY), e as never, ctx)).json()) as { film_id: string };
    const loaded = await loadParent(e as never, created.film_id);
    loaded!.doc.phase = "done";
    await saveParent(e as never, loaded!);
    const marker = `film-parents/active/${created.film_id}`;
    expect(e.bucket.store.has(marker)).toBe(false);
    await worker.fetch(post("/api/film", BODY), e as never, ctx);
    expect(e.bucket.store.has(marker)).toBe(false);
  });

  it("the sweep clears a marker whose film is finished, and a long-orphaned one", async () => {
    const e = env();
    const created = (await (await worker.fetch(post("/api/film", BODY), e as never, ctx)).json()) as { film_id: string };
    const loaded = await loadParent(e as never, created.film_id);
    loaded!.doc.phase = "done";
    await saveParent(e as never, loaded!);
    const marker = `film-parents/active/${created.film_id}`;
    await e.bucket.put(marker, "");
    await e.bucket.put("film-parents/active/feature-gone", "");
    e.bucket.uploadedAt.set("film-parents/active/feature-gone", new Date(Date.now() - 3_600_000));
    await e.bucket.put("film-parents/active/feature-new", "");
    await worker.scheduled({} as never, e as never, ctx);
    await settle();
    expect(e.bucket.store.has(marker)).toBe(false);
    expect(e.bucket.store.has("film-parents/active/feature-gone")).toBe(false);
    expect(e.bucket.store.has("film-parents/active/feature-new"), "a create may still be between its writes").toBe(true);
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

  it("loading fills fields an older doc does not have", async () => {
    const e = env();
    const doc = buildParentDoc("feature-old", BODY, 0) as unknown as Record<string, unknown> & { parts: Array<Record<string, unknown>> };
    delete doc.join_version;
    delete doc.parts[0].retake_est;
    await e.bucket.put("film-parents/feature-old.json", JSON.stringify(doc));
    const loaded = await loadParent(e as never, "feature-old");
    expect(loaded!.doc.join_version).toBe(1);
    expect(loaded!.doc.parts[0].retake_est).toBe(0);
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

describe("POST /api/film/:id/shots/:shot/retake", () => {
  const OLD_JOB = {
    film_id: "film-old", project: "Long_p00", bundle_key: "bundles/Long_p00-a.tar.gz", phase: "done", film_key: "renders/film-old/film.mp4",
    scenes: [{ shot_id: "shot_01", prompt: "p1", seconds: 4 }, { shot_id: "shot_02", prompt: "p2", seconds: 4 }],
    keyframes: [{ shot_id: "shot_01", keyframe_key: "k1" }, { shot_id: "shot_02", keyframe_key: "k2" }],
    motion_backend: "talk", motion_config: { a: 1 }, finish_config: { up: {} }, finish_select: { mode: "default" },
    speech_config: { s: {} }, film_finish_config: { f: {} }, master_config: { m: {} },
    dialogue_lines: [{ shot_id: "shot_02", text: "old", voice_id: "v" }], voice_ref_keys: { shot_02: "vr" },
    style_prefix: "sp", voice_lock: "vl", audio_key: "ak",
    delivery_width: 832, delivery_height: 464, delivery_fps: 24, film_titles: { title: { text: "T" } }, cast_loras: { A: 7 },
  };

  async function doneFilm() {
    const e = env();
    const doc = buildParentDoc("feature-x", { ...BODY, part_size: 4, storyboard: { title: "t", scenes: [1, 2, 3, 4].map((i) => ({ shot_id: `s${i}`, prompt: `p${i}`, seconds: 4 })) } }, 0);
    Object.assign(doc.parts[0], { status: "done", child_film_id: "film-old", output_key: "renders/film-old/film.mp4", attempts: 1 });
    doc.phase = "done";
    doc.output_key = "renders/feature-x/film.mp4";
    await insertParent(e as never, doc);
    h.jobs.set("film-old", OLD_JOB);
    h.started = [];
    h.bundled = [];
    h.fromKeyframes = [];
    return e;
  }

  it("repeats every input of the old job, and names only the retaken shot", async () => {
    const e = await doneFilm();
    const res = await worker.fetch(post("/api/film/feature-x/shots/s2/retake", { line: "new" }), e as never, ctx);
    expect(res.status).toBe(200);
    expect(h.started, "no keyframe stage").toEqual([]);
    expect(h.bundled).toEqual([]);
    expect(h.fromKeyframes).toHaveLength(1);
    const a = h.fromKeyframes[0];
    expect(a.reuse_finished).toBe(true);
    expect(a.retake_shots).toEqual(["shot_02"]);
    expect(a.dialogue_lines).toEqual([{ shot_id: "shot_02", text: "new", voice_id: "v" }]);
    expect(a.scenes).toEqual(OLD_JOB.scenes);
    // A dropped input changes that clip's proof and buys it again, so each one is named.
    const carried = ["project", "bundle_key", "keyframes", "motion_backend", "motion_config", "finish_config", "finish_select", "speech_config", "film_finish_config", "master_config", "voice_ref_keys", "style_prefix", "voice_lock", "audio_key", "delivery_width", "delivery_height", "delivery_fps", "film_titles", "cast_loras"] as const;
    for (const k of carried) expect(a[k], k).toEqual((OLD_JOB as never)[k]);
    const view = (await res.json()) as { phase: string; output_key: string };
    expect(view.output_key, "the delivered film stays").toBe("renders/feature-x/film.mp4");
    expect(view.phase).toBe("running");
  });

  it("writes the history row at once, with the old film's tier", async () => {
    const e = await doneFilm();
    h.jobs.set("film-old", { ...OLD_JOB, quality_tier: "standard" });
    const rows: unknown[][] = [];
    (e as Record<string, unknown>).DB = {
      ...DB,
      prepare: (sql: string) => ({
        bind: (...a: unknown[]) => {
          if (/INSERT INTO renders/i.test(sql)) rows.push(a);
          return { first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
        },
        first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }),
      }),
    };
    await worker.fetch(post("/api/film/feature-x/shots/s2/retake", {}), e as never, ctx);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]).toContain("film-retake");
    expect(rows[0]).toContain("standard");
  });

  it("cancel puts a done film back with no new film", async () => {
    const e = await doneFilm();
    h.fromKeyframes = [];
    const stored = await loadParent(e as never, "feature-x");
    stored!.doc.spend_ceiling_usd = 0.5;
    await saveParent(e as never, stored!);
    await worker.fetch(post("/api/film/feature-x/shots/s2/retake", {}), e as never, ctx);
    expect(h.fromKeyframes, "over the ceiling").toEqual([]);
    const res = await worker.fetch(post("/api/film/feature-x/parts/0/retake/cancel", {}), e as never, ctx);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { phase: string }).phase).toBe("done");
    expect((await worker.fetch(post("/api/film/feature-x/parts/0/retake/cancel", {}), e as never, ctx)).status).toBe(400);
  });

  it("refuses new_still, and an unknown shot, starting nothing", async () => {
    const e = await doneFilm();
    expect((await worker.fetch(post("/api/film/feature-x/shots/s2/retake", { new_still: true }), e as never, ctx)).status).toBe(400);
    expect((await worker.fetch(post("/api/film/feature-x/shots/nope/retake", {}), e as never, ctx)).status).toBe(400);
    expect(h.fromKeyframes).toEqual([]);
  });

  it("a job with no stills fails the part and buys nothing", async () => {
    const e = await doneFilm();
    h.jobs.set("film-old", { ...OLD_JOB, keyframes: undefined });
    const res = await worker.fetch(post("/api/film/feature-x/shots/s2/retake", {}), e as never, ctx);
    const view = (await res.json()) as { parts: Array<{ status: string; error: string }> };
    expect(view.parts[0].status).toBe("failed");
    expect(view.parts[0].error).toMatch(/no stills/);
    expect(h.fromKeyframes).toEqual([]);
  });
});
