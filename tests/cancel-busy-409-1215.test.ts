// vivijure-cf#1215. Core 1.34.0 makes a cancel take the film's advance lease. When a tick holds the film for the
// whole wait, cancelFilmJob throws FilmBusyError and writes nothing. The route answers that as a retryable 409,
// not a 500, and the film doc is unchanged.
import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import { FILM_CANCEL_WAIT_MS, filmJobDocKey } from "@skyphusion-labs/vivijure-core/film-orchestrator";
import worker from "../src/index";

const ID = "film-11111111-2222-4333-8444-555555555555";
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** D1 where the lease is held by someone else (claim changes 0 rows, the row exists), or free (claim wins). */
function env(held: boolean) {
  _resetModuleDiscoveryCache();
  const doc = JSON.stringify({ film_id: ID, project: "p", phase: "clips", created_at: Date.now() - 1000, scenes: [], bundle_key: "b" });
  const stored: Record<string, string> = { [filmJobDocKey(ID)]: doc };
  const stmt = (sql: string) => ({
    bind: () => stmt(sql),
    run: async () => ({ success: true, meta: { changes: sql.includes("SET advance_lease") && held ? 0 : 1 } }),
    first: async () => (sql.includes("SELECT 1 AS one") ? { one: 1 } : null),
    all: async () => ({ results: [] }),
  });
  const e = {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET") },
    DB: { prepare: (sql: string) => stmt(sql), batch: async () => [] },
    R2_RENDERS: {
      head: async (k: string) => (k in stored ? { size: 1 } : null),
      get: async (k: string) => (k in stored ? { text: async () => stored[k], json: async () => JSON.parse(stored[k]) } : null),
      put: async (k: string, b: string) => { stored[k] = b; },
      delete: async (k: string) => { delete stored[k]; },
      list: async () => ({ objects: [] }),
    },
  };
  return { e, stored, doc };
}

const cancel = (e: unknown) =>
  worker.fetch(new Request(`https://studio.example/api/storyboard/render/${ID}`, { method: "DELETE" }), e as never, ctx);

describe("DELETE /api/storyboard/render/:jobId while a tick holds the film (vivijure-cf#1215)", () => {
  it("is a retryable 409, and the doc is not written", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const { e, stored, doc } = env(true);
    const pending = cancel(e);
    await vi.advanceTimersByTimeAsync(FILM_CANCEL_WAIT_MS + 5_000);
    const res = await pending;
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ jobId: ID, retryable: true });
    expect(stored[filmJobDocKey(ID)]).toBe(doc);
  });

  it("control: with the film free, the same request cancels it", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { e, stored } = env(false);
    const res = await cancel(e);
    expect(res.status).toBe(200);
    expect(JSON.parse(stored[filmJobDocKey(ID)])).toMatchObject({ cancelled: true, phase: "failed" });
  });
});
