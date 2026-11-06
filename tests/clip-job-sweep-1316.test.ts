import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// cf#1316: the sweep advances standalone clip jobs nobody polls, under the same lease as the poll route.
// Real Worker routes and real SQLite D1 with the repo migrations. The one stub is advanceClipJob, which
// counts its calls, can be held open, and can throw for a named job.

const gate = { hold: null as Promise<void> | null, calls: [] as string[], throwFor: new Set<string>() };

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
      gate.calls.push(jobId);
      if (gate.hold) await gate.hold;
      if (gate.throwFor.has(jobId)) throw new Error("door down");
      const o = await env.R2_RENDERS.get(`renders/${jobId}/clips-job.json`);
      if (!o) return null;
      const job = JSON.parse(await o.text()) as { project: string; shots: Array<Record<string, unknown>> };
      for (const sh of job.shots) { sh.status = "done"; sh.clip_key = `renders/${job.project}/clips/${String(sh.shot_id)}_wan.mp4`; }
      await env.R2_RENDERS.put(`renders/${jobId}/clips-job.json`, JSON.stringify(job));
      return job;
    },
  };
});

import worker from "../src/index";
import { runSweepPass } from "../src/studio";
import { sweepStandaloneClipJobs, CLIP_SWEEP_PAGE } from "../src/clip-job-sweep";

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
function r2() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { const v = store.get(key); return v === undefined ? null : { key, size: v.length, etag: "e", json: async () => JSON.parse(v), text: async () => v }; },
    async head(key: string) { return store.has(key) ? { key, size: 1, etag: "e" } : null; },
    async put(key: string, body: unknown) { store.set(key, typeof body === "string" ? body : ""); return { key, etag: "e" + store.size, size: 1 }; },
    async delete(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 1, uploaded: new Date() })), truncated: false };
    },
  };
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
function setup() {
  const { db, d1 } = realD1();
  const bucket = r2();
  const env = { ALLOW_UNAUTHENTICATED: "true", SPEND_LIMIT_FAIL_CLOSED: "false", DB: d1, R2_RENDERS: bucket } as never as Record<string, unknown>;
  return { db, bucket, env };
}
const call = (env: unknown, method: string, path: string, body?: unknown) => worker.fetch(
  new Request(`https://studio.example${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
  env as never, ctx,
);
const start = async (env: unknown) =>
  ((await (await call(env, "POST", "/api/render/clips", { project: "harbor", shots: [{ shot_id: "s1", prompt: "harbor" }] })).json()) as { job_id: string }).job_id;
const statusOf = (db: DatabaseSync, id: string) => (db.prepare("SELECT status FROM renders WHERE job_id = ?").get(id) as { status: string } | undefined)?.status;

beforeEach(() => {
  gate.hold = null; gate.calls = []; gate.throwFor = new Set();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("cf#1316 the sweep advances a standalone clip job nobody polls", () => {
  it("an unpolled job is advanced and its row moves to COMPLETED", async () => {
    const { db, env } = setup();
    const id = await start(env);
    expect(statusOf(db, id)).toBe("IN_PROGRESS");
    const r = await sweepStandaloneClipJobs(env as never);
    expect(r).toMatchObject({ listed: 1, advanced: 1, busy: 0 });
    expect(gate.calls).toEqual([id]);
    expect(statusOf(db, id)).toBe("COMPLETED");
  });

  it("a job a poll is advancing is skipped, never advanced twice at once", async () => {
    const { env } = setup();
    const id = await start(env);
    let release!: () => void;
    gate.hold = new Promise<void>((r) => { release = r; });
    const poll = call(env, "GET", `/api/render/clips/${id}`);
    await vi.waitFor(() => expect(gate.calls.length).toBe(1));
    const r = await sweepStandaloneClipJobs(env as never);
    expect(r).toMatchObject({ listed: 1, advanced: 0, busy: 1 });
    expect(gate.calls).toEqual([id]);
    gate.hold = null; release();
    await poll;
  });

  it("CONTROL: a terminal row, a film row and an unmarked clips row are not driven", async () => {
    const { db, bucket, env } = setup();
    const done = await start(env);
    await sweepStandaloneClipJobs(env as never); // drives it to COMPLETED
    gate.calls = [];
    const unmarked = "clips-" + crypto.randomUUID();
    db.prepare("INSERT INTO renders (job_id, project, bundle_key, quality_tier, status, submitted_at, updated_at, mode) VALUES (?, 'p', '', 'final', 'IN_PROGRESS', 1, 1, 'full')").run(unmarked);
    db.prepare("INSERT INTO renders (job_id, project, bundle_key, quality_tier, status, submitted_at, updated_at, mode) VALUES (?, 'p', 'b', 'final', 'IN_PROGRESS', 1, 1, 'full')").run("film-" + crypto.randomUUID());
    await bucket.put(`renders/${unmarked}/clips-job.json`, JSON.stringify({ job_id: unmarked, project: "p", shots: [], created_at: 1 }));
    const r = await sweepStandaloneClipJobs(env as never);
    expect(statusOf(db, done)).toBe("COMPLETED");
    expect(r).toMatchObject({ listed: 1, not_standalone: 1, advanced: 0 });
    expect(gate.calls).toEqual([]);
  });

  it("one job that throws does not stop the next", async () => {
    const { db, env } = setup();
    const a = await start(env);
    const b = await start(env);
    gate.throwFor.add(a);
    const r = await sweepStandaloneClipJobs(env as never);
    expect(r).toMatchObject({ listed: 2, advanced: 1, failed: 1 });
    expect(statusOf(db, b)).toBe("COMPLETED");
    expect(statusOf(db, a)).toBe("IN_PROGRESS");
  });

  it("a pass drives at most a page, and the minute rotation reaches every job", async () => {
    const { db, env } = setup();
    const ids: string[] = [];
    for (let i = 0; i < CLIP_SWEEP_PAGE * 2 + 2; i++) ids.push(await start(env));
    gate.throwFor = new Set(ids); // nothing completes, so every job stays listed for every pass
    const seen = new Set<string>();
    for (let minute = 0; minute < 3; minute++) {
      const before = gate.calls.length;
      const r = await sweepStandaloneClipJobs(env as never, minute * 60_000);
      expect(r.listed).toBeLessThanOrEqual(CLIP_SWEEP_PAGE);
      gate.calls.slice(before).forEach((c) => seen.add(c));
    }
    expect(seen.size).toBe(ids.length);
    void db;
  });

  it("runSweepPass drives the clip sweep, even when the other sweeps fail", async () => {
    const { db, env } = setup();
    const id = await start(env);
    await runSweepPass(env as never, ctx, "cron");
    expect(gate.calls).toContain(id);
    expect(statusOf(db, id)).toBe("COMPLETED");
  });
});
