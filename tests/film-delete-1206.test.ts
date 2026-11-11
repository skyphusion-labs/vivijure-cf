import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// cf#1206: DELETE /api/film/:id removes a film built as parts, as a whole. D1 is REAL SQLite with the
// repo migrations, so the renders, shot_records and storage ledger SQL are the shipped SQL, and the
// reclaim is the same one the render route uses. R2 is an in-memory bucket. The cases are the four
// the issue names: a finished film leaves nothing, a shared object stays, a running film is refused
// and loses nothing, and a failed delete can be run again.
vi.mock("@skyphusion-labs/vivijure-core/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => []) };
});

import worker from "../src/index";
import { buildParentDoc, type ParentDoc } from "../src/film-parent";
import { insertParent } from "../src/film-parent-store";

function realD1() {
  const db = new DatabaseSync(":memory:");
  const dir = join(__dirname, "..", "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (db.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    run: async () => { const r = db.prepare(sql).run(...(args as never[])); return { success: true, meta: { changes: Number(r.changes) } }; },
  });
  return { db, d1: { prepare: (sql: string) => stmt(sql), batch: async (ss: Array<{ run(): Promise<unknown> }>) => { const out = []; for (const s of ss) out.push(await s.run()); return out; } } };
}

function r2(failOnce?: string) {
  const store = new Map<string, { body: string; etag: string }>();
  let n = 0;
  let failed = false;
  const log: string[] = [];
  const bucket = {
    store,
    log,
    async get(key: string) {
      const v = store.get(key);
      return v ? { key, etag: v.etag, size: v.body.length, json: async () => JSON.parse(v.body), text: async () => v.body } : null;
    },
    async head(key: string) { const v = store.get(key); return v ? { key, etag: v.etag, size: v.body.length } : null; },
    async put(key: string, body: string, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      const cur = store.get(key);
      if (opts?.onlyIf?.etagDoesNotMatch === "*" && cur) return null;
      if (opts?.onlyIf?.etagMatches && cur?.etag !== opts.onlyIf.etagMatches) return null;
      const etag = `e${++n}`;
      store.set(key, { body: typeof body === "string" ? body : "", etag });
      log.push(`put ${key}${key.endsWith(".json") && key.startsWith("film-parents/") ? " " + String((JSON.parse(body) as { phase?: string }).phase) : ""}`);
      return { key, etag, size: 1 };
    },
    async delete(keys: string | string[]) {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (failOnce && key === failOnce && !failed) { failed = true; throw new Error("simulated R2 delete failure"); }
        store.delete(key);
        log.push(`delete ${key}`);
      }
    },
    async list({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit);
      return { objects: keys.map((key) => ({ key, size: 1, uploaded: new Date() })), truncated: false };
    },
  };
  return bucket;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const BODY = {
  project: "Harbor", idempotency_key: "k1",
  storyboard: { title: "t", scenes: [1, 2, 3, 4].map((i) => ({ shot_id: `s${i}`, prompt: `p${i}`, seconds: 4 })) },
  character_refs: {}, part_size: 2,
  shared: { motion_backend: "talk", style: "photoreal", delivery_width: 832, delivery_height: 464 },
  spend_ceiling_usd: 10, cost_usd_per_shot_est: 0.5,
};

/** A finished 2 part film, joined twice, with every object it would have written. */
async function seed(opts: { partStatus?: "done" | "running"; failOnce?: string } = {}) {
  const { db, d1 } = realD1();
  const bucket = r2(opts.failOnce);
  const env = { ALLOW_UNAUTHENTICATED: "true", DB: d1, R2_RENDERS: bucket } as never as Record<string, unknown>;
  const doc = buildParentDoc("feature-abc12345", BODY, 1_000) as ParentDoc;
  doc.phase = opts.partStatus === "running" ? "running" : "done";
  doc.join_version = 2;
  doc.output_key = `renders/${doc.film_id}/film-v2.mp4`;
  const own = [`renders/${doc.film_id}/film.mp4`, `renders/${doc.film_id}/film.srt`, doc.output_key, `renders/${doc.film_id}/film-v2.srt`];
  const partKeys: string[] = [];
  doc.parts.forEach((part, i) => {
    const child = `film-part${i}`;
    part.status = opts.partStatus ?? "done";
    part.child_film_id = child;
    part.output_key = `renders/${child}/film.mp4`;
    part.bundle_key = `bundles/${part.project}.tar.gz`;
    const clip = `renders/${part.project}/clips/s${i}_clip.mp4`;
    const still = `renders/${part.project}/keyframes/s${i}.png`;
    partKeys.push(part.output_key, part.bundle_key, clip, still, `renders/${child}/film-job.json`);
    db.prepare(`INSERT INTO renders (job_id, project, bundle_key, status, submitted_at, output_key, keyframes_json) VALUES (?, ?, ?, 'COMPLETED', 1, ?, ?)`)
      .run(child, part.project, part.bundle_key, part.output_key, JSON.stringify([{ shot_id: `s${i}`, key: still }, { shot_id: "shared", key: "cast/shared-portrait.png" }]));
    db.prepare(`INSERT INTO shot_records (film_id, shot_id, clip_key, step, updated_at) VALUES (?, ?, ?, 'done', 1)`).run(child, `s${i}`, clip);
  });
  // A render outside this film that names the same portrait. It must keep it.
  db.prepare(`INSERT INTO renders (job_id, project, status, submitted_at, keyframes_json) VALUES ('film-other', 'other', 'COMPLETED', 1, ?)`)
    .run(JSON.stringify([{ shot_id: "x", key: "cast/shared-portrait.png" }]));
  for (const k of [...own, ...partKeys, "cast/shared-portrait.png"]) await bucket.put(k, k.endsWith(".json") ? JSON.stringify({ film_id: k.split("/")[1] }) : "bytes");
  await insertParent(env as never, doc);
  return { env, db, bucket, doc, own, partKeys };
}

const del = (env: unknown, id: string) => worker.fetch(
  new Request(`https://studio.example/api/film/${id}`, { method: "DELETE", headers: { authorization: "Bearer t" } }), env as never, ctx);
const rows = (db: DatabaseSync) => (db.prepare("SELECT job_id FROM renders ORDER BY job_id").all() as Array<{ job_id: string }>).map((r) => r.job_id);

describe("cf#1206: DELETE /api/film/:id", () => {
  it("a finished 2 part film: nothing of it is left", async () => {
    const { env, db, bucket, doc, own, partKeys } = await seed();
    const res = await del(env, doc.film_id);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, number>;
    expect(body.renders_removed).toBe(2);
    for (const k of [...own, ...partKeys]) expect(bucket.store.has(k), k).toBe(false);
    expect([...bucket.store.keys()].filter((k) => k.startsWith("film-parents/"))).toEqual([]);
    expect(rows(db)).toEqual(["film-other"]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM shot_records").get() as { n: number }).n).toBe(0);
    expect((await worker.fetch(new Request(`https://studio.example/api/film/${doc.film_id}`, { headers: { authorization: "Bearer t" } }), env as never, ctx)).status).toBe(404);
    expect(body.objects_freed).toBeGreaterThanOrEqual(own.length + partKeys.length);
  });

  it("an object a surviving render names stays", async () => {
    const { env, bucket, doc } = await seed();
    const res = await del(env, doc.film_id);
    expect(res.status).toBe(200);
    expect(bucket.store.has("cast/shared-portrait.png")).toBe(true);
    expect(((await res.json()) as { objects_retained: number }).objects_retained).toBeGreaterThanOrEqual(1);
  });

  it("a running film is refused and loses nothing", async () => {
    const { env, db, bucket, doc } = await seed({ partStatus: "running" });
    const before = [...bucket.store.keys()].sort();
    const res = await del(env, doc.film_id);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/still rendering/);
    expect([...bucket.store.keys()].sort()).toEqual(before);
    expect(rows(db)).toEqual(["film-other", "film-part0", "film-part1"]);
  });

  it("a film that could still start a part is stopped before anything goes, so the cron cannot race it", async () => {
    const { env, bucket, doc } = await seed();
    // Waiting for its first part: the cron would claim it.
    const raw = JSON.parse(bucket.store.get(`film-parents/${doc.film_id}.json`)!.body) as ParentDoc;
    raw.phase = "planned";
    for (const p of raw.parts) p.status = "pending";
    await bucket.put(`film-parents/${doc.film_id}.json`, JSON.stringify(raw));
    bucket.log.length = 0;
    const res = await del(env, doc.film_id);
    expect(res.status).toBe(200);
    expect(bucket.store.has(`film-parents/active/${doc.film_id}`)).toBe(false);
    // The stop is the FIRST write, before any object goes: a cron claim after it fails its etag.
    const firstDelete = bucket.log.findIndex((l) => l.startsWith("delete "));
    const stop = bucket.log.indexOf(`put film-parents/${doc.film_id}.json stopped`);
    expect(stop, bucket.log.join("\n")).toBeGreaterThanOrEqual(0);
    expect(stop).toBeLessThan(firstDelete);
  });

  it("a part whose render row was never written still has its files freed", async () => {
    const { env, db, bucket, doc } = await seed();
    db.prepare("DELETE FROM renders WHERE job_id = 'film-part1'").run();
    const res = await del(env, doc.film_id);
    expect(res.status).toBe(200);
    expect([...bucket.store.keys()].filter((k) => k.startsWith("renders/film-part1/"))).toEqual([]);
  });

  it("a failed delete can be run again, and the second run finishes", async () => {
    const { env, db, bucket, doc, own, partKeys } = await seed({ failOnce: "renders/film-part1/film.mp4" });
    const first = await del(env, doc.film_id);
    expect(first.status).toBe(409);
    // The doc is still there, so the film can be found and the delete repeated.
    expect(bucket.store.has(`film-parents/${doc.film_id}.json`)).toBe(true);
    const second = await del(env, doc.film_id);
    expect(second.status).toBe(200);
    for (const k of [...own, ...partKeys]) expect(bucket.store.has(k), k).toBe(false);
    expect(rows(db)).toEqual(["film-other"]);
  });

  it("an unknown film is 404", async () => {
    const { env } = await seed();
    expect((await del(env, "feature-nope")).status).toBe(404);
  });
});
