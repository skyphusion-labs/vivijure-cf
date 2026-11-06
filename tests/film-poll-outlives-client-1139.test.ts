import { describe, it, expect, vi } from "vitest";
import { API_ROUTES } from "../src/index";
import { filmJobDocKey } from "@skyphusion-labs/vivijure-core/film-orchestrator";

// vivijure-cf#1139. A Worker's execution context ends when its client disconnects, and a poll cut off
// mid-tick never wrote the film doc or released the advance lease. Each poll route must hand its tick to
// ctx.waitUntil, so the tick can finish after the client is gone. The real route over core's real tick:
// only storage and the database are faked.

const ROUTES: Array<{ pattern: string; params: Record<string, string> }> = [
  { pattern: "/api/render/film/:id", params: { id: "film-1" } },
  { pattern: "/api/storyboard/render/:jobId", params: { jobId: "film-1" } },
];

describe.each(ROUTES)("vivijure-cf#1139: GET $pattern keeps its tick alive past the client", ({ pattern, params }) => {
  const route = API_ROUTES.find((r) => r.method === "GET" && r.pattern === pattern);

  it("the route exists (control)", () => {
    expect(route).toBeDefined();
  });

  it("hands the tick to waitUntil before it finishes, and that promise is the tick", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const job = { film_id: "film-1", project: "p", phase: "done", created_at: 1, scenes: [], bundle_key: "b" };
    let releaseRead!: () => void;
    const gate = new Promise<void>((r) => { releaseRead = r; });
    let docReads = 0;
    const leaseSql: string[] = [];
    const stmt = (sql: string) => {
      const s = {
        run: async () => { if (sql.includes("advance_lease")) leaseSql.push(sql); return { meta: { changes: 1 } }; },
        first: async () => null,
        all: async () => ({ results: [] }),
      };
      return { ...s, bind: () => s };
    };
    const env = {
      DB: { prepare: (sql: string) => stmt(sql), batch: async () => [] },
      R2_RENDERS: {
        get: async (k: string) => {
          if (k !== filmJobDocKey("film-1")) return null;
          docReads += 1;
          if (docReads === 1) await gate; // the tick is mid-flight, holding the lease
          return { text: async () => JSON.stringify(job) };
        },
        head: async () => null,
        put: async () => {},
      },
    };
    const held: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => { held.push(p); }, passThroughOnException() {} };
    // The client goes away: nobody awaits the handler.
    void route!.handler(new Request(`https://x${pattern}`), env as never, ctx as never, params);
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
    expect(held.length).toBeGreaterThanOrEqual(1);
    const releasedBefore = leaseSql.filter((s) => s.includes("advance_lease = NULL")).length;
    expect(releasedBefore).toBe(0); // control: the tick has not finished yet
    releaseRead();
    await Promise.all(held);
    // The held promise covered the whole tick: the lease release ran inside it.
    expect(leaseSql.filter((s) => s.includes("advance_lease = NULL")).length).toBe(1);
  });
});
