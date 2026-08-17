/// <reference types="node" />
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { readIdempotencyKey } from "../src/film-idempotency";

// cf#528: cf#518's client-supplied idempotency_key is unreachable unless the
// panel sends it AND the host forwards it into startFilmJob / startFilmFromKeyframes.
// A comment or a body-type field that never lands on the orchestrator args is the
// exact defect this issue was filed for, so both halves are asserted.

const STATE = readFileSync(`${process.cwd()}/public/planner-state.js`, "utf8");
const RENDER = readFileSync(`${process.cwd()}/public/planner-render.js`, "utf8");
const BUNDLE = readFileSync(`${process.cwd()}/public/planner-bundle.js`, "utf8");
const ROW = readFileSync(`${process.cwd()}/public/planner-history-row.js`, "utf8");
const INDEX = readFileSync(`${process.cwd()}/src/index.ts`, "utf8");
const FINALIZE = readFileSync(`${process.cwd()}/src/finalize-from-keyframes.ts`, "utf8");
const RETRY = readFileSync(`${process.cwd()}/src/render-retry.ts`, "utf8");

describe("cf#528 panel source sends idempotency_key on every film submit", () => {
  it("the helper mints a UUID and writes snake_case idempotency_key onto the body", () => {
    expect(STATE).toContain("function mintFilmIdempotencyKey");
    expect(STATE).toContain("crypto.randomUUID");
    expect(STATE).toContain("body.idempotency_key = inflight.key");
    expect(STATE).toContain("function postFilmSubmit");
  });

  it("the same click reuses the stored key on a 5xx retry", () => {
    // Without this, a helper that minted a fresh UUID on every fetch would
    // satisfy "the panel sends a key" and still produce two films on retry.
    expect(STATE).toContain("if (!inflight.key) inflight.key = mintFilmIdempotencyKey()");
    expect(STATE).toContain("resp.status >= 500");
    expect(STATE).toContain("attempt === 0");
  });

  it("planner render, scatter, from-keyframes, finalize, and retry all go through postFilmSubmit", () => {
    expect(RENDER).toContain('postFilmSubmit("/api/storyboard/render"');
    expect(RENDER).toContain('postFilmSubmit("/api/storyboard/render/scatter"');
    expect(BUNDLE).toContain('postFilmSubmit("/api/storyboard/render-from-keyframes"');
    expect(ROW).toContain('postFilmSubmit(');
    expect(ROW).toMatch(/\/finalize"/);
    expect(ROW).toMatch(/\/retry"/);
  });

  it("NEGATIVE CONTROL: the panel does not send camelCase-only idempotencyKey as the wire field", () => {
    // Core accepts either spelling. The panel must send the snake_case field
    // the issue named; a camelCase-only body would still work today and then
    // silently stop if the reader is tightened to the documented name.
    expect(STATE).toContain("body.idempotency_key");
    expect(STATE).not.toContain("body.idempotencyKey");
    expect(RENDER).not.toContain("idempotencyKey");
    expect(BUNDLE).not.toContain("idempotencyKey");
    expect(ROW).not.toContain("idempotencyKey");
  });
});

describe("cf#528 host forwards the field into core", () => {
  it("startFilmJob call sites pass idempotency_key from the request body", () => {
    expect(INDEX).toContain("idempotency_key: readIdempotencyKey(b)");
    expect(INDEX).toContain("idempotency_key: readIdempotencyKey(a)");
    expect(RETRY).toContain("idempotency_key,");
  });

  it("startFilmFromKeyframes call sites pass idempotency_key", () => {
    expect(INDEX).toContain("idempotency_key: readIdempotencyKey(b)");
    expect(FINALIZE).toContain("idempotency_key: readIdempotencyKey({ idempotency_key: args.idempotency_key })");
  });

  it("finalize and retry handlers read the key off the request and thread it", () => {
    expect(INDEX).toContain("idempotency_key: finalizeIdempotencyKey");
    expect(INDEX).toContain("retryFailedRender(env, row, { idempotency_key })");
  });
});

describe("cf#528 readIdempotencyKey", () => {
  it("keeps a non-blank snake_case key", () => {
    expect(readIdempotencyKey({ idempotency_key: "panel-click-1" })).toBe("panel-click-1");
  });

  it("accepts camelCase as the same field", () => {
    expect(readIdempotencyKey({ idempotencyKey: "panel-click-2" })).toBe("panel-click-2");
  });

  it("NEGATIVE: blank, whitespace, and non-string are absence, not a key", () => {
    expect(readIdempotencyKey({ idempotency_key: "" })).toBeUndefined();
    expect(readIdempotencyKey({ idempotency_key: "   " })).toBeUndefined();
    expect(readIdempotencyKey({ idempotency_key: 12 })).toBeUndefined();
    expect(readIdempotencyKey(null)).toBeUndefined();
    expect(readIdempotencyKey({})).toBeUndefined();
  });
});

function loadSubmitHelpers(fetchImpl: typeof fetch, uuid = "uuid-fixed") {
  const start = STATE.indexOf("// cf#528:");
  const end = STATE.indexOf("// ---------- localStorage");
  if (start < 0 || end < 0 || end <= start) {
    throw new Error("cf#528 helper block not found in planner-state.js");
  }
  const block = STATE.slice(start, end);
  return new Function(
    "crypto",
    "fetch",
    `${block}\nreturn { mintFilmIdempotencyKey, attachFilmIdempotencyKey, postFilmSubmit };`,
  )({ randomUUID: () => uuid }, fetchImpl) as {
    mintFilmIdempotencyKey: () => string;
    attachFilmIdempotencyKey: (body: Record<string, unknown>, inflight: { key?: string }) => string;
    postFilmSubmit: (url: string, body: Record<string, unknown>, inflight: { key?: string }) => Promise<{ status: number }>;
  };
}

describe("cf#528 postFilmSubmit reuses the in-flight key", () => {
  it("a 5xx retry POSTs the same idempotency_key, not a second mint", async () => {
    const seen: string[] = [];
    let calls = 0;
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      calls += 1;
      const parsed = JSON.parse(String(init?.body)) as { idempotency_key?: string };
      seen.push(parsed.idempotency_key ?? "");
      return { status: calls === 1 ? 503 : 201 } as Response;
    };
    const { postFilmSubmit } = loadSubmitHelpers(fetchImpl as typeof fetch, "click-aaa");
    const inflight: { key?: string } = {};
    const body: Record<string, unknown> = { bundleKey: "bundles/x.tar.gz" };
    const resp = await postFilmSubmit("/api/storyboard/render", body, inflight);
    expect(calls).toBe(2);
    expect(resp.status).toBe(201);
    expect(seen).toEqual(["click-aaa", "click-aaa"]);
    expect(inflight.key).toBe("click-aaa");
    expect(body.idempotency_key).toBe("click-aaa");
  });

  it("NEGATIVE: a 4xx is not retried", async () => {
    let calls = 0;
    const fetchImpl = async () => {
      calls += 1;
      return { status: 400 } as Response;
    };
    const { postFilmSubmit } = loadSubmitHelpers(fetchImpl as typeof fetch, "click-bbb");
    const resp = await postFilmSubmit("/api/storyboard/render", {}, {});
    expect(calls).toBe(1);
    expect(resp.status).toBe(400);
  });

  it("a new inflight object (new click) can mint a different key", () => {
    let n = 0;
    const fetchImpl = async () => ({ status: 201 }) as Response;
    const helpers = loadSubmitHelpers(fetchImpl as typeof fetch, "unused");
    const mint = () => {
      n += 1;
      return `click-${n}`;
    };
    const a: { key?: string } = {};
    const b: { key?: string } = {};
    const bodyA: Record<string, unknown> = {};
    const bodyB: Record<string, unknown> = {};
    // Drive attach directly so the mint sequence is the test, not fetch.
    const scoped = new Function(
      "crypto",
      `${STATE.slice(STATE.indexOf("function mintFilmIdempotencyKey"), STATE.indexOf("async function postFilmSubmit"))}
       return { attachFilmIdempotencyKey };`,
    )({ randomUUID: mint }) as { attachFilmIdempotencyKey: typeof helpers.attachFilmIdempotencyKey };
    scoped.attachFilmIdempotencyKey(bodyA, a);
    scoped.attachFilmIdempotencyKey(bodyB, b);
    expect(bodyA.idempotency_key).toBe("click-1");
    expect(bodyB.idempotency_key).toBe("click-2");
  });
});

const h = vi.hoisted(() => ({ started: [] as Array<Record<string, unknown>> }));

vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_env: unknown, args: Record<string, unknown>) => {
      h.started.push(args);
      return { film_id: "film-528", phase: "keyframe", scenes: args.scenes, project: "p", created_at: 0 };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/renders-db", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/renders-db")>();
  return { ...actual, insertRender: vi.fn(async () => {}) };
});
vi.mock("../src/film-render-bridge", async (orig) => {
  const actual = await orig<typeof import("../src/film-render-bridge")>();
  return { ...actual, filmRowFromJob: vi.fn(() => ({ jobId: "film-528", project: "p" })) };
});

import worker from "../src/index";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";
import type { Env } from "../src/env";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

function moduleBinding(name: string, hooks: string[], locality: string) {
  return {
    fetch: async () =>
      new Response(
        JSON.stringify({ name, version: "0.1.0", api: MODULE_API, hooks, ui: { order: 10, locality } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  };
}

const env = {
  ALLOW_UNAUTHENTICATED: "true",
  ASSETS: { fetch: async () => new Response("ASSET") },
  SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
  MODULE_KEYFRAME: moduleBinding("keyframe-sdxl", ["keyframe"], "cloud"),
  MODULE_ALIBABA_WAN: moduleBinding("alibaba-wan", ["motion.backend"], "cloud"),
} as unknown as Env;

describe("cf#528 hSubmitRender forwards the client key into startFilmJob", () => {
  beforeEach(() => {
    h.started = [];
  });

  it("POST /api/storyboard/render carries idempotency_key through to startFilmJob", async () => {
    const res = await worker.fetch(
      new Request("https://studio.example/api/storyboard/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bundleKey: "bundles/good.tar.gz",
          scenes: [{ shot_id: "shot_01", prompt: "a shot", seconds: 4 }],
          motion_backend: "alibaba-wan",
          idempotency_key: "panel-click-abc",
        }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    expect(h.started.length, "startFilmJob must run so the forward is observable").toBe(1);
    expect(h.started[0].idempotency_key).toBe("panel-click-abc");
  });

  it("NEGATIVE: omitting the field does not invent a key (natural-key backstop stays)", async () => {
    const res = await worker.fetch(
      new Request("https://studio.example/api/storyboard/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          bundleKey: "bundles/good.tar.gz",
          scenes: [{ shot_id: "shot_01", prompt: "a shot", seconds: 4 }],
          motion_backend: "alibaba-wan",
        }),
      }),
      env,
      ctx,
    );
    expect(res.status).toBe(201);
    expect(h.started.length).toBe(1);
    expect(h.started[0].idempotency_key).toBeUndefined();
  });
});
