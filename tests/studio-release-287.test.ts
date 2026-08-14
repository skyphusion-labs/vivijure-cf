// cf#287: GET /api/modules must carry a studio release / build identity so two tag deploys are
// never byte-identical in the registry projection. Module manifest versions are hand-maintained
// and do not move when a module gains telemetry or a fix; the release field is the one signal that
// does.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../src/index";
import type { Env } from "../src/env";
import {
  PACKAGE_VERSION,
  resolveStudioRelease,
} from "../src/studio-release";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const req = (path: string) => new Request(`https://studio.example${path}`, { method: "GET" });

function envWith(over: Record<string, unknown> = {}): Env {
  return {
    ALLOW_UNAUTHENTICATED: "true",
    ASSETS: { fetch: async () => new Response("ASSET") },
    ...over,
  } as unknown as Env;
}

describe("resolveStudioRelease (cf#287)", () => {
  it("falls back to PACKAGE_VERSION when STUDIO_RELEASE is unset", () => {
    expect(resolveStudioRelease({})).toEqual({ studio_release: PACKAGE_VERSION });
  });

  it("prefers env.STUDIO_RELEASE over the baked package version", () => {
    expect(resolveStudioRelease({ STUDIO_RELEASE: "v1.12.0" })).toEqual({
      studio_release: "v1.12.0",
    });
  });

  it("trims whitespace and treats blank STUDIO_RELEASE as unset", () => {
    expect(resolveStudioRelease({ STUDIO_RELEASE: "  " })).toEqual({
      studio_release: PACKAGE_VERSION,
    });
    expect(resolveStudioRelease({ STUDIO_RELEASE: "  v1.13.0  " })).toEqual({
      studio_release: "v1.13.0",
    });
  });

  it("includes git_sha only when set", () => {
    expect(resolveStudioRelease({ STUDIO_RELEASE: "v1.20.1", STUDIO_GIT_SHA: "abc1234" })).toEqual({
      studio_release: "v1.20.1",
      git_sha: "abc1234",
    });
    expect(resolveStudioRelease({ STUDIO_GIT_SHA: "   " })).toEqual({
      studio_release: PACKAGE_VERSION,
    });
  });

  it("PACKAGE_VERSION stays pinned to package.json version", () => {
    // The constant is the only fallback a self-host sees; if it drifts from package.json the
    // projection lies about which tag is live. Same discipline as vivijure-mcp SERVER_INFO.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string;
    };
    expect(PACKAGE_VERSION).toBe(pkg.version);
  });
});

describe("GET /api/modules studio_release (cf#287)", () => {
  it("always projects studio_release (package fallback when env unset)", async () => {
    const res = await worker.fetch(req("/api/modules"), envWith(), ctx);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { studio_release?: string; git_sha?: string; modules?: unknown[] };
    expect(body.studio_release).toBe(PACKAGE_VERSION);
    expect(body.git_sha).toBeUndefined();
    expect(Array.isArray(body.modules)).toBe(true);
  });

  it("projects env.STUDIO_RELEASE when bound", async () => {
    const res = await worker.fetch(
      req("/api/modules"),
      envWith({ STUDIO_RELEASE: "v1.12.0" }),
      ctx,
    );
    const body = (await res.json()) as { studio_release?: string };
    expect(body.studio_release).toBe("v1.12.0");
  });

  it("projects git_sha when STUDIO_GIT_SHA is bound", async () => {
    const res = await worker.fetch(
      req("/api/modules"),
      envWith({ STUDIO_RELEASE: "v1.20.1", STUDIO_GIT_SHA: "deadbeef" }),
      ctx,
    );
    const body = (await res.json()) as { studio_release?: string; git_sha?: string };
    expect(body.studio_release).toBe("v1.20.1");
    expect(body.git_sha).toBe("deadbeef");
  });

  it("two different STUDIO_RELEASE values produce distinguishable projections", async () => {
    // The near-miss that filed this issue: v1.12.0 vs v1.13.0 module manifests were identical.
    const a = (await (
      await worker.fetch(req("/api/modules"), envWith({ STUDIO_RELEASE: "v1.12.0" }), ctx)
    ).json()) as { studio_release: string };
    const b = (await (
      await worker.fetch(req("/api/modules"), envWith({ STUDIO_RELEASE: "v1.13.0" }), ctx)
    ).json()) as { studio_release: string };
    expect(a.studio_release).not.toBe(b.studio_release);
  });
});
