import { describe, it, expect, vi, afterEach } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// cf#1346: how many R2 calls one REAL first-submit parent tick makes, and how long it takes when R2 answers
// each call only on its fifth try. Nothing in core is mocked: the tick runs the studio's bundle and film
// doors and core's startFilmJob. The stand-ins are the module workers (a keyframe door that answers
// pending, a motion door) and R2 itself, a double that counts and logs every call.

import { insertParent } from "../src/film-parent-store";
import { buildParentDoc } from "../src/film-parent";
import { studioEnv } from "../src/orchestrator-env";
import { SUBMIT_HOLD_AFTER_R2_RETRY_MS, sweepFilmParents } from "../src/studio";
import { _resetR2RetryClock, r2RetriedWithin } from "../modules/_shared/r2-retry";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";

/** slow: every call succeeds only on its 5th try. slowPlain: the same, except a conditional put, which the
 *  retry never repeats, passes first time: the worst case that still reaches the invoke. */
type Mode = "healthy" | "slow" | "slowPlain";
const R2_TEMP = () => new Error("We encountered an internal error. Please try again. (10001)");

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
  const store = new Map<string, { body: Uint8Array; etag: string }>();
  let n = 0;
  const state = { mode: "healthy" as Mode, log: [] as string[], attempts: new Map<string, number>() };
  const enc = (v: unknown): Uint8Array => typeof v === "string" ? new TextEncoder().encode(v)
    : v instanceof Uint8Array ? v : v instanceof ArrayBuffer ? new Uint8Array(v) : ArrayBuffer.isView(v) ? new Uint8Array((v as ArrayBufferView).buffer) : new TextEncoder().encode(String(v ?? ""));
  const gate = (op: string, key: string, conditional = false) => {
    const k = `${op}:${key}`;
    const a = (state.attempts.get(k) ?? 0) + 1;
    if (a === 1) state.log.push(`${op}${conditional ? "(if)" : ""} ${key}`);
    const slow = state.mode === "slow" || (state.mode === "slowPlain" && !conditional);
    if (slow && a < 5) { state.attempts.set(k, a); throw R2_TEMP(); }
    state.attempts.delete(k);
  };
  const obj = (key: string, v: { body: Uint8Array; etag: string }) => ({
    key, etag: v.etag, size: v.body.length, uploaded: new Date(0), httpMetadata: {}, customMetadata: {},
    text: async () => new TextDecoder().decode(v.body), json: async () => JSON.parse(new TextDecoder().decode(v.body)),
    arrayBuffer: async () => v.body.buffer.slice(v.body.byteOffset, v.body.byteOffset + v.body.byteLength),
    body: new Response(v.body).body,
  });
  return {
    state, store, mark: (m: string) => state.log.push(m),
    async get(key: string) { gate("get", key); const v = store.get(key); return v ? obj(key, v) : null; },
    async head(key: string) { gate("head", key); const v = store.get(key); return v ? obj(key, v) : null; },
    async put(key: string, body: unknown, opts?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) {
      gate("put", key, opts?.onlyIf !== undefined);
      const cur = store.get(key);
      if (opts?.onlyIf?.etagDoesNotMatch === "*" && cur) return null;
      if (opts?.onlyIf?.etagMatches && cur?.etag !== opts.onlyIf.etagMatches) return null;
      const b = body instanceof ReadableStream ? new Uint8Array(await new Response(body).arrayBuffer()) : enc(body);
      const etag = `e${++n}`; store.set(key, { body: b, etag }); return obj(key, { body: b, etag });
    },
    async delete(key: string | string[]) { for (const k of Array.isArray(key) ? key : [key]) { gate("delete", k); store.delete(k); } },
    async list({ prefix = "", limit = 1000 }: { prefix?: string; limit?: number } = {}) {
      gate("list", prefix);
      const keys = [...store.keys()].filter((k) => k.startsWith(prefix)).sort().slice(0, limit);
      return { objects: keys.map((key) => obj(key, store.get(key)!)), truncated: false, delimitedPrefixes: [] };
    },
  };
}

const json = (o: unknown) => new Response(JSON.stringify(o), { headers: { "content-type": "application/json" } });
const keyframeDoor = (invokes: unknown[], mark: (m: string) => void) => ({
  fetch: async (input: string | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.endsWith("/module.json")) return json({ name: "keyframe", version: "0.1.0", api: MODULE_API, binding: "MODULE_KEYFRAME", hooks: ["keyframe"], config_schema: {}, ui: { section: "keyframe", order: 10 }, cancelable: true });
    if (url.endsWith("/invoke")) { invokes.push(JSON.parse(String(init?.body ?? "{}"))); mark("INVOKE keyframe (spend)"); return json({ ok: true, pending: true, poll: "kf-1", jobId: "rp-1" }); }
    if (url.endsWith("/poll")) return json({ ok: true, pending: true });
    return new Response("no", { status: 404 });
  },
});
const motionDoor = { fetch: async (input: string | Request) => {
  const url = typeof input === "string" ? input : input.url;
  if (url.endsWith("/module.json")) return json({ name: "talk", version: "0.1.0", api: MODULE_API, binding: "MODULE_TALK", hooks: ["motion.backend"], config_schema: {}, ui: { section: "motion", order: 10, locality: "cloud" } });
  return new Response("no", { status: 404 });
} };

const BODY = {
  project: "Long", idempotency_key: "one",
  storyboard: { title: "t", projectName: "Master", full_prompt: "x", style_prefix: "", style_category: "None", style_preset: "None", use_characters: [], cast_rules: "", duration_seconds: 16, clip_seconds: 4, scenes: [1, 2, 3, 4].map((i) => ({ shot_id: `shot_0${i}`, prompt: `a quiet harbor, shot ${i}`, seconds: 4 })) },
  character_refs: {}, part_size: 2,
  shared: { motion_backend: "talk", style: "photoreal", delivery_width: 832, delivery_height: 464 },
  spend_ceiling_usd: 10, cost_usd_per_shot_est: 0.5,
};
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

async function firstSubmitTick(mode: Mode, jitter: 0 | 1, given?: { bucket: ReturnType<typeof r2>; raw: Record<string, unknown> }) {
  const bucket = given?.bucket ?? r2();
  const { d1: rawD1 } = realD1();
  const d1 = { ...rawD1, prepare: (sql: string) => { if (/^\s*INSERT INTO renders/i.test(sql)) bucket.mark("D1 INSERT renders row"); return rawD1.prepare(sql); } };
  const invokes: unknown[] = [];
  const raw = given?.raw ?? { ALLOW_UNAUTHENTICATED: "true", SPEND_LIMIT_FAIL_CLOSED: "false", DB: d1, R2_RENDERS: bucket,
    SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
    MODULE_KEYFRAME: keyframeDoor(invokes, bucket.mark), MODULE_TALK: motionDoor };
  if (given) (raw.MODULE_KEYFRAME as unknown) = keyframeDoor(invokes, bucket.mark);
  const env = studioEnv(raw as never);
  if (!given) await insertParent(env, buildParentDoc("feature-000", BODY, 0));
  bucket.state.log = [];
  bucket.state.mode = mode;
  vi.useFakeTimers({ toFake: ["setTimeout", "Date"], now: given ? 61_000 + SUBMIT_HOLD_AFTER_R2_RETRY_MS + 60_000 : 61_000 });
  vi.spyOn(Math, "random").mockReturnValue(jitter === 1 ? 0.999999 : 0);
  const logs: string[] = [];
  vi.spyOn(console, "log").mockImplementation((m: unknown) => { logs.push(String(m)); });
  vi.spyOn(console, "warn").mockImplementation((m: unknown) => { logs.push(String(m)); });
  const t0 = Date.now();
  let done = false;
  const p = sweepFilmParents(env, ctx).then(() => { done = true; }, () => { done = true; });
  while (!done) await vi.advanceTimersByTimeAsync(5);
  await p;
  const ms = Date.now() - t0;
  vi.useRealTimers();
  const pass = logs.map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((o) => o && o.ev === "film.cron_pass");
  const doc = JSON.parse(new TextDecoder().decode(bucket.store.get("film-parents/feature-000.json")!.body));
  return { ms, log: bucket.state.log, invokes: invokes.length, pass, logs, doc, bucket, raw };
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); _resetR2RetryClock(); });
const r2Calls = (log: string[]) => log.filter((l) => !/^(INVOKE|D1)/.test(l));

const LIMIT_MS = 30_000;

describe("cf#1346 one real first-submit parent tick", () => {
  it("healthy: 17 R2 calls, and the claim lands before the spend, which lands before the row", async () => {
    _resetR2RetryClock();
    const h = await firstSubmitTick("healthy", 0);
    expect(r2Calls(h.log)).toHaveLength(17);
    expect(h.invokes).toBe(2); // two keyframe jobs for the part's two shots, not a second buy
    const claim = h.log.indexOf("put(if) film-parents/feature-000.json");
    const spend = h.log.indexOf("INVOKE keyframe (spend)");
    const row = h.log.indexOf("D1 INSERT renders row");
    expect(claim).toBeGreaterThanOrEqual(0);
    expect(claim).toBeLessThan(spend);
    expect(spend).toBeLessThan(row);
    expect(h.doc.parts[0].status).toBe("running");
  }, 60_000);

  for (const mode of ["slow", "slowPlain"] as const) {
    it(`${mode} R2: nothing is claimed or bought, the part waits, and the pass stays under 30 s`, async () => {
      _resetR2RetryClock();
      const r = await firstSubmitTick(mode, 1);
      expect(r.invokes).toBe(0);
      expect(r.ms).toBeLessThanOrEqual(LIMIT_MS);
      expect(r.doc.parts[0]).toMatchObject({ status: "pending", claimed_at: null });
      expect(r.log.some((l) => l.startsWith("put bundles/"))).toBe(false);
    }, 60_000);
  }

  it("CONTROL: once R2 answers first time again and the hold has passed, the part submits", async () => {
    _resetR2RetryClock();
    const held = await firstSubmitTick("slowPlain", 1);
    expect(held.invokes).toBe(0);
    held.bucket.state.mode = "healthy";
    held.bucket.state.log = [];
    const next = await firstSubmitTick("healthy", 0, { bucket: held.bucket, raw: held.raw });
    expect(next.invokes).toBe(2);
    expect(next.doc.parts[0].status).toBe("running");
  }, 60_000);

  it("the retry clock: within the window after a retry, not after it", () => {
    _resetR2RetryClock();
    expect(r2RetriedWithin(SUBMIT_HOLD_AFTER_R2_RETRY_MS, 0)).toBe(false);
  });
});
