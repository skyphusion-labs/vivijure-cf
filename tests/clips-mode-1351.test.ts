import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// #1351 (vivijure-core#458): a standalone clip job row is a "clips" row, read back as "clips", and every
// reader that tells a clip row from a film row accepts the mode as well as the clips- job id.

vi.mock("@skyphusion-labs/vivijure-core/render-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/render-orchestrator")>();
  type Env = { R2_RENDERS: { put(k: string, v: string): Promise<unknown> } };
  return {
    ...actual,
    startClipJob: async (env: Env, args: { project: string; shots: Array<{ shot_id: string; prompt: string }> }) => {
      const job = { job_id: "clips-" + crypto.randomUUID(), project: args.project, motion_backend: "wan", binding: "WAN",
        shots: args.shots.map((s) => ({ ...s, status: "pending", motion_backend: "wan" })), created_at: 1 };
      await env.R2_RENDERS.put(`renders/${job.job_id}/clips-job.json`, JSON.stringify(job));
      return job;
    },
  };
});

import worker from "../src/index";
import { clipJobRowSeed } from "../src/clip-job-row";

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
    async put(key: string, body: unknown) { store.set(key, typeof body === "string" ? body : ""); return { key, etag: "e", size: 1 }; },
    async delete(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 1, uploaded: new Date() })), truncated: false };
    },
  };
}
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
function setup() {
  const { db, d1 } = realD1();
  const env = { ALLOW_UNAUTHENTICATED: "true", SPEND_LIMIT_FAIL_CLOSED: "false", DB: d1, R2_RENDERS: r2() } as never as Record<string, unknown>;
  return { db, env };
}
const call = (env: unknown, method: string, path: string, body?: unknown) => worker.fetch(
  new Request(`https://studio.example${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
  env as never, ctx,
);

/** The panel's two helpers, taken from the shipped file, so a test of them is a test of what ships. */
function panelHelpers(): { isClipJobRow(r: unknown): boolean; historyPassLabel(r: unknown): string } {
  const src = readFileSync(join(__dirname, "..", "public", "planner-history-row.js"), "utf8");
  const grab = (name: string) => {
    const m = new RegExp(`function ${name}\\(r\\) \\{[\\s\\S]*?\\n\\}`).exec(src);
    expect(m, `${name} found in planner-history-row.js`).not.toBeNull();
    return m![0];
  };
  return new Function(`${grab("isClipJobRow")}\n${grab("historyPassLabel")}\nreturn { isClipJobRow, historyPassLabel };`)();
}

describe("#1351 a standalone clip job row is a clips row", () => {
  it("the seed is mode clips", () => {
    const seed = clipJobRowSeed({ job_id: "clips-x", project: "p", motion_backend: "wan", binding: "WAN", shots: [], created_at: 1 } as never);
    expect(seed.mode).toBe("clips");
  });

  it("the list route returns mode clips for it (core 1.41.0 projection)", async () => {
    const { env } = setup();
    const { job_id } = (await (await call(env, "POST", "/api/render/clips", { project: "harbor", shots: [{ shot_id: "s1", prompt: "harbor" }] })).json()) as { job_id: string };
    const list = (await (await call(env, "GET", "/api/storyboard/renders")).json()) as { renders: Array<{ job_id: string; mode: string }> };
    expect(list.renders.find((r) => r.job_id === job_id)?.mode).toBe("clips");
  });

  it("the retry route refuses a clips-mode row even without the clips- id", async () => {
    const { db, env } = setup();
    db.prepare("INSERT INTO renders (job_id, public_id, project, bundle_key, quality_tier, status, submitted_at, updated_at, mode) VALUES ('film-odd', '11111111-2222-4333-8444-555555555555', 'p', '', 'final', 'FAILED', 1, 1, 'clips')").run();
    const pid = (db.prepare("SELECT public_id FROM renders WHERE job_id = 'film-odd'").get() as { public_id: string }).public_id;
    const res = await call(env, "POST", `/api/storyboard/renders/${pid}/retry`, { accept_rederive: true });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/POST \/api\/render\/clips/);
  });

  it("the panel reads a clip row by its mode, and still by the clips- id", () => {
    const { isClipJobRow, historyPassLabel } = panelHelpers();
    expect(isClipJobRow({ mode: "clips", job_id: "x" })).toBe(true);
    expect(isClipJobRow({ mode: "full", job_id: "clips-1" })).toBe(true);
    expect(isClipJobRow({ mode: "full", job_id: "film-1" })).toBe(false);
    expect(isClipJobRow(null)).toBe(false);
    expect(historyPassLabel({ mode: "clips", job_id: "x" })).toBe("clips");
    expect(historyPassLabel({ mode: "full", job_id: "film-1" })).toBe("final");
  });
});
