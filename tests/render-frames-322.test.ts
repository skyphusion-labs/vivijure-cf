import { describe, it, expect } from "vitest";
import { installVfFetch } from "./install-vf-fetch";
import worker from "../src/index";
import { ARTIFACT_PREFIXES, safeArtifactContentType } from "../src/index";
import {
  buildFramesSheet, clampFrameCount, parseFrameAt, deriveFramesKey, gridFor,
  requestFramesFromContainer, framesFailure, FRAMES_CONTENT_TYPE,
  type FramesFailureState,
} from "../src/render-frames";
import type { Env } from "../src/env";
import { isSafeRelKey } from "../src/shared";

// cf#322: POST /api/render/frames -- sample a rendered clip into ONE jpeg contact sheet stored as a
// normal artifact, so a transport that can carry an image but not a video can show motion output.
//
// What these tests are actually for. The design's whole claim is "every existing surface picks the
// sheet up for free", and that claim rests on TWO properties which are invisible in the happy path and
// which fail SILENTLY if they are wrong:
//
//   1. the derived key must be inside ARTIFACT_PREFIXES, or /api/artifact and /api/artifact-url both
//      404 it while every unit test still passes (chat-artifacts.ts records this exact bug);
//   2. the stored content type must survive safeArtifactContentType, or the sheet is served as
//      application/octet-stream and view_artifact -- which only inlines /^image\// -- will not show it.
//
// Both are asserted against the REAL exported guard, not a transcribed copy, each with a control that
// is watched failing. A guard that has never produced its negative is not known to work.

function makeEnv(opts: { vpc?: unknown; seed?: Record<string, { size: number; mime: string }> } = {}) {
  const r2 = new Map<string, { size: number; mime: string }>(Object.entries(opts.seed || {}));
  const env = {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET", { status: 200 }) },
    R2_S3_ACCESS_KEY_ID: "AKIAEXAMPLE",
    R2_S3_SECRET_ACCESS_KEY: "s3cr3t-test-value-not-a-real-key",
    R2_S3_ENDPOINT: "https://acct.r2.cloudflarestorage.com",
    R2_S3_BUCKET: "vivijure",
    R2_RENDERS: {
      async head(key: string) {
        const o = r2.get(key);
        return o ? { size: o.size, httpMetadata: { contentType: o.mime } } : null;
      },
    },
    ...(opts.vpc ? { VIDEO_FINISH_URL: "https://video-finish.test" } : {}),
  } as unknown as Env;
  if (opts.vpc && typeof opts.vpc === "object" && opts.vpc && "fetch" in opts.vpc) {
    const fetcher = opts.vpc as { fetch: (u: RequestInfo, i?: RequestInit) => Promise<Response> };
    installVfFetch((input, init) => fetcher.fetch(input as RequestInfo, init));
  }
  return { env, r2 };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const CLIP = "renders/film-abc/film.mp4";

function post(body: unknown) {
  return new Request("https://studio.example/api/render/frames", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A container that always succeeds, recording every call so "was it called" is assertable. */
function okVpc(calls: unknown[]) {
  return {
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body || "{}")) });
      return new Response(
        JSON.stringify({ ok: true, key: "k", count: 9, frame_times: [1, 2, 3], duration: 5.33 }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  };
}

// --- 1. THE PREFIX PROPERTY (the one the whole design rests on) ---------------------------------
describe("cf#322 derived key stays inside ARTIFACT_PREFIXES", () => {
  it("the real prefix list is non-empty, so the loop below is not vacuous", () => {
    // Positive control on the TEST ITSELF: an empty list would make every for-of assertion pass
    // without ever executing. This is the assertion that makes the next one mean something.
    expect(ARTIFACT_PREFIXES.length).toBeGreaterThan(5);
  });

  it("preserves the source prefix for EVERY artifact namespace", () => {
    for (const pre of ARTIFACT_PREFIXES) {
      const src = `${pre}some/dir/clip.mp4`;
      for (const count of [1, 4, 9, 25]) {
        const key = deriveFramesKey(src, count, count === 1 ? 2.5 : null);
        expect(key.startsWith(pre), `${key} escaped prefix ${pre}`).toBe(true);
        expect(
          ARTIFACT_PREFIXES.some((p) => key.startsWith(p)),
          `${key} is outside ARTIFACT_PREFIXES`,
        ).toBe(true);
        expect(isSafeRelKey(key), `${key} fails isSafeRelKey`).toBe(true);
      }
    }
  });

  it("CONTROL: a fixed-literal key WOULD escape, so the assertion above can fail", () => {
    // The obvious wrong implementation: put every sheet under a namespace of its own. It reads fine
    // and it is unreachable through the artifact routes. Watching this fail is what proves the
    // passing assertion above is doing work.
    const naive = (src: string) => `frames/${src.replace(/\//g, "_")}.jpg`;
    const escaped = naive(CLIP);
    expect(ARTIFACT_PREFIXES.some((p) => escaped.startsWith(p))).toBe(false);
  });

  it("is deterministic, so a repeat request addresses the same object", () => {
    expect(deriveFramesKey(CLIP, 9, null)).toBe(deriveFramesKey(CLIP, 9, null));
    expect(deriveFramesKey(CLIP, 9, null)).toBe("renders/film-abc/frames/film-3x3.jpg");
  });

  it("varies the key by spec, so a 3x3 and a single frame do not collide", () => {
    const sheet = deriveFramesKey(CLIP, 9, null);
    const one = deriveFramesKey(CLIP, 1, 2.5);
    const other = deriveFramesKey(CLIP, 1, 4);
    expect(new Set([sheet, one, other]).size).toBe(3);
  });
});

// --- 2. THE CONTENT-TYPE PROPERTY ---------------------------------------------------------------
describe("cf#322 the stored type survives the artifact route's remap", () => {
  it("image/jpeg passes through unchanged AND is inlineable by view_artifact", () => {
    expect(safeArtifactContentType(FRAMES_CONTENT_TYPE)).toBe(FRAMES_CONTENT_TYPE);
    // view_artifact inlines only when the served type matches this. If the remap above ever changed,
    // the sheet would still be served, just never SHOWN -- the silent half of this failure.
    expect(/^image\//i.test(safeArtifactContentType(FRAMES_CONTENT_TYPE))).toBe(true);
  });

  it("CONTROL: a type outside the allowlist IS remapped, so the assertion can fail", () => {
    expect(safeArtifactContentType("text/html")).toBe("application/octet-stream");
    expect(/^image\//i.test(safeArtifactContentType("text/html"))).toBe(false);
  });
});

// --- 3. FAILURE STATES ARE DISTINCT -------------------------------------------------------------
describe("cf#322 failure states are not collapsed", () => {
  const STATES: FramesFailureState[] = [
    "tier-unavailable", "route-not-served", "container-unreachable", "container-error",
  ];

  it("every state has its OWN reason string", () => {
    const reasons = STATES.map((s) => framesFailure(s).reason);
    expect(new Set(reasons).size).toBe(STATES.length);
    for (const r of reasons) expect(r.length).toBeGreaterThan(40);
  });

  it("the rollout state says it is expected, so nobody hunts a bug that does not exist", () => {
    const r = framesFailure("route-not-served").reason.toLowerCase();
    expect(r).toContain("expected");
    expect(r).toContain("rollout");
  });

  it("a container 404 is route-not-served, NOT unreachable", async () => {
    const vpc = { fetch: async () => new Response("nope", { status: 404 }) };
    const r = await requestFramesFromContainer(vpc, {}, { retries: 1, backoffMs: 0 });
    expect(r.ok).toBe(false);
    expect((r as { state: string }).state).toBe("route-not-served");
  });

  it("a transport throw is container-unreachable, NOT route-not-served", async () => {
    const vpc = { fetch: async () => { throw new Error("ECONNREFUSED"); } };
    const r = await requestFramesFromContainer(vpc, {}, { retries: 1, backoffMs: 0 });
    expect(r.ok).toBe(false);
    expect((r as { state: string }).state).toBe("container-unreachable");
  });

  it("a 500 from a serving container is container-error", async () => {
    const vpc = { fetch: async () => new Response("boom", { status: 500 }) };
    const r = await requestFramesFromContainer(vpc, {}, { retries: 1, backoffMs: 0 });
    expect((r as { state: string }).state).toBe("container-error");
  });

  it("a 200 whose body says ok:false is container-error, not success", async () => {
    const vpc = {
      fetch: async () => new Response(JSON.stringify({ ok: false, error: "ffmpeg died" }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    };
    const r = await requestFramesFromContainer(vpc, {}, { retries: 1, backoffMs: 0 });
    expect(r.ok).toBe(false);
    expect((r as { state: string }).state).toBe("container-error");
  });

  it("an unbound tier is reported as a provisioning state, not a fault", async () => {
    const { env } = makeEnv({ seed: { [CLIP]: { size: 100, mime: "video/mp4" } } });
    const out = await buildFramesSheet(env, CLIP, 9, null, { retries: 1, backoffMs: 0 });
    expect(out.ok).toBe(false);
    expect((out as { state: string }).state).toBe("tier-unavailable");
  });
});

// --- 4. IDEMPOTENCE, WITH THE CONTROL THAT MAKES IT MEAN SOMETHING ------------------------------
describe("cf#322 a repeat request reuses the stored sheet", () => {
  it("CONTROL: with no sheet in R2, the container IS called", async () => {
    const calls: unknown[] = [];
    const { env } = makeEnv({ vpc: okVpc(calls), seed: { [CLIP]: { size: 100, mime: "video/mp4" } } });
    const out = await buildFramesSheet(env, CLIP, 9, null, { retries: 1, backoffMs: 0 });
    expect(out.ok).toBe(true);
    expect((out as { reused: boolean }).reused).toBe(false);
    expect(calls.length).toBe(1); // without this, "not called" below proves nothing
  });

  it("with the sheet already in R2, the container is NOT called", async () => {
    const calls: unknown[] = [];
    const sheet = deriveFramesKey(CLIP, 9, null);
    const { env } = makeEnv({
      vpc: okVpc(calls),
      seed: { [CLIP]: { size: 100, mime: "video/mp4" }, [sheet]: { size: 50, mime: FRAMES_CONTENT_TYPE } },
    });
    const out = await buildFramesSheet(env, CLIP, 9, null, { retries: 1, backoffMs: 0 });
    expect(out.ok).toBe(true);
    expect((out as { reused: boolean }).reused).toBe(true);
    expect((out as { key: string }).key).toBe(sheet);
    expect(calls.length).toBe(0);
  });

  it("sends the studio's content type and grid to the container", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const { env } = makeEnv({
      vpc: okVpc(calls as unknown[]),
      seed: { [CLIP]: { size: 100, mime: "video/mp4" } },
    });
    await buildFramesSheet(env, CLIP, 9, null, { retries: 1, backoffMs: 0 });
    expect(calls[0].url).toBe("https://video-finish.test/frames");
    expect(calls[0].body.contentType).toBe(FRAMES_CONTENT_TYPE);
    expect(calls[0].body.cols).toBe(3);
    expect(calls[0].body.rows).toBe(3);
    expect(String(calls[0].body.videoUrl)).toContain("X-Amz-Signature");
    expect(String(calls[0].body.outputUrl)).toContain("X-Amz-Signature");
  });
});

// --- 5. THE ROUTE: GUARDS AND SHAPE -------------------------------------------------------------
describe("cf#322 POST /api/render/frames", () => {
  it("refuses a key outside the artifact namespaces", async () => {
    const calls: unknown[] = [];
    const { env } = makeEnv({ vpc: okVpc(calls) });
    const res = await worker.fetch(post({ key: "secrets/prod.env" }), env, ctx);
    expect(res.status).toBe(404);
    expect(calls.length).toBe(0);
  });

  it("refuses a traversal key", async () => {
    const { env } = makeEnv({ vpc: okVpc([]) });
    const res = await worker.fetch(post({ key: "renders/../../etc/passwd" }), env, ctx);
    expect(res.status).toBe(404);
  });

  it("404s an artifact that does not exist, rather than signing a miss", async () => {
    const { env } = makeEnv({ vpc: okVpc([]) });
    const res = await worker.fetch(post({ key: "renders/film-nope/film.mp4" }), env, ctx);
    expect(res.status).toBe(404);
  });

  it("400s an invalid body", async () => {
    const { env } = makeEnv({ vpc: okVpc([]) });
    const req = new Request("https://studio.example/api/render/frames", {
      method: "POST", headers: { "content-type": "application/json" }, body: "not json",
    });
    expect((await worker.fetch(req, env, ctx)).status).toBe(400);
  });

  it("returns the key, the grid, and the honest scope of the evidence", async () => {
    const calls: unknown[] = [];
    const { env } = makeEnv({ vpc: okVpc(calls), seed: { [CLIP]: { size: 100, mime: "video/mp4" } } });
    const res = await worker.fetch(post({ key: CLIP }), env, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.key).toBe("renders/film-abc/frames/film-3x3.jpg");
    expect(body.source_key).toBe(CLIP);
    expect(body.content_type).toBe(FRAMES_CONTENT_TYPE);
    expect(body.grid).toEqual({ cols: 3, rows: 3 });
    // The scope of the evidence travels WITH the evidence: a caller cannot quote the sheet as proof
    // the clip was checked, because the response says in words that it is not.
    expect(String(body.proves)).toContain("not about the whole clip");
  });

  it("surfaces the container state and a non-2xx when extraction fails", async () => {
    const vpc = { fetch: async () => new Response("nope", { status: 404 }) };
    const { env } = makeEnv({ vpc, seed: { [CLIP]: { size: 100, mime: "video/mp4" } } });
    const res = await worker.fetch(post({ key: CLIP }), env, ctx);
    expect(res.status).toBe(503);
    const body = await res.json() as Record<string, unknown>;
    expect(body.state).toBe("route-not-served");
    expect(String(body.error).toLowerCase()).toContain("expected");
  });
});

// --- 6. PARAMETER BANDS -------------------------------------------------------------------------
describe("cf#322 parameter handling", () => {
  it("clampFrameCount defaults, clamps, and never throws", () => {
    expect(clampFrameCount(null)).toBe(9);
    expect(clampFrameCount("")).toBe(9);
    expect(clampFrameCount("abc")).toBe(9);
    expect(clampFrameCount("1")).toBe(1);
    expect(clampFrameCount("0")).toBe(1);
    expect(clampFrameCount("-5")).toBe(1);
    expect(clampFrameCount("25")).toBe(25);
    expect(clampFrameCount("9999")).toBe(25);
  });

  it("parseFrameAt rejects garbage and negatives without throwing", () => {
    expect(parseFrameAt(null)).toBe(null);
    expect(parseFrameAt("abc")).toBe(null);
    expect(parseFrameAt("-1")).toBe(null);
    expect(parseFrameAt("2.5")).toBe(2.5);
    expect(parseFrameAt("0")).toBe(0);
  });

  it("gridFor is square-ish and always has room for every sample", () => {
    for (let n = 1; n <= 25; n++) {
      const g = gridFor(n);
      expect(g.cols * g.rows, `grid too small for ${n}`).toBeGreaterThanOrEqual(n);
    }
    expect(gridFor(9)).toEqual({ cols: 3, rows: 3 });
    expect(gridFor(4)).toEqual({ cols: 2, rows: 2 });
    expect(gridFor(6)).toEqual({ cols: 3, rows: 2 });
  });

  it("`at` is ignored for a sheet, because only a single frame has one timestamp", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const { env } = makeEnv({
      vpc: okVpc(calls as unknown[]),
      seed: { [CLIP]: { size: 100, mime: "video/mp4" } },
    });
    const res = await worker.fetch(post({ key: CLIP, count: 9, at: 3 }), env, ctx);
    expect(res.status).toBe(200);
    expect(calls[0].body.at).toBe(null);
  });
});
