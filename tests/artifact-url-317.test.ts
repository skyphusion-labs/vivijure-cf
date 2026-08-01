import { describe, it, expect } from "vitest";
import worker from "../src/index";
import { clampArtifactUrlTtl } from "../src/index";
import type { Env } from "../src/env";

// cf#317: GET /api/artifact-url/<key> -- turn an artifact KEY into a SHORT-LIVED presigned GET so a
// caller that cannot carry bytes (the MCP proxies the studio over HTTP) can still fetch the object.
//
// What these tests are actually for: a presigned URL is a capability credential, so the two properties
// that matter are SCOPE (it signs exactly the one key asked for, and only keys the serve route would
// serve) and EXPIRY (the caller cannot widen the lifetime). Both are asserted with a negative control
// alongside, because a guard that has never been watched failing is not known to work.

function makeEnv() {
  const r2 = new Map<string, { size: number; mime: string }>();
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
        if (!o) return null;
        return { size: o.size, httpMetadata: { contentType: o.mime } };
      },
    },
  } as unknown as Env;
  return { env, r2 };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const url = (path: string) => `https://studio.example${path}`;

const FILM = "renders/film-abc/film.mp4";
function seed(r2: Map<string, { size: number; mime: string }>) {
  r2.set(FILM, { size: 3811331, mime: "video/mp4" });
  r2.set("cast/portrait-1.png", { size: 2048, mime: "image/png" });
}

describe("cf#317 clampArtifactUrlTtl", () => {
  it("defaults when the param is absent or blank", () => {
    expect(clampArtifactUrlTtl(null)).toBe(300);
    expect(clampArtifactUrlTtl("")).toBe(300);
    expect(clampArtifactUrlTtl("   ")).toBe(300);
  });

  it("defaults on garbage rather than throwing", () => {
    expect(clampArtifactUrlTtl("abc")).toBe(300);
    expect(clampArtifactUrlTtl("NaN")).toBe(300);
  });

  it("honours a value inside the band", () => {
    expect(clampArtifactUrlTtl("60")).toBe(60);
    expect(clampArtifactUrlTtl("900")).toBe(900);
    expect(clampArtifactUrlTtl("3600")).toBe(3600);
  });

  // The point of the clamp: a caller asking for a week gets an hour. If this ever returns the
  // caller's number the whole expiry-based security story is gone, so it is asserted directly.
  it("clamps above the ceiling and below the floor", () => {
    expect(clampArtifactUrlTtl("604800")).toBe(3600);
    expect(clampArtifactUrlTtl("99999999")).toBe(3600);
    expect(clampArtifactUrlTtl("1")).toBe(60);
    expect(clampArtifactUrlTtl("0")).toBe(60);
    expect(clampArtifactUrlTtl("-5")).toBe(60);
  });
});

describe("cf#317 GET /api/artifact-url/<key>", () => {
  it("returns a presigned URL plus the object's REAL content-type and size", async () => {
    const { env, r2 } = makeEnv();
    seed(r2);
    const res = await worker.fetch(new Request(url(`/api/artifact-url/${FILM}`)), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.key).toBe(FILM);
    expect(body.content_type).toBe("video/mp4");
    expect(body.size).toBe(3811331);
    expect(body.expires_in).toBe(300);
    expect(String(body.url)).toContain("acct.r2.cloudflarestorage.com");
    expect(String(body.url)).toContain("X-Amz-Signature=");
  });

  // SCOPE: the signature must cover the one key asked for. A presign that signed a prefix, or the
  // wrong object, would still look like a working URL here -- so assert the key is IN the path and
  // that a DIFFERENT object's key is not.
  it("signs exactly the requested key and no other", async () => {
    const { env, r2 } = makeEnv();
    seed(r2);
    const res = await worker.fetch(new Request(url(`/api/artifact-url/${FILM}`)), env, ctx);
    const body = (await res.json()) as { url: string };
    const signed = new URL(body.url);
    expect(signed.pathname).toBe(`/vivijure/${FILM}`);
    expect(signed.pathname).not.toContain("portrait-1.png");
    // No wildcard/prefix form ever reaches the signature.
    expect(signed.pathname).not.toContain("*");
  });

  it("carries the clamped lifetime into the signature, not the caller's number", async () => {
    const { env, r2 } = makeEnv();
    seed(r2);
    const res = await worker.fetch(new Request(url(`/api/artifact-url/${FILM}?expires_in=604800`)), env, ctx);
    const body = (await res.json()) as { url: string; expires_in: number };
    expect(body.expires_in).toBe(3600);
    expect(new URL(body.url).searchParams.get("X-Amz-Expires")).toBe("3600");
  });

  it("serves an image artifact the same way (not film-only)", async () => {
    const { env, r2 } = makeEnv();
    seed(r2);
    const res = await worker.fetch(new Request(url("/api/artifact-url/cast/portrait-1.png")), env, ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.content_type).toBe("image/png");
    expect(body.size).toBe(2048);
  });

  // --- negative controls: each of these must FAIL, and each is a distinct refusal path -----------

  it("404s a key that does not exist in the bucket (no signed URL for a missing object)", async () => {
    const { env, r2 } = makeEnv();
    seed(r2);
    const res = await worker.fetch(new Request(url("/api/artifact-url/renders/nope/absent.mp4")), env, ctx);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("X-Amz-Signature");
  });

  it("404s a key outside the known artifact namespaces", async () => {
    const { env, r2 } = makeEnv();
    seed(r2);
    // Seeded so the ONLY thing that can refuse it is the prefix guard, not the existence check.
    r2.set("secrets/env.json", { size: 10, mime: "application/json" });
    const res = await worker.fetch(new Request(url("/api/artifact-url/secrets/env.json")), env, ctx);
    expect(res.status).toBe(404);
  });

  it("404s a traversal key", async () => {
    const { env, r2 } = makeEnv();
    seed(r2);
    const res = await worker.fetch(new Request(url("/api/artifact-url/renders/../secrets/env.json")), env, ctx);
    expect(res.status).toBe(404);
  });

  it("404s when the deployment binds no render bucket", async () => {
    const { env } = makeEnv();
    (env as unknown as { R2_RENDERS?: unknown }).R2_RENDERS = undefined;
    const res = await worker.fetch(new Request(url(`/api/artifact-url/${FILM}`)), env, ctx);
    expect(res.status).toBe(404);
  });

  // CONTROL ON THE CONTROLS: the refusals above must not be passing because the route is broken for
  // everything. A known-good key through the SAME harness has to come back 200 with a signature.
  it("positive control: the same harness does produce a signed URL for a valid key", async () => {
    const { env, r2 } = makeEnv();
    seed(r2);
    const res = await worker.fetch(new Request(url(`/api/artifact-url/${FILM}`)), env, ctx);
    expect(res.status).toBe(200);
    expect((await res.json() as { url: string }).url).toContain("X-Amz-Signature=");
  });
});
