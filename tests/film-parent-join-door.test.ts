import { describe, it, expect, vi } from "vitest";

// How the store reads the video-finish door. The answers decide whether a paid film waits, retries or
// ends, so each one is pinned at the real function with only the door faked.
const h = vi.hoisted(() => ({ status: 200, body: {} as unknown, gone: false }));
vi.mock("@skyphusion-labs/vivijure-core", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core")>();
  return {
    ...actual,
    mediaFinishHeaders: vi.fn(async () => ({})),
    videoFinishFetch: vi.fn(async () => (h.gone ? null : new Response(JSON.stringify(h.body), { status: h.status }))),
  };
});
vi.mock("../src/r2-presign", async (orig) => ({
  ...(await orig<typeof import("../src/r2-presign")>()),
  presignR2Get: vi.fn(async () => "https://g"),
  presignR2Put: vi.fn(async () => "https://p"),
}));

import { parentDeps, type ParentDoors } from "../src/film-parent-store";
import { JoinTransient, type ParentDoc } from "../src/film-parent";

const doc = { film_id: "feature-x" } as ParentDoc;
const deps = parentDeps({} as never, { doc, etag: "e" }, {} as ParentDoors);
const set = (status: number, body: unknown = {}) => {
  h.status = status;
  h.body = body;
  h.gone = false;
};

describe("reading a join", () => {
  const cases: Array<[string, number, unknown, string]> = [
    ["a gateway error waits", 502, {}, "pending"],
    ["a timeout waits", 524, {}, "pending"],
    ["a 500 waits", 500, {}, "pending"],
    ["a 404 is missing", 404, {}, "missing"],
    ["a bad token is an error, not a wait", 401, {}, "error"],
    ["a forbidden token is an error", 403, {}, "error"],
    ["a running job waits", 200, { status: "pending" }, "pending"],
    ["a failed job fails", 200, { status: "failed", error: "x" }, "failed"],
    ["a completed job completes", 200, { status: "completed", result: { bytes: 1, durationSeconds: 2, filmOffsetsSeconds: [0] } }, "completed"],
  ];
  for (const [name, status, body, want] of cases) {
    it(name, async () => {
      set(status, body);
      expect((await deps.readJoin(doc, "j")).status).toBe(want);
    });
  }
  it("no door waits", async () => {
    h.gone = true;
    expect((await deps.readJoin(doc, "j")).status).toBe("pending");
  });
});

describe("submitting a join", () => {
  it("a full door and a 5xx are transient", async () => {
    for (const status of [429, 500, 503]) {
      set(status, { error: "busy" });
      await expect(deps.submitJoin(doc, ["k"], "o")).rejects.toBeInstanceOf(JoinTransient);
    }
    h.gone = true;
    await expect(deps.submitJoin(doc, ["k"], "o")).rejects.toBeInstanceOf(JoinTransient);
  });
  it("a refusal of the request is not", async () => {
    for (const status of [400, 413, 422]) {
      set(status, { error: "no" });
      const e = await deps.submitJoin(doc, ["k"], "o").catch((x: unknown) => x);
      expect(e).toBeInstanceOf(Error);
      expect(e).not.toBeInstanceOf(JoinTransient);
    }
  });
  it("an accept returns the job", async () => {
    set(202, { ok: true, jobId: "rk.join-1" });
    expect(await deps.submitJoin(doc, ["k"], "o")).toBe("rk.join-1");
  });
});
