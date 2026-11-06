import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// cf#1315: GET /api/render/clips/:id advances a standalone clip job under a lease, so two polls that
// overlap cannot both advance it (from core 1.35.0, both would buy the same batch). These drive the
// real Worker through worker.fetch over REAL SQLite D1 with the repo migrations, so the lease is the
// shipped conditional UPDATE on the renders row. The one seam stubbed is advanceClipJob, which counts
// its calls and can be held open, so two polls genuinely overlap.

const gate = { hold: null as Promise<void> | null, calls: 0, throwOnce: false };

vi.mock("@skyphusion-labs/vivijure-core/render-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/render-orchestrator")>();
  type Env = { R2_RENDERS: { put(k: string, v: string): Promise<unknown>; get(k: string): Promise<{ text(): Promise<string> } | null> } };
  return {
    ...actual,
    startClipJob: async (env: Env, args: { project: string; shots: Array<{ shot_id: string; prompt: string }> }) => {
      const job = {
        job_id: "clips-" + crypto.randomUUID(), project: args.project, motion_backend: "wan", binding: "WAN",
        shots: args.shots.map((s) => ({ ...s, status: "pending", motion_backend: "wan" })), created_at: 1,
      };
      await env.R2_RENDERS.put(`renders/${job.job_id}/clips-job.json`, JSON.stringify(job));
      return job;
    },
    advanceClipJob: async (env: Env, jobId: string) => {
      gate.calls += 1;
      if (gate.hold) await gate.hold;
      if (gate.throwOnce) { gate.throwOnce = false; throw new Error("tick died"); }
      const o = await env.R2_RENDERS.get(`renders/${jobId}/clips-job.json`);
      return o ? JSON.parse(await o.text()) : null;
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
  return {
    store,
    async get(key: string) { const v = store.get(key); return v === undefined ? null : { key, size: v.length, json: async () => JSON.parse(v), text: async () => v }; },
    async head(key: string) { return store.has(key) ? { key, size: 1 } : null; },
    async put(key: string, body: unknown) { store.set(key, typeof body === "string" ? body : ""); return { key, etag: "e", size: 1 }; },
    async delete(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 1, uploaded: new Date() })), truncated: false };
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
const SHOTS = [{ shot_id: "s1", prompt: "a harbor at dawn" }];
const startJob = async (env: unknown) =>
  ((await (await call(env, "POST", "/api/render/clips", { project: "harbor", shots: SHOTS })).json()) as { job_id: string }).job_id;
const leaseOf = (db: DatabaseSync, id: string) =>
  db.prepare("SELECT advance_lease, advance_lease_token FROM renders WHERE job_id = ?").get(id) as { advance_lease: number | null; advance_lease_token: string | null } | undefined;

/** Hold advanceClipJob open until the returned release is called. */
function holdAdvance(): () => void {
  let release!: () => void;
  gate.hold = new Promise<void>((r) => { release = r; });
  return () => { gate.hold = null; release(); };
}

beforeEach(() => { gate.hold = null; gate.calls = 0; gate.throwOnce = false; vi.spyOn(console, "log").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); });

describe("cf#1315 two polls of one standalone clip job never advance it at once", () => {
  it("the overlapping poll does not advance, answers 200 from the doc, and says so", async () => {
    const { env } = setup();
    const id = await startJob(env);
    const release = holdAdvance();
    const first = call(env, "GET", `/api/render/clips/${id}`);
    await vi.waitFor(() => expect(gate.calls).toBe(1));
    const second = await call(env, "GET", `/api/render/clips/${id}`);
    expect(second.status).toBe(200);
    const b2 = (await second.json()) as { advanced: boolean; job_id: string };
    expect(b2).toMatchObject({ advanced: false, job_id: id });
    expect(gate.calls).toBe(1);
    release();
    const b1 = (await (await first).json()) as { advanced: boolean };
    expect(b1.advanced).toBe(true);
  });

  it("CONTROL: polls in sequence each advance, because the lease is released", async () => {
    const { db, env } = setup();
    const id = await startJob(env);
    await call(env, "GET", `/api/render/clips/${id}`);
    await call(env, "GET", `/api/render/clips/${id}`);
    expect(gate.calls).toBe(2);
    expect(leaseOf(db, id)).toMatchObject({ advance_lease: null, advance_lease_token: null });
  });

  it("a poll whose advance throws still releases the lease, and the next poll advances", async () => {
    const { db, env } = setup();
    const id = await startJob(env);
    gate.throwOnce = true;
    expect((await call(env, "GET", `/api/render/clips/${id}`)).status).toBeGreaterThanOrEqual(500);
    expect(leaseOf(db, id)).toMatchObject({ advance_lease: null });
    expect((await call(env, "GET", `/api/render/clips/${id}`)).status).toBe(200);
    expect(gate.calls).toBe(2);
  });
});

describe("cf#1315 a standalone job whose row is missing is still guarded", () => {
  it("the first poll writes the row before it claims, so an overlapping poll is refused", async () => {
    const { db, state, env } = setup({ failInsert: true });
    const id = await startJob(env);
    expect(leaseOf(db, id)).toBeUndefined();
    state.failInsert = false;
    const release = holdAdvance();
    const first = call(env, "GET", `/api/render/clips/${id}`);
    await vi.waitFor(() => expect(gate.calls).toBe(1));
    expect(leaseOf(db, id)?.advance_lease_token).toEqual(expect.any(String));
    const b2 = (await (await call(env, "GET", `/api/render/clips/${id}`)).json()) as { advanced: boolean };
    expect(b2.advanced).toBe(false);
    expect(gate.calls).toBe(1);
    release();
    await first;
  });
});

describe("cf#1315 what the lease does not cover", () => {
  it("CONTROL: a film's clip job (no owner marker, no row) still advances through the route, unguarded, and gets no row", async () => {
    const { db, bucket, env } = setup();
    const id = "clips-" + crypto.randomUUID();
    await bucket.put(`renders/${id}/clips-job.json`, JSON.stringify({ job_id: id, project: "p", motion_backend: "wan", binding: "WAN", shots: [{ shot_id: "s1", prompt: "x", status: "pending" }], created_at: 1 }));
    const b = (await (await call(env, "GET", `/api/render/clips/${id}`)).json()) as { advanced: boolean };
    expect(b.advanced).toBe(true);
    expect(gate.calls).toBe(1);
    expect(leaseOf(db, id)).toBeUndefined();
  });
});
