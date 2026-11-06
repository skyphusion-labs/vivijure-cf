import { describe, it, expect, vi, afterEach } from "vitest";

// cf#1302: how long one cron pass takes while R2 is failing with temporary errors, against the 30 s
// Cloudflare gives `scheduled` work in waitUntil. The logs cannot answer it: r2.retry had 0 rows in 72 h
// and 3 isolated attempt-1 rows in 7 days (the lead's query, 2026-11-06), so this measures it under fake
// timers. R2 is the route test's double, with a failure mode. The retry is the real one
// (modules/_shared/r2-retry.ts, applied by studioEnv), sleeping on the faked setTimeout.

const h = vi.hoisted(() => ({ started: 0 }));
vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    advanceFilmJob: vi.fn(async () => null),
    startFilmJob: vi.fn(async (_e: unknown, args: Record<string, unknown>) => {
      h.started += 1;
      return { film_id: `film-${h.started}`, project: args.project, phase: "keyframe", scenes: args.scenes, created_at: 0 };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => []) };
});

import { insertParent } from "../src/film-parent-store";
import { buildParentDoc } from "../src/film-parent";
import { studioEnv } from "../src/orchestrator-env";
import { FILM_PASS_START_BUDGET_MS, sweepFilmParents } from "../src/studio";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";

type Mode = "healthy" | "always" | "slow";
const R2_TEMP = () => new Error("put: We encountered an internal error. Please try again. (10001)");

/** The route test's R2, plus a failure mode. "slow" fails each call 4 times and passes the 5th, the most
 *  a call can cost and still succeed under the retry. Counts logical calls (first attempts). */
function r2() {
  const store = new Map<string, { body: string; etag: string }>();
  let n = 0;
  const state = { mode: "healthy" as Mode, calls: 0, attempts: new Map<string, number>() };
  const gate = (op: string, key: string) => {
    if (state.mode === "healthy") return;
    const k = `${op}:${key}`;
    const a = (state.attempts.get(k) ?? 0) + 1;
    if (a === 1) state.calls += 1;
    if (state.mode === "always") { state.attempts.set(k, a); throw R2_TEMP(); }
    if (a < 5) { state.attempts.set(k, a); throw R2_TEMP(); }
    state.attempts.delete(k);
  };
  return {
    state, store,
    async get(key: string) { gate("get", key); const v = store.get(key); return v ? { etag: v.etag, json: async () => JSON.parse(v.body), text: async () => v.body } : null; },
    async head(key: string) { gate("head", key); const v = store.get(key); return v ? { etag: v.etag, size: v.body.length, customMetadata: {} } : null; },
    async put(key: string, body: string, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      gate("put", key);
      const cur = store.get(key);
      if (opts?.onlyIf?.etagDoesNotMatch === "*" && cur) return null;
      if (opts?.onlyIf?.etagMatches && cur?.etag !== opts.onlyIf.etagMatches) return null;
      const etag = `e${++n}`; store.set(key, { body, etag }); return { etag };
    },
    async delete(key: string) { gate("delete", key); store.delete(key); },
    async list({ prefix, limit }: { prefix: string; limit?: number }) {
      gate("list", prefix);
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit ?? 1000);
      return { objects: keys.map((key) => ({ key, uploaded: new Date(0) })), truncated: false };
    },
  };
}

const DB = {
  prepare: () => ({
    bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true, meta: { changes: 0 } }) }),
    first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }),
  }),
  batch: async () => [],
};
const binding = (name: string, hooks: string[]) => ({
  fetch: async () => new Response(JSON.stringify({ name, version: "0.1.0", api: MODULE_API, hooks, ui: { order: 10, locality: "cloud" } }), { headers: { "content-type": "application/json" } }),
});
const BODY = {
  project: "Long", idempotency_key: "one",
  storyboard: { title: "t", projectName: "Master", full_prompt: "x", style_prefix: "", style_category: "", style_preset: "", use_characters: [], cast_rules: "", duration_seconds: 16, clip_seconds: 4, scenes: [1, 2, 3, 4].map((i) => ({ shot_id: `s${i}`, prompt: `p${i}`, seconds: 4 })) },
  character_refs: {}, part_size: 2,
  shared: { motion_backend: "talk", style: "photoreal", delivery_width: 832, delivery_height: 464 },
  spend_ceiling_usd: 10, cost_usd_per_shot_est: 0.5,
};
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

/** Seed `n` active parents on a healthy bucket, then run one pass in `mode`. Returns simulated ms. */
async function pass(n: number, mode: Mode, jitter: 0 | 1, minute = 1): Promise<{ ms: number; calls: number; reached: number | null; cut: number | null; ticked: string[] }> {
  const bucket = r2();
  const raw = { ALLOW_UNAUTHENTICATED: "true", DB, R2_RENDERS: bucket, SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
    MODULE_KEYFRAME: binding("keyframe", ["keyframe"]), MODULE_TALK: binding("talk", ["motion.backend"]) };
  const env = studioEnv(raw as never);
  for (let i = 0; i < n; i++) await insertParent(env, buildParentDoc(`feature-${String(i).padStart(3, "0")}`, BODY, i));
  bucket.state.mode = mode;
  // A minute that is not a reconcile minute (the reconcile runs when minute % 10 === 0).
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"], now: minute * 60_000 + 1_000 });
  const ticked: string[] = [];
  const realGet = bucket.get.bind(bucket);
  bucket.get = async (key: string) => { if (key.startsWith("film-parents/feature-")) ticked.push(key); return realGet(key); };
  vi.spyOn(Math, "random").mockReturnValue(jitter === 1 ? 0.999999 : 0);
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const t0 = Date.now();
  let done = false;
  const p = sweepFilmParents(env, ctx).then(() => { done = true; }, () => { done = true; });
  while (!done) await vi.advanceTimersByTimeAsync(5);
  await p;
  const ms = Date.now() - t0;
  const line = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((o) => o && o.ev === "film.cron_pass");
  vi.useRealTimers();
  return { ms, calls: bucket.state.calls, reached: line ? line.reached : null, cut: line ? line.cut : null, ticked: [...new Set(ticked)] };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const LIMIT_MS = 30_000; // what Cloudflare gives scheduled work in waitUntil

describe("cf#1302 cron pass time under an R2 outage (fake timers)", () => {
  for (const n of [1, 5, 50]) {
    it(`R2 answering each call only on its fifth try: ${n} parent(s) stay under 30 s at worst jitter`, async () => {
      const r = await pass(n, "slow", 1);
      expect(r.ms).toBeLessThanOrEqual(LIMIT_MS);
      expect(r.reached).toBeGreaterThanOrEqual(1);
      expect((r.reached ?? 0) + (r.cut ?? 0)).toBe(n);
    }, 60_000);
  }

  it("at the list cap, the budget cuts the pass, and says how many it left", async () => {
    const r = await pass(50, "slow", 1);
    expect(r.cut).toBeGreaterThan(0);
    expect(r.ms).toBeGreaterThanOrEqual(FILM_PASS_START_BUDGET_MS);
  }, 60_000);

  it("CONTROL: a healthy pass of 50 is not cut", async () => {
    const r = await pass(50, "healthy", 1);
    expect(r).toMatchObject({ reached: 50, cut: 0 });
    expect(r.ms).toBeLessThan(FILM_PASS_START_BUDGET_MS);
  }, 60_000);

  it("R2 failing every call ends the pass early: the list itself fails, no tick runs", async () => {
    const r = await pass(50, "always", 1);
    expect(r.ms).toBeLessThan(LIMIT_MS);
    expect(r.reached).toBeNull(); // threw before its last line; runSweepPass logs sweep.failed
  }, 60_000);

  it("parents a cut pass leaves are reached on later passes (rotation by the minute)", async () => {
    const seen = new Set<string>();
    for (const minute of [1, 2, 3, 4, 5, 6]) {
      const r = await pass(5, "slow", 1, minute);
      r.ticked.forEach((k) => seen.add(k));
    }
    expect(seen.size).toBe(5);
  }, 120_000);
});
