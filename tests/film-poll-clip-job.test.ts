import { describe, it, expect, vi } from "vitest";
import { API_ROUTES } from "../src/index";
import { filmJobDocKey } from "@skyphusion-labs/vivijure-core/film-orchestrator";

// The real route over core's real tick: only the storage and the database are faked.
describe("a film's poll says whether it holds a clip job", () => {
  const route = API_ROUTES.find((r) => r.method === "GET" && r.pattern === "/api/render/film/:id")!;
  async function poll(job: Record<string, unknown>) {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const stmt = { run: async () => ({ meta: { changes: 1 } }), first: async () => null, all: async () => ({ results: [] }) };
    const env = {
      DB: { prepare: () => ({ ...stmt, bind: () => stmt }), batch: async () => [] },
      R2_RENDERS: {
        get: async (k: string) => (k === filmJobDocKey("film-1") ? { text: async () => JSON.stringify(job) } : null),
        head: async () => null,
        put: async () => {},
      },
    };
    const res = await route.handler(new Request("https://x/api/render/film/film-1"), env as never, { waitUntil: () => {} } as never, { id: "film-1" });
    return (await res.json()) as { clip_job_id?: string };
  }
  const base = { film_id: "film-1", project: "p", phase: "failed", error: "x", created_at: 1, scenes: [], bundle_key: "b", cancelled: true };

  it("does when it does", async () => {
    expect((await poll({ ...base, clip_job_id: "clips-1" })).clip_job_id).toBe("clips-1");
  });
  it("and leaves it out when it does not", async () => {
    expect("clip_job_id" in (await poll(base))).toBe(false);
  });
});

