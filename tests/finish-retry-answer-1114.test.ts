import { describe, expect, it, vi } from "vitest";
import { API_ROUTES } from "../src/index";
import { filmJobDocKey } from "@skyphusion-labs/vivijure-core/film-orchestrator";

// cf#1114. The real route over core's real retryFilmFinish: only the bucket is faked.

const route = API_ROUTES.find((r) => r.pattern === "/api/render/film/:id/finish-retry")!;
const named = { stage: "finish", step: "MODULE_U", shot_id: "s1", code: "refused", kept: "k", at: 1 };
const base = { film_id: "film-1", project: "p", phase: "done", created_at: 1, scenes: [], bundle_key: "b", film_key: "renders/p/film.mp4" };

async function post(job: Record<string, unknown>) {
  vi.spyOn(console, "log").mockImplementation(() => {});
  const env = {
    R2_RENDERS: {
      get: async (k: string) => (k === filmJobDocKey("film-1") ? { text: async () => JSON.stringify(job) } : null),
      head: async () => null,
      put: async () => {},
    },
  };
  const res = await route.handler(new Request("https://x/api/render/film/film-1/finish-retry", { method: "POST" }), env as never, {} as never, { id: "film-1" });
  return { res, body: (await res.json()) as { error: string; code: string } };
}

describe("finish-retry when nothing starts", () => {
  it("a running film is busy and says try again", async () => {
    const { res, body } = await post({ ...base, phase: "mux", finish_incomplete: [named] });
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ code: "busy", error: "this film is busy, try again shortly" });
    expect(res.headers.get("retry-after")).toBe("30");
  });

  it("a clean film has nothing to retry, with no retry hint", async () => {
    const { res, body } = await post(base);
    expect(res.status).toBe(409);
    expect(body).toMatchObject({ code: "nothing_to_retry", error: "this film has no finish step to retry" });
    expect(res.headers.get("retry-after")).toBeNull();
  });

  it("a refused shot cannot deliver, and the answer does not say why", async () => {
    const { res, body } = await post({
      ...base, phase: "failed", finish_incomplete: [named],
      finish_shots: [{ shot_id: "s1", clip_key: "c", chain: ["MODULE_U"], configs: [{}], idx: 0, status: "refused", applied: [], error: "refused for a safety reason" }],
    });
    expect(res.status).toBe(409);
    expect(body.code).toBe("cannot_deliver");
    expect(JSON.stringify(body)).not.toMatch(/safety/);
    expect(res.headers.get("retry-after")).toBeNull();
  });
});
