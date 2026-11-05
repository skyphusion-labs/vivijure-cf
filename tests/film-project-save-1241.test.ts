import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// cf#1241: a film started through the API must leave a project the panel can reopen. The database
// here is REAL SQLite with the repo's own migrations, and the project rows go through core's real
// createProject / setLastStoryboard / listProjects. So this proves the SQL, not my idea of it.
// What it cannot prove is D1 itself; the live check in the PR is what covers that.
vi.mock("@skyphusion-labs/vivijure-core/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => []) };
});

import worker from "../src/index";
import { chooseFilmProject, stableJson } from "../src/film-project";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";

function realD1() {
  const db = new DatabaseSync(":memory:");
  const dir = join(__dirname, "..", "migrations");
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  const stmt = (sql: string, args: unknown[] = []) => ({
    bind: (...a: unknown[]) => stmt(sql, a),
    first: async () => (db.prepare(sql).get(...(args as never[])) as Record<string, unknown> | undefined) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...(args as never[])) }),
    run: async () => { db.prepare(sql).run(...(args as never[])); return { success: true, meta: {} }; },
  });
  return { db, d1: { prepare: (sql: string) => stmt(sql), batch: async (ss: Array<{ run(): Promise<unknown> }>) => Promise.all(ss.map((s) => s.run())) } };
}

function r2() {
  const store = new Map<string, { body: string; etag: string }>();
  let n = 0;
  return {
    async get(key: string) {
      const v = store.get(key);
      return v ? { etag: v.etag, json: async () => JSON.parse(v.body), text: async () => v.body } : null;
    },
    async head(key: string) { const v = store.get(key); return v ? { etag: v.etag, size: v.body.length } : null; },
    async put(key: string, body: string, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      const cur = store.get(key);
      if (opts?.onlyIf?.etagDoesNotMatch === "*" && cur) return null;
      if (opts?.onlyIf?.etagMatches && cur?.etag !== opts.onlyIf.etagMatches) return null;
      const etag = `e${++n}`;
      store.set(key, { body, etag });
      return { etag };
    },
    async delete(key: string) { store.delete(key); },
    async list({ prefix }: { prefix: string }) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key, uploaded: new Date() })) };
    },
  };
}

function moduleBinding(name: string, hooks: string[]) {
  return {
    fetch: async () => new Response(JSON.stringify({ name, version: "0.1.0", api: MODULE_API, hooks, ui: { order: 10, locality: "cloud" } }),
      { status: 200, headers: { "content-type": "application/json" } }),
  };
}

function env() {
  const { d1 } = realD1();
  return {
    ALLOW_UNAUTHENTICATED: "true",
    SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
    DB: d1, R2_RENDERS: r2(),
    MODULE_KEYFRAME: moduleBinding("keyframe", ["keyframe"]),
    MODULE_TALK: moduleBinding("talk", ["motion.backend"]),
  } as never as Record<string, unknown>;
}

const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
const board = (tag: string) => ({
  title: "t", projectName: "Master", full_prompt: "x", style_prefix: "", style_category: "", style_preset: "",
  use_characters: [], cast_rules: "", duration_seconds: 16, clip_seconds: 4,
  scenes: [1, 2, 3, 4].map((i) => ({ shot_id: `s${i}`, prompt: `${tag} p${i}`, seconds: 4 })),
});
const filmBody = (over: Record<string, unknown> = {}) => ({
  project: "Long", idempotency_key: "one", storyboard: board("a"), character_refs: {}, part_size: 2,
  shared: { motion_backend: "talk", style: "photoreal", delivery_width: 832, delivery_height: 464 },
  spend_ceiling_usd: 10, cost_usd_per_shot_est: 0.5, ...over,
});
const call = async (e: unknown, method: string, path: string, body?: unknown) => {
  const res = await worker.fetch(new Request(`https://studio.example${path}`, {
    method, headers: { "content-type": "application/json", authorization: "Bearer t" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), e as never, ctx);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
type Proj = { id: string; name: string; last_storyboard: unknown };
const projects = async (e: unknown) => ((await call(e, "GET", "/api/storyboard/projects")).body.projects as Proj[]);

describe("cf#1241: a film started through the API saves its board to a project", () => {
  it("a film with no project leaves one the panel can reopen, holding the master board", async () => {
    const e = env();
    const r = await call(e, "POST", "/api/film", filmBody());
    expect(r.status).toBe(201);
    const list = await projects(e);
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe("Long");
    expect(list[0].last_storyboard).toEqual(board("a"));
    expect(r.body.project).toEqual({ saved: true, id: list[0].id, name: "Long", created: true });
  });

  it("the same request twice makes one project, not two", async () => {
    const e = env();
    await call(e, "POST", "/api/film", filmBody());
    const again = await call(e, "POST", "/api/film", filmBody());
    expect(again.status).toBe(200);
    expect(await projects(e)).toHaveLength(1);
    expect((again.body.project as { created: boolean }).created).toBe(false);
  });

  it("a draft with the film's name and a different board is never overwritten", async () => {
    const e = env();
    const draft = (await call(e, "POST", "/api/storyboard/projects", { name: "Long" })).body.project as Proj;
    await call(e, "POST", `/api/storyboard/projects/${draft.id}/storyboard`, { storyboard: board("draft") });
    await call(e, "POST", "/api/film", filmBody());
    const list = await projects(e);
    expect(list).toHaveLength(2);
    expect(list.find((p) => p.id === draft.id)!.last_storyboard).toEqual(board("draft"));
    expect(list.find((p) => p.id !== draft.id)!.last_storyboard).toEqual(board("a"));
  });

  it("an empty project with the film's name takes the board", async () => {
    const e = env();
    const empty = (await call(e, "POST", "/api/storyboard/projects", { name: "Long" })).body.project as Proj;
    await call(e, "POST", "/api/film", filmBody());
    const list = await projects(e);
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(empty.id);
    expect(list[0].last_storyboard).toEqual(board("a"));
  });

  it("a named project_id gets the board, whatever the film is called", async () => {
    const e = env();
    const mine = (await call(e, "POST", "/api/storyboard/projects", { name: "My story" })).body.project as Proj;
    const r = await call(e, "POST", "/api/film", filmBody({ project_id: mine.id }));
    const list = await projects(e);
    expect(list).toHaveLength(1);
    expect(list[0].last_storyboard).toEqual(board("a"));
    expect(r.body.project).toEqual({ saved: true, id: mine.id, name: "My story", created: false });
  });

  it("a project_id that names nothing still starts the film, and says the board was not saved", async () => {
    const e = env();
    const r = await call(e, "POST", "/api/film", filmBody({ project_id: "p_doesnotexist000000" }));
    expect(r.status).toBe(201);
    expect(r.body.project).toEqual({ saved: false, error: expect.any(String) });
    expect(await projects(e)).toHaveLength(0);
  });
});

describe("chooseFilmProject", () => {
  const row = (id: number, name: string, sb: unknown) => ({ id, public_id: `p${id}`, slug: `s${id}`, name, prefs: {}, last_storyboard: sb, created_at: "", updated_at: "" });
  it("matches a board regardless of key order", () => {
    expect(stableJson({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe(stableJson({ a: [1, { c: 3, d: 2 }], b: 1 }));
    const c = chooseFilmProject([row(1, "F", { b: 1, a: 2 })], "F", { a: 2, b: 1 }, null);
    expect(c).toEqual({ use: row(1, "F", { b: 1, a: 2 }), write: false });
  });
  it("ignores a project with another name", () => {
    expect(chooseFilmProject([row(1, "Other", null)], "F", {}, null)).toEqual({ create: true });
  });
});
