import { describe, it, expect, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CLIP_SUBMIT_BATCH } from "@skyphusion-labs/vivijure-core/render-orchestrator";

// vivijure-cf#1122 stage 1, as the studio meets it. UN-STUBBED: the real core 1.35.0 startClipJob and
// advanceClipJob, the real Worker route, real SQLite D1 with the repo migrations. The one fake is the
// motion door, a MODULE_* binding that counts every paid invoke. A standalone job over one batch is
// bought one batch at the start and the rest on polls, each shot exactly once.

import worker from "../src/index";

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
  return { prepare: (sql: string) => stmt(sql), batch: async (ss: Array<{ run(): Promise<unknown> }>) => { const out = []; for (const s of ss) out.push(await s.run()); return out; } };
}

function r2() {
  const store = new Map<string, string>();
  return {
    store,
    async get(key: string) { const v = store.get(key); return v === undefined ? null : { key, size: v.length, json: async () => JSON.parse(v), text: async () => v, arrayBuffer: async () => new TextEncoder().encode(v).buffer }; },
    async head(key: string) { return store.has(key) ? { key, size: store.get(key)!.length, etag: "e" + store.get(key)!.length } : null; },
    async put(key: string, body: unknown) { store.set(key, typeof body === "string" ? body : ""); return { key, etag: "e", size: 1 }; },
    async delete(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k); },
    async list({ prefix = "" }: { prefix?: string } = {}) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 1, uploaded: new Date() })), truncated: false };
    },
  };
}

const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

describe("vivijure-cf#1122: a standalone clip job over one batch, through the route", () => {
  it("POST buys one batch, polls buy the rest, and every shot is bought exactly once", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const invokes = new Map<string, number>();
    const polls = new Map<string, number>();
    const door = {
      fetch: async (input: string | Request, init?: RequestInit) => {
        const url = typeof input === "string" ? input : input.url;
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        if (url.endsWith("/module.json")) {
          return json({ name: "door", version: "1.0.0", api: "vivijure-module/2", binding: "MODULE_DOOR", hooks: ["motion.backend"], config_schema: {}, ui: { section: "motion", order: 1, locality: "cloud" } });
        }
        if (url.endsWith("/invoke")) {
          const shot = String(body.input.shot_id);
          invokes.set(shot, (invokes.get(shot) ?? 0) + 1);
          return json({ ok: true, pending: true, poll: `tok-${shot}` });
        }
        if (url.endsWith("/poll")) {
          const shot = String(body.poll).slice(4);
          const n = (polls.get(shot) ?? 0) + 1;
          polls.set(shot, n);
          if (n < 2) return json({ ok: true, pending: true });
          return json({ ok: true, output: { shot_id: shot, clip_key: `renders/harbor/clips/${shot}_door.mp4`, fps: 24, frames: 0 } });
        }
        return new Response("no", { status: 404 });
      },
    };
    const env = { ALLOW_UNAUTHENTICATED: "true", SPEND_LIMIT_FAIL_CLOSED: "false", DB: realD1(), R2_RENDERS: r2(), MODULE_DOOR: door } as never;
    const call = (method: string, path: string, body?: unknown) => worker.fetch(
      new Request(`https://studio.example${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) }),
      env, ctx,
    );
    const shots = Array.from({ length: CLIP_SUBMIT_BATCH + 5 }, (_u, i) => ({ shot_id: `s${i + 1}`, keyframe_url: "https://k/x.png", prompt: "harbor", seconds: 5 }));
    const res = await call("POST", "/api/render/clips", { project: "harbor", shots, motion_backend: "door" });
    expect(res.status).toBe(200);
    const { job_id } = (await res.json()) as { job_id: string };
    expect(invokes.size).toBe(CLIP_SUBMIT_BATCH);
    let pending = Infinity;
    for (let i = 0; i < 20 && pending > 0; i++) {
      const b = (await (await call("GET", `/api/render/clips/${job_id}`)).json()) as { pending: number; advanced: boolean };
      expect(b.advanced).toBe(true);
      pending = b.pending;
    }
    expect(pending).toBe(0);
    expect(invokes.size).toBe(CLIP_SUBMIT_BATCH + 5);
    expect([...invokes.values()].every((n) => n === 1)).toBe(true);
  });
});
