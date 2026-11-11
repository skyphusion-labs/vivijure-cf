import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// POST /api/internal/sweep (src/sweep-route.ts) and the pass lease (src/sweep-lease.ts).
//
// The core sweep is mocked so a call can be COUNTED; the film parent sweep runs for real against the fake
// bucket, and its heartbeat write is how the tests see that it ran. Every refusal below was driven red by
// removing the check it covers (see the PR body for the mutation table).
//
// DETERMINISTIC BY CONSTRUCTION. No real timer and no wall clock decides an outcome: Date is frozen at T0,
// the fake bucket yields on microtasks only, and the overlap test holds the first pass open on an explicit
// gate instead of hoping it is still running. The first draft raced the cron pass against the route's real
// crypto.subtle digests; under a loaded full suite the cron pass sometimes released before the route asked,
// and the route then ran a second pass.
const T0 = Date.UTC(2026, 10, 3, 12, 0, 0);

vi.mock("@skyphusion-labs/vivijure-core/render-sweep", async (orig) => {
  const real = await orig<typeof import("@skyphusion-labs/vivijure-core/render-sweep")>();
  return { ...real, sweepUnresolvedJobs: vi.fn(async () => 0) };
});

import { sweepUnresolvedJobs } from "@skyphusion-labs/vivijure-core/render-sweep";
import worker from "../src/index";
import { sha256Hex } from "../src/auth-gate";
import { acquireSweepLease, SWEEP_LEASE_KEY, SWEEP_LEASE_MS } from "../src/sweep-lease";
import type { Env } from "../src/env";

const OPERATOR = "o".repeat(64);
const CONSUMER = "c".repeat(64);
const SWEEP = "s".repeat(64);
const HEARTBEAT_KEY = "film-parents/cron-heartbeat.json";

/** R2 with the two properties the lease depends on: the etag is a hash of the CONTENT (as in R2), and
 *  onlyIf is honoured. Every call yields to the microtask queue first, so two concurrent callers really
 *  interleave, with no timer involved. */
function fakeBucket() {
  const store = new Map<string, { body: string; etag: string; customMetadata: Record<string, string> }>();
  const hash = (s: string) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16);
  };
  const tick = async () => { await Promise.resolve(); await Promise.resolve(); };
  const bucket = {
    store,
    failing: false,
    async head(key: string) {
      await tick();
      if (bucket.failing) throw new Error("r2 down");
      const o = store.get(key);
      return o ? { key, etag: o.etag, customMetadata: o.customMetadata } : null;
    },
    async get(key: string) {
      await tick();
      const o = store.get(key);
      return o ? { etag: o.etag, json: async () => JSON.parse(o.body), text: async () => o.body } : null;
    },
    async put(key: string, body: string, opts: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string }; customMetadata?: Record<string, string> } = {}) {
      await tick();
      if (bucket.failing) throw new Error("r2 down");
      const cur = store.get(key);
      if (opts.onlyIf?.etagDoesNotMatch === "*" && cur) return null;
      if (opts.onlyIf?.etagMatches !== undefined && cur?.etag !== opts.onlyIf.etagMatches) return null;
      const o = { body: String(body), etag: hash(String(body)), customMetadata: opts.customMetadata ?? {} };
      store.set(key, o);
      return { key, etag: o.etag };
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list({ prefix }: { prefix: string }) {
      return { objects: [...store.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, uploaded: new Date() })) };
    },
  };
  return bucket;
}

let consumerHash = "";
function fakeDb() {
  return {
    prepare: (_sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => (String(args[0]) === consumerHash ? { name: "bot", scope: "consumer" } : null),
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      }),
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    }),
  };
}

function makeEnv(over: Record<string, unknown> = {}) {
  const bucket = fakeBucket();
  const env = {
    AUTH_MODE: "token",
    STUDIO_API_TOKEN: OPERATOR,
    SWEEP_TOKEN: SWEEP,
    DB: fakeDb(),
    R2_RENDERS: bucket,
    // Production assets use the default not_found_handling, so an unmatched path is a 404.
    ASSETS: { fetch: async () => new Response("Not Found", { status: 404 }) },
    ...over,
  } as unknown as Env;
  return { env, bucket };
}

function makeCtx() {
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext;
  return { ctx, drain: async () => { while (pending.length) await pending.shift(); } };
}

async function call(env: Env, path: string, init: RequestInit = {}) {
  const { ctx, drain } = makeCtx();
  const res = await worker.fetch(new Request("https://studio.example" + path, { method: "POST", ...init }), env as never, ctx);
  await drain();
  return { status: res.status, body: await res.text() };
}

const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

/** The answer an unknown /api path gets with the same request. The refusals must be byte-identical to it. */
const unknown = (env: Env, init: RequestInit = {}) => call(env, "/api/internal/no-such-route", init);

const sweepCalls = () => vi.mocked(sweepUnresolvedJobs).mock.calls.length;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  vi.mocked(sweepUnresolvedJobs).mockClear();
  consumerHash = await sha256Hex(CONSUMER);
});
afterEach(() => {
  vi.useRealTimers();
});

/** Real event-loop turns (not a timer) until `done()`, bounded so a broken wait fails instead of hanging. */
async function until(done: () => boolean) {
  for (let i = 0; i < 1000 && !done(); i++) await new Promise((r) => setImmediate(r));
  expect(done(), "the awaited state was reached").toBe(true);
}

describe("POST /api/internal/sweep refuses everything but SWEEP_TOKEN, as an unknown route", () => {
  it("SWEEP_TOKEN unset: the route does not exist, even for the operator", async () => {
    for (const unset of [undefined, "", "   "]) {
      const { env } = makeEnv({ SWEEP_TOKEN: unset });
      for (const init of [bearer(SWEEP), bearer(OPERATOR), {}]) {
        const got = await call(env, "/api/internal/sweep", init);
        expect(got).toEqual(await unknown(env, init));
      }
      expect((await call(env, "/api/internal/sweep", bearer(OPERATOR))).status).toBe(404);
    }
    expect(sweepCalls()).toBe(0);
  });

  it("a wrong token gets the unknown-route answer", async () => {
    const { env } = makeEnv();
    for (const init of [bearer("x".repeat(64)), bearer(SWEEP + "x"), {}]) {
      expect(await call(env, "/api/internal/sweep", init)).toEqual(await unknown(env, init));
    }
    expect(sweepCalls()).toBe(0);
  });

  it("the operator bearer gets 404", async () => {
    const { env, bucket } = makeEnv();
    const got = await call(env, "/api/internal/sweep", bearer(OPERATOR));
    expect(got.status).toBe(404);
    expect(got).toEqual(await unknown(env, bearer(OPERATOR)));
    expect(sweepCalls()).toBe(0);
    expect(bucket.store.has(HEARTBEAT_KEY)).toBe(false);
  });

  it("a consumer bearer gets 404", async () => {
    const { env } = makeEnv();
    const got = await call(env, "/api/internal/sweep", bearer(CONSUMER));
    expect(got.status).toBe(404);
    expect(got).toEqual(await unknown(env, bearer(CONSUMER)));
    expect(sweepCalls()).toBe(0);
  });

  it("the right token on GET, or in the cookie, is not the route", async () => {
    const { env } = makeEnv();
    const getInit = { method: "GET", ...bearer(SWEEP) };
    expect(await call(env, "/api/internal/sweep", getInit)).toEqual(await unknown(env, getInit));
    const cookie = { headers: { cookie: `vivijure_token=${SWEEP}` } };
    expect(await call(env, "/api/internal/sweep", cookie)).toEqual(await unknown(env, cookie));
    expect(sweepCalls()).toBe(0);
  });

  it("a SWEEP_TOKEN equal to the operator token is refused", async () => {
    const { env } = makeEnv({ SWEEP_TOKEN: OPERATOR });
    const got = await call(env, "/api/internal/sweep", bearer(OPERATOR));
    expect(got.status).toBe(404);
    expect(sweepCalls()).toBe(0);
  });

  it("a SWEEP_TOKEN equal to a live consumer token is refused", async () => {
    const { env } = makeEnv({ SWEEP_TOKEN: CONSUMER });
    const got = await call(env, "/api/internal/sweep", bearer(CONSUMER));
    expect(got.status).toBe(404);
    expect(sweepCalls()).toBe(0);
  });

  it("no other auth mode opens it: an open dev deploy with no SWEEP_TOKEN never sweeps", async () => {
    const { env } = makeEnv({ AUTH_MODE: undefined, ALLOW_UNAUTHENTICATED: "true", SWEEP_TOKEN: undefined });
    const got = await call(env, "/api/internal/sweep");
    expect(got.status).toBe(404);
    expect(sweepCalls()).toBe(0);
  });
});

describe("the sweep pass", () => {
  it("the right token runs the same pass as the cron, once, and answers 202 { ok: true }", async () => {
    const { env, bucket } = makeEnv();
    const got = await call(env, "/api/internal/sweep", bearer(SWEEP));
    expect(got.status).toBe(202);
    expect(JSON.parse(got.body)).toEqual({ ok: true });
    expect(sweepCalls()).toBe(1);
    expect(bucket.store.has(HEARTBEAT_KEY)).toBe(true); // the film parent sweep ran too
  });

  it("works in any AUTH_MODE: the route has its own credential", async () => {
    const { env } = makeEnv({ AUTH_MODE: "access", ACCESS_TEAM_DOMAIN: "x.cloudflareaccess.com", ACCESS_AUD: "aud" });
    expect((await call(env, "/api/internal/sweep", bearer(SWEEP))).status).toBe(202);
    expect(sweepCalls()).toBe(1);
  });

  it("the cron path still runs it", async () => {
    const { env, bucket } = makeEnv({ SWEEP_TOKEN: undefined });
    const { ctx, drain } = makeCtx();
    await worker.scheduled({} as never, env as never, ctx);
    await drain();
    expect(sweepCalls()).toBe(1);
    expect(bucket.store.has(HEARTBEAT_KEY)).toBe(true);
  });

  it("a pass already running holds the lease: cron and route both skip, and run again once it is released", async () => {
    const { env } = makeEnv();
    let open!: () => void;
    const gate = new Promise<void>((r) => { open = r; });
    vi.mocked(sweepUnresolvedJobs).mockImplementationOnce(async () => { await gate; return 0; });
    // The cron pass takes the lease and is held open inside the sweep.
    const cron = makeCtx();
    await worker.scheduled({} as never, env as never, cron.ctx);
    await until(() => sweepCalls() === 1);
    // While it is held, the route answers 202 and runs nothing, and so does a second cron tick.
    const got = await call(env, "/api/internal/sweep", bearer(SWEEP));
    expect(got.status).toBe(202);
    const cron2 = makeCtx();
    await worker.scheduled({} as never, env as never, cron2.ctx);
    await cron2.drain();
    expect(sweepCalls()).toBe(1);
    // Released at the end of the pass, so the next call runs.
    open();
    await cron.drain();
    await call(env, "/api/internal/sweep", bearer(SWEEP));
    expect(sweepCalls()).toBe(2);
  });

  it("a lease left by a pass that died expires", async () => {
    const { env, bucket } = makeEnv();
    const now = T0;
    await bucket.put(SWEEP_LEASE_KEY, "dead", { customMetadata: { until: String(now + SWEEP_LEASE_MS) } });
    await call(env, "/api/internal/sweep", bearer(SWEEP));
    expect(sweepCalls()).toBe(0);
    await bucket.put(SWEEP_LEASE_KEY, "dead2", { customMetadata: { until: String(now - 1) } });
    await call(env, "/api/internal/sweep", bearer(SWEEP));
    expect(sweepCalls()).toBe(1);
  });

  it("two passes taking one expired lease at the same instant: exactly one wins", async () => {
    const { bucket } = makeEnv();
    const now = T0;
    await bucket.put(SWEEP_LEASE_KEY, "old", { customMetadata: { until: String(now - 1) } });
    const got = await Promise.all([acquireSweepLease(bucket as never, now), acquireSweepLease(bucket as never, now)]);
    expect(got.filter((l) => l !== "busy")).toHaveLength(1);
  });

  it("a storage failure runs the pass unguarded rather than stranding films", async () => {
    const { env, bucket } = makeEnv();
    bucket.failing = true;
    const got = await call(env, "/api/internal/sweep", bearer(SWEEP));
    expect(got.status).toBe(202);
    expect(sweepCalls()).toBe(1);
  });
});
