import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { R2_RETRY_DELAYS_MS, isTemporaryR2Error, retryingBucket } from "../src/r2-retry";
import { studioEnv } from "../src/orchestrator-env";
import type { Env } from "../src/env";
import { advanceFilmJob, filmJobDocKey, type FilmJob, type FinishShot } from "@skyphusion-labs/vivijure-core/film-orchestrator";
import { orch } from "./orchestrator-env";

// The exact text a film part failed on, live.
const LIVE = "list: We encountered an internal error. Please try again. (10001)";

function bucket(failures: string[], ok: unknown = "ok") {
  const calls: Record<string, unknown[][]> = { get: [], head: [], list: [], delete: [], put: [], other: [] };
  const queue = [...failures];
  const op = (name: string) => async (...args: unknown[]) => {
    calls[name].push(args);
    const f = queue.shift();
    if (f) throw new Error(f);
    return ok;
  };
  return {
    calls,
    b: { get: op("get"), head: op("head"), list: op("list"), delete: op("delete"), put: op("put"),
      createMultipartUpload: op("other"), name: "renders" },
  };
}

describe("R2 retry", () => {
  let sleeps: number[];
  const sleep = async (ms: number) => { sleeps.push(ms); };
  beforeEach(() => { sleeps = []; vi.spyOn(console, "warn").mockImplementation(() => {}); });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  for (const name of ["get", "head", "list", "delete"] as const) {
    it(`${name} survives the live error`, async () => {
      const { b, calls } = bucket([LIVE]);
      await expect(retryingBucket(b, sleep)[name]("k")).resolves.toBe("ok");
      expect(calls[name]).toHaveLength(2);
      expect(sleeps).toEqual([200]);
    });
  }

  it("names what is temporary", () => {
    for (const m of [LIVE, "get: unavailable (10043)", "put: slow down (10058)", "Network connection lost."]) {
      expect(isTemporaryR2Error(new Error(m)), m).toBe(true);
    }
    for (const m of ["put: Unauthorized (10042)", "get: bucket gone (10006)", "boom", "line (10001) of a log file"]) {
      expect(isTemporaryR2Error(new Error(m)), m).toBe(false);
    }
  });

  it("stops at five attempts and throws the real error", async () => {
    const { b, calls } = bucket(Array(9).fill(LIVE));
    await expect(retryingBucket(b, sleep).list()).rejects.toThrow(LIVE);
    expect(calls.list).toHaveLength(5);
    expect(sleeps).toEqual(R2_RETRY_DELAYS_MS);
  });

  it("a real error fails at once", async () => {
    const { b, calls } = bucket(["list: Unauthorized (10042)", "x"]);
    await expect(retryingBucket(b, sleep).list()).rejects.toThrow("10042");
    expect(calls.list).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("a missing object is an answer, not an error", async () => {
    const { b, calls } = bucket([], null);
    await expect(retryingBucket(b, sleep).get("k")).resolves.toBeNull();
    expect(calls.get).toHaveLength(1);
  });

  it("repeats a plain put with the same bytes", async () => {
    const { b, calls } = bucket([LIVE]);
    await retryingBucket(b, sleep).put("k", "body");
    expect(calls.put).toEqual([["k", "body"], ["k", "body"]]);
  });

  it("never repeats a conditional put: its first try may have won", async () => {
    const { b, calls } = bucket([LIVE]);
    await expect(retryingBucket(b, sleep).put("k", "v", { onlyIf: { etagMatches: "e" } })).rejects.toThrow("10001");
    expect(calls.put).toHaveLength(1);
  });

  it("never repeats a stream: it has been read", async () => {
    const { b, calls } = bucket([LIVE]);
    await expect(retryingBucket(b, sleep).put("k", new Blob(["x"]).stream())).rejects.toThrow("10001");
    expect(calls.put).toHaveLength(1);
  });

  it("leaves other methods and fields alone", async () => {
    const { b, calls } = bucket(["createMultipartUpload failed (10001)"]);
    const w = retryingBucket(b, sleep);
    expect(w.name).toBe("renders");
    await expect(w.createMultipartUpload("k")).rejects.toThrow("10001");
    expect(calls.other).toHaveLength(1);
  });

  it("studioEnv applies it once, however many requests share the env", async () => {
    vi.useFakeTimers();
    const { b, calls } = bucket(Array(50).fill(LIVE));
    const raw = { R2_RENDERS: b } as unknown as Env;
    studioEnv(raw);
    studioEnv(raw);
    const env = studioEnv(raw);
    const done = expect(env.R2_RENDERS.list()).rejects.toThrow("10001");
    await vi.runAllTimersAsync();
    await done;
    expect(calls.list).toHaveLength(5);
  });

  it("with a database too, the meter and the retry each wrap once", async () => {
    vi.useFakeTimers();
    const { b, calls } = bucket(Array(50).fill(LIVE));
    const db = { prepare: () => ({ bind: () => ({ run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }), run: async () => ({}), first: async () => null, all: async () => ({ results: [] }) }), batch: async () => [] };
    const raw = { R2_RENDERS: b, DB: db } as unknown as Env;
    studioEnv(raw);
    const env = studioEnv(raw);
    const done = expect(env.R2_RENDERS.list()).rejects.toThrow("10001");
    await vi.runAllTimersAsync();
    await done;
    expect(calls.list).toHaveLength(5);
  });

  describe("through real core advanceFilmJob", () => {
    const ID = "film-r2-retry";
    const film = (): FilmJob => ({
      film_id: ID, project: "neon", bundle_key: "b",
      scenes: [{ shot_id: "shot_01", prompt: "a", seconds: 4 }],
      motion_backend: "own-gpu", motion_config: {}, finish_config: {},
      keyframe_binding: null, phase: "finish", clips_only: true,
      finish_shots: [{ shot_id: "shot_01", clip_key: "renders/neon/clips/shot_01_i2v.mp4", chain: ["MODULE_FINISH_LIPSYNC"], configs: [{}], idx: 0, status: "pending", applied: [] }] as unknown as FinishShot[],
      created_at: Date.now(),
    }) as unknown as FilmJob;

    function setup(fault: { get?: number; put?: number }) {
      const doc = filmJobDocKey(ID);
      let stored = JSON.stringify(film());
      const f = { ...fault };
      const invokes = { n: 0 };
      const stmt = { run: async () => ({ meta: { changes: 1 } }), first: async () => ({ one: 1 }), all: async () => ({ results: [] }) };
      const raw = {
        DB: { prepare: () => ({ ...stmt, bind: () => stmt }), batch: async () => [] },
        R2_RENDERS: {
          get: async (k: string) => {
            if (k === doc && (f.get ?? 0) > 0) { f.get! -= 1; throw new Error("get: We encountered an internal error. Please try again. (10001)"); }
            return k === doc ? { text: async () => stored } : null;
          },
          put: async (k: string, b: string) => {
            if (k === doc && (f.put ?? 0) > 0) { f.put! -= 1; throw new Error("put: We encountered an internal error. Please try again. (10001)"); }
            if (k === doc) stored = b;
          },
          list: async () => ({ objects: [], truncated: false }),
          head: async () => null,
        },
        MODULE_FINISH_LIPSYNC: {
          fetch: async (url: string) => {
            if (String(url).includes("/module.json")) {
              return new Response(JSON.stringify({ name: "finish-lipsync", version: "0.1.0", api: "vivijure-module/2", hooks: ["finish"] }), { status: 200, headers: { "content-type": "application/json" } });
            }
            if (!String(url).includes("/invoke")) return new Response(JSON.stringify({ ok: true, pending: true, poll: "tok-1" }), { status: 200, headers: { "content-type": "application/json" } });
            invokes.n += 1;
            return new Response(JSON.stringify({ ok: true, pending: true, poll: "tok-1" }), { status: 200, headers: { "content-type": "application/json" } });
          },
        },
      } as unknown as Env;
      return { raw, invokes, read: () => JSON.parse(stored) as FilmJob };
    }
    const tick = async (env: unknown) => {
      if (!vi.isFakeTimers()) vi.useFakeTimers();
      let settled = false;
      const p = advanceFilmJob(env as never, ID).finally(() => { settled = true; });
      for (let i = 0; i < 600 && !settled; i++) await vi.advanceTimersByTimeAsync(1000);
      expect(settled, "the tick finished").toBe(true);
      return p;
    };

    it("control: without the retry, the live error ends the film", async () => {
      const { raw, read } = setup({ get: 1 });
      await tick(orch(raw));
      expect(read().phase).toBe("failed");
      expect(read().error).toContain("10001");
    });

    it("with it, the same error leaves the film running", async () => {
      const { raw, read, invokes } = setup({ get: 1 });
      await tick(orch(studioEnv(raw) as unknown as Env));
      expect(read().phase).toBe("finish");
      expect(read().error ?? "").not.toContain("10001");
      expect(invokes.n).toBe(1);
    });

    it("an error writing the doc after a submit keeps the token, so the next tick buys nothing", async () => {
      const { raw, read, invokes } = setup({ put: 1 });
      const env = orch(studioEnv(raw) as unknown as Env);
      await tick(env);
      expect(read().finish_shots?.[0].poll).toBe("tok-1");
      await tick(env);
      expect(invokes.n).toBe(1);
    });
  });
});
