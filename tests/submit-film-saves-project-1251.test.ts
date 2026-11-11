import { describe, it, expect, vi, beforeEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// cf#1251: a film started through POST /api/render/film (MCP submit_film) saves the board it renders
// to a project, from the copy the bundle route keeps beside the bundle, never from the YAML. The
// bundle route is the REAL one (core's assembleBundle writes the tar), D1 is REAL SQLite with the repo
// migrations, and the project rows and the renders row go through core's own SQL. Only the film start
// itself is stubbed, because it would submit GPU work.
const h = vi.hoisted(() => ({ started: [] as Array<Record<string, unknown>> }));
vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_env: unknown, args: Record<string, unknown>) => {
      h.started.push(args);
      return { film_id: `film-1251-${h.started.length}`, project: args.project, bundle_key: args.bundle_key, phase: "keyframe", scenes: args.scenes, created_at: 0, motion_backend: args.motion_backend };
    }),
  };
});

import worker from "../src/index";
import { boardKeyFor } from "../src/film-project";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";

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
  const store = new Map<string, Uint8Array | string>();
  return {
    store,
    async get(key: string) {
      const v = store.get(key);
      if (v === undefined) return null;
      const bytes = typeof v === "string" ? new TextEncoder().encode(v) : v;
      return { key, size: bytes.length, etag: "e", text: async () => new TextDecoder().decode(bytes), json: async () => JSON.parse(new TextDecoder().decode(bytes)), arrayBuffer: async () => bytes.slice().buffer, body: new Response(bytes).body };
    },
    async head(key: string) { const v = store.get(key); return v === undefined ? null : { key, size: typeof v === "string" ? v.length : v.length, etag: "e" }; },
    async put(key: string, body: unknown) {
      const v = typeof body === "string" ? body : body instanceof Uint8Array ? body : new Uint8Array(body as ArrayBuffer);
      store.set(key, v);
      return { key, etag: "e", size: 1 };
    },
    async delete(key: string) { store.delete(key); },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key, size: 1, uploaded: new Date() })), truncated: false };
    },
  };
}

const binding = (name: string, hooks: string[], usage?: unknown) => ({
  fetch: async () => new Response(JSON.stringify({ name, version: "0.1.0", api: MODULE_API, hooks, ui: { order: 1, locality: "cloud" }, usage }),
    { status: 200, headers: { "content-type": "application/json" } }),
});
function env() {
  const { db, d1 } = realD1();
  const bucket = r2();
  return {
    db, bucket,
    env: {
      ALLOW_UNAUTHENTICATED: "true", DB: d1, R2_RENDERS: bucket,
      SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
      MODULE_KEYFRAME: binding("keyframe-sdxl", ["keyframe"]),
      MODULE_DOOR: binding("plain-door", ["motion.backend"], { native_audio: false, voice: "cast_tts", scatter_native_audio: true, min_seconds: 1, max_seconds: 10 }),
    } as never as Record<string, unknown>,
  };
}
const waits: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => { waits.push(p); }, passThroughOnException() {} } as never;
const settle = async () => { while (waits.length) await waits.shift(); };
const call = async (e: unknown, method: string, path: string, body?: unknown) => {
  const res = await worker.fetch(new Request(`https://studio.example${path}`, {
    method, headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), e as never, ctx);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
// A planner board. `full_prompt` and `cast_rules` are planner fields: the point is that the project
// gets back exactly this object, whatever the YAML snapshot keeps.
const BOARD = {
  title: "Two O'Clock", projectName: "Two O'Clock Proof", full_prompt: "a quiet harbor at two", style_prefix: "", style_category: "",
  style_preset: "", use_characters: [], cast_rules: "nobody waves", duration_seconds: 8, clip_seconds: 4,
  scenes: [{ id: "shot_01", prompt: "harbor at two", target_seconds: 4 }, { id: "shot_02", prompt: "a gull lands", target_seconds: 4 }],
};
const SCENES = [{ shot_id: "shot_01", prompt: "harbor at two", seconds: 4 }, { shot_id: "shot_02", prompt: "a gull lands", seconds: 4 }];
type Proj = { id: string; name: string; last_storyboard: unknown };
const projects = async (e: unknown) => (await call(e, "GET", "/api/storyboard/projects")).body.projects as Proj[];
const film = (e: unknown, extra: Record<string, unknown> = {}) =>
  call(e, "POST", "/api/render/film", { bundle_key: extra.bundle_key, scenes: SCENES, motion_backend: "plain-door", shardCount: 1, ...extra });

beforeEach(() => { _resetModuleDiscoveryCache(); h.started = []; });

describe("cf#1251: submit_film saves its board to a project", () => {
  it("submit_film with no project: the panel can reopen exactly the board that was bundled", async () => {
    const { env: e } = env();
    const bundled = await call(e, "POST", "/api/storyboard/bundle", { storyboard: BOARD, characterRefs: {} });
    expect(bundled.status).toBe(201);
    const bundleKey = bundled.body.bundleKey as string;
    const started = await film(e, { bundle_key: bundleKey });
    expect(started.status).toBe(201);
    const list = await projects(e);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Two O'Clock Proof");
    expect(list[0].last_storyboard).toEqual(BOARD);
    expect(started.body.project).toEqual({ saved: true, id: list[0].id, name: "Two O'Clock Proof", created: true });
  });

  it("the renders row carries the project, so history links to it", async () => {
    const { env: e, db } = env();
    const bundleKey = (await call(e, "POST", "/api/storyboard/bundle", { storyboard: BOARD, characterRefs: {} })).body.bundleKey as string;
    await film(e, { bundle_key: bundleKey });
    const row = db.prepare("SELECT r.project_id AS pid, p.public_id AS pub FROM renders r LEFT JOIN storyboard_projects p ON p.id = r.project_id").get() as { pid: number | null; pub: string | null };
    expect(row.pid).not.toBeNull();
    expect(row.pub).toBe((await projects(e))[0].id);
  });

  it("a named projectId gets the board and is written on the renders row", async () => {
    const { env: e, db } = env();
    const mine = (await call(e, "POST", "/api/storyboard/projects", { name: "Mine" })).body.project as Proj;
    const bundleKey = (await call(e, "POST", "/api/storyboard/bundle", { storyboard: BOARD, characterRefs: {} })).body.bundleKey as string;
    const r = await film(e, { bundle_key: bundleKey, projectId: mine.id });
    expect((r.body.project as { id: string }).id).toBe(mine.id);
    expect(await projects(e)).toHaveLength(1);
    const pub = (db.prepare("SELECT p.public_id AS pub FROM renders r JOIN storyboard_projects p ON p.id = r.project_id").get() as { pub: string }).pub;
    expect(pub).toBe(mine.id);
  });

  it("a bundle that never renders makes no project", async () => {
    const { env: e } = env();
    await call(e, "POST", "/api/storyboard/bundle", { storyboard: BOARD, characterRefs: {} });
    expect(await projects(e)).toHaveLength(0);
  });

  it("an old bundle with no kept board still starts the film, says the board was not saved, and never rebuilds it from the YAML", async () => {
    const { env: e, bucket } = env();
    const bundleKey = (await call(e, "POST", "/api/storyboard/bundle", { storyboard: BOARD, characterRefs: {} })).body.bundleKey as string;
    bucket.store.delete(boardKeyFor(bundleKey));
    const r = await film(e, { bundle_key: bundleKey });
    expect(r.status).toBe(201);
    expect(h.started).toHaveLength(1);
    expect(r.body.project).toEqual({ saved: false, error: expect.stringMatching(/not saved/) });
    expect(await projects(e)).toHaveLength(0);
  });

  it("the same film started twice makes one project", async () => {
    const { env: e } = env();
    const bundleKey = (await call(e, "POST", "/api/storyboard/bundle", { storyboard: BOARD, characterRefs: {} })).body.bundleKey as string;
    await film(e, { bundle_key: bundleKey });
    await film(e, { bundle_key: bundleKey });
    expect(await projects(e)).toHaveLength(1);
  });

  it("a long film's parts start through this door and make no project of their own", async () => {
    const { env: e } = env();
    const r = await call(e, "POST", "/api/film", {
      project: "Long", idempotency_key: "one", storyboard: BOARD, character_refs: {}, part_size: 1,
      shared: { motion_backend: "plain-door", style: "photoreal", delivery_width: 832, delivery_height: 464 },
      spend_ceiling_usd: 10, cost_usd_per_shot_est: 0.5, pause_after_first_part: false,
    });
    expect(r.status).toBe(201);
    // The cron starts the parts, each through the film door's handler.
    await worker.scheduled({} as never, e as never, ctx);
    await settle();
    expect(h.started.length, "the tick must have started a part, or this case proves nothing").toBeGreaterThanOrEqual(1);
    const list = await projects(e);
    expect(list).toHaveLength(1);
    expect(list[0].last_storyboard).toEqual(BOARD);
  });

  it("the kept board sits beside the bundle under a name the reclaim's sidecar sweep frees with it", async () => {
    const { env: e, bucket } = env();
    const bundleKey = (await call(e, "POST", "/api/storyboard/bundle", { storyboard: BOARD, characterRefs: {} })).body.bundleKey as string;
    expect(boardKeyFor(bundleKey).startsWith(bundleKey)).toBe(true);
    expect(bucket.store.has(boardKeyFor(bundleKey))).toBe(true);
  });
});
