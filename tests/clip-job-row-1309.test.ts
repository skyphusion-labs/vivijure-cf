import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// cf#1309: POST /api/render/clips writes a renders row, so a standalone clip job is in history, render
// delete reaches it, and the #1009 sweep can judge its tree. These drive the real Worker through
// worker.fetch. D1 is REAL SQLite with the repo migrations, so every row is written and read by the
// shipped SQL. R2 is an in-memory bucket that logs each write, so the ORDER is asserted, not assumed.
//
// The GPU is the one seam stubbed, and only in the cases that need a clip to finish: `gpu.real` runs
// core's own startClipJob, which with no motion module installed fails every shot and still writes the
// job doc. That case is the un-stubbed one: the doc, the marker and the row all come from shipped code.

const gpu = { real: false };

vi.mock("@skyphusion-labs/vivijure-core/render-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/render-orchestrator")>();
  type Env = { R2_RENDERS: { put(k: string, v: string): Promise<unknown>; get(k: string): Promise<{ json(): Promise<unknown> } | null> } };
  return {
    ...actual,
    startClipJob: async (env: Env, args: { project: string; shots: Array<{ shot_id: string; prompt: string }> }, ...rest: unknown[]) => {
      if (gpu.real) return (actual.startClipJob as (...a: unknown[]) => unknown)(env, args, ...rest);
      const job = {
        job_id: "clips-" + crypto.randomUUID(), project: args.project, motion_backend: "wan", binding: "WAN",
        shots: args.shots.map((s) => ({ ...s, status: "pending", motion_backend: "wan" })), created_at: 1,
      };
      await env.R2_RENDERS.put(`renders/${job.job_id}/clips-job.json`, JSON.stringify(job));
      return job;
    },
    advanceClipJob: async (env: Env, jobId: string, ...rest: unknown[]) => {
      if (gpu.real) return (actual.advanceClipJob as (...a: unknown[]) => unknown)(env, jobId, ...rest);
      const o = await env.R2_RENDERS.get(`renders/${jobId}/clips-job.json`);
      if (!o) return null;
      const job = (await o.json()) as { project: string; shots: Array<Record<string, unknown>> };
      for (const sh of job.shots) {
        if (sh.status !== "pending") continue;
        if (sh.shot_id === "bad") { sh.status = "failed"; sh.error = "module said no"; continue; }
        sh.status = "done";
        sh.clip_key = `renders/${job.project}/clips/${String(sh.shot_id)}_wan.mp4`;
        await env.R2_RENDERS.put(String(sh.clip_key), "bytes");
      }
      await env.R2_RENDERS.put(`renders/${jobId}/clips-job.json`, JSON.stringify(job));
      return job;
    },
  };
});

import worker from "../src/index";

function realD1(opts: { failInsert?: boolean } = {}) {
  const db = new DatabaseSync(":memory:");
  const dir = join(__dirname, "..", "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  const state = { failInsert: opts.failInsert ?? false };
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (db.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    run: async () => {
      if (state.failInsert && /^\s*INSERT INTO renders/.test(sql)) throw new Error("simulated D1 storage timeout");
      const r = db.prepare(sql).run(...(args as never[]));
      return { success: true, meta: { changes: Number(r.changes) } };
    },
  });
  return { db, state, d1: { prepare: (sql: string) => stmt(sql), batch: async (ss: Array<{ run(): Promise<unknown> }>) => { const out = []; for (const s of ss) out.push(await s.run()); return out; } } };
}

function r2() {
  const store = new Map<string, string>();
  const log: string[] = [];
  return {
    store,
    log,
    async get(key: string) { const v = store.get(key); return v === undefined ? null : { key, size: v.length, json: async () => JSON.parse(v), text: async () => v }; },
    async head(key: string) { return store.has(key) ? { key, size: 1 } : null; },
    async put(key: string, body: unknown) { store.set(key, typeof body === "string" ? body : ""); log.push(`put ${key}`); return { key, etag: "e", size: 1 }; },
    async delete(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) { store.delete(k); log.push(`delete ${k}`); } },
    async list({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) {
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit);
      return { objects: keys.map((key) => ({ key, size: 1, uploaded: new Date() })), truncated: false };
    },
  };
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
function setup(opts: { failInsert?: boolean } = {}) {
  const { db, d1, state } = realD1(opts);
  const bucket = r2();
  const env = { ALLOW_UNAUTHENTICATED: "true", SPEND_LIMIT_FAIL_CLOSED: "false", DB: d1, R2_RENDERS: bucket } as never as Record<string, unknown>;
  return { db, state, bucket, env };
}
const call = (env: unknown, method: string, path: string, body?: unknown) => worker.fetch(
  new Request(`https://studio.example${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
  env as never, ctx,
);
const rowsOf = (db: DatabaseSync) => db.prepare("SELECT job_id, project, status, mode, bundle_key, output_json, error FROM renders ORDER BY id").all() as Array<Record<string, string | null>>;
const SHOTS = [{ shot_id: "s1", prompt: "a harbor at dawn" }, { shot_id: "s2", prompt: "gulls" }];

beforeEach(() => { gpu.real = false; });

describe("cf#1309 the standalone door writes a row that owns its tree", () => {
  it("UN-STUBBED: core startClipJob with no motion module still yields doc, marker, then a FAILED row", async () => {
    gpu.real = true;
    const { db, bucket, env } = setup();
    const res = await call(env, "POST", "/api/render/clips", { project: "harbor", shots: SHOTS });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { job_id: string };
    expect(body.job_id).toMatch(/^clips-[0-9a-f-]{36}$/);
    const id = body.job_id;
    // Doc first, marker second. The row is written after both (asserted by the heal case below).
    const puts = bucket.log.filter((l) => l.startsWith("put renders/" + id));
    expect(puts).toEqual([`put renders/${id}/clips-job.json`, `put renders/${id}/owner.json`]);
    const rows = rowsOf(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_id: id, project: "harbor", status: "FAILED", mode: "clips" });
    expect(rows[0].error).toMatch(/s1: .*no motion.backend module installed/);
  });

  it("an in-flight job is IN_PROGRESS in history, and a poll moves it to COMPLETED naming its clips", async () => {
    const { db, env } = setup();
    const body = (await (await call(env, "POST", "/api/render/clips", { project: "harbor", shots: SHOTS })).json()) as { job_id: string };
    expect(rowsOf(db)[0]).toMatchObject({ job_id: body.job_id, status: "IN_PROGRESS", mode: "clips", bundle_key: "" });

    const list = (await (await call(env, "GET", "/api/storyboard/renders")).json()) as { renders: Array<{ job_id: string; status: string }> };
    expect(list.renders.map((r) => [r.job_id, r.status])).toEqual([[body.job_id, "IN_PROGRESS"]]);

    expect((await call(env, "GET", `/api/render/clips/${body.job_id}`)).status).toBe(200);
    const row = rowsOf(db)[0];
    expect(row).toMatchObject({ status: "COMPLETED", mode: "clips" });
    expect(JSON.parse(String(row.output_json)).clips).toEqual([
      { shot_id: "s1", key: "renders/harbor/clips/s1_wan.mp4", model: "wan" },
      { shot_id: "s2", key: "renders/harbor/clips/s2_wan.mp4", model: "wan" },
    ]);
  });

  it("a partial job is COMPLETED with the failed shot named, and an all-failed one is FAILED", async () => {
    const { db, env } = setup();
    const a = (await (await call(env, "POST", "/api/render/clips", { project: "p", shots: [{ shot_id: "s1", prompt: "x" }, { shot_id: "bad", prompt: "y" }] })).json()) as { job_id: string };
    await call(env, "GET", `/api/render/clips/${a.job_id}`);
    expect(rowsOf(db)[0]).toMatchObject({ status: "COMPLETED", error: "bad: module said no" });
    const b = (await (await call(env, "POST", "/api/render/clips", { project: "p", shots: [{ shot_id: "bad", prompt: "y" }] })).json()) as { job_id: string };
    await call(env, "GET", `/api/render/clips/${b.job_id}`);
    expect(rowsOf(db)[1]).toMatchObject({ job_id: b.job_id, status: "FAILED" });
  });
});

describe("cf#1309 failure posture: every gap fails toward keep, and the poll heals", () => {
  it("a row insert that throws does not fail the started job, and the next poll inserts the row", async () => {
    const { db, state, bucket, env } = setup({ failInsert: true });
    const res = await call(env, "POST", "/api/render/clips", { project: "harbor", shots: SHOTS });
    expect(res.status).toBe(200);
    const { job_id } = (await res.json()) as { job_id: string };
    expect(rowsOf(db)).toHaveLength(0);
    expect(bucket.store.has(`renders/${job_id}/owner.json`)).toBe(true);
    state.failInsert = false;
    await call(env, "GET", `/api/render/clips/${job_id}`);
    expect(rowsOf(db)).toEqual([expect.objectContaining({ job_id, status: "COMPLETED", mode: "clips" })]);
  });

  it("a film's clip job (no owner marker) polled through the clips route gets NO row", async () => {
    const { db, bucket, env } = setup();
    const id = "clips-" + crypto.randomUUID();
    await bucket.put(`renders/${id}/clips-job.json`, JSON.stringify({ job_id: id, project: "p", motion_backend: "wan", binding: "WAN", shots: [{ shot_id: "s1", prompt: "x", status: "pending" }], created_at: 1 }));
    expect((await call(env, "GET", `/api/render/clips/${id}`)).status).toBe(200);
    expect(rowsOf(db)).toHaveLength(0);
  });
});

describe("cf#1309 the row's actions", () => {
  async function finished() {
    const s = setup();
    const { job_id } = (await (await call(s.env, "POST", "/api/render/clips", { project: "harbor", shots: SHOTS })).json()) as { job_id: string };
    await call(s.env, "GET", `/api/render/clips/${job_id}`);
    const pid = (s.db.prepare("SELECT public_id FROM renders WHERE job_id = ?").get(job_id) as { public_id: string }).public_id;
    return { ...s, job_id, pid };
  }

  it("render delete frees the doc, the marker, the log, the clips and an archived take, then drops the row", async () => {
    const { db, bucket, env, job_id, pid } = await finished();
    await bucket.put(`renders/logs/${job_id}.txt`, "log");
    // An archived take is named ONLY by the clip job doc (archiveExistingClipTakes), never by the row.
    const doc = JSON.parse(bucket.store.get(`renders/${job_id}/clips-job.json`) as string) as { shots: Array<Record<string, unknown>> };
    doc.shots[0].takes = [{ key: "renders/harbor/clips/s1_wan_take1700000000.mp4" }];
    await bucket.put(`renders/${job_id}/clips-job.json`, JSON.stringify(doc));
    await bucket.put("renders/harbor/clips/s1_wan_take1700000000.mp4", "bytes");
    const res = await call(env, "DELETE", `/api/storyboard/renders/${pid}`);
    expect(res.status).toBe(200);
    expect(rowsOf(db)).toHaveLength(0);
    expect([...bucket.store.keys()].filter((k) => k.includes(job_id) || k.startsWith("renders/harbor/"))).toEqual([]);
  });

  it("render delete keeps a clip a surviving record still names", async () => {
    const { db, bucket, env, pid } = await finished();
    // A surviving film of the same project whose shot record names s1's clip (the reclaim gate reads the
    // shot records of surviving renders rows).
    db.prepare("INSERT INTO renders (job_id, project, status, submitted_at) VALUES ('film-other', 'harbor', 'COMPLETED', 1)").run();
    db.prepare("INSERT INTO shot_records (film_id, shot_id, clip_key, step, updated_at) VALUES ('film-other', 's1', 'renders/harbor/clips/s1_wan.mp4', 'done', 1)").run();
    expect((await call(env, "DELETE", `/api/storyboard/renders/${pid}`)).status).toBe(200);
    expect(bucket.store.has("renders/harbor/clips/s1_wan.mp4")).toBe(true);
    expect(bucket.store.has("renders/harbor/clips/s2_wan.mp4")).toBe(false);
  });

  it("retry is refused with the door that can repeat it, and starts nothing", async () => {
    const { db, env } = setup();
    const { job_id } = (await (await call(env, "POST", "/api/render/clips", { project: "p", shots: [{ shot_id: "bad", prompt: "y" }] })).json()) as { job_id: string };
    await call(env, "GET", `/api/render/clips/${job_id}`);
    const pid = (db.prepare("SELECT public_id FROM renders WHERE job_id = ?").get(job_id) as { public_id: string }).public_id;
    const res = await call(env, "POST", `/api/storyboard/renders/${pid}/retry`, { accept_rederive: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/POST \/api\/render\/clips/);
    expect(rowsOf(db)).toHaveLength(1);
  });
});
