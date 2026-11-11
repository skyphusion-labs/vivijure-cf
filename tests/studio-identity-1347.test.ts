// cf#1347: GET /api/modules says which vivijure-core and which build serve this studio. Before this a render
// proof could not name its core from its own evidence: on 2026-11-06 the route returned studio_release
// 1.43.0 (the vivijure-cf package version, which does not move when only the core pin moves) and no
// git_sha. core_version is read from the INSTALLED core's package.json by the bundler at build time;
// git_sha is whatever the deploy stamps in STUDIO_GIT_SHA, or null. The route is unauthenticated, so a
// value that is not shaped like a sha is reported as null and never echoed.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../src/index";
import type { Env } from "../src/env";
import { CORE_VERSION, resolveStudioRelease } from "../src/studio-release";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const envWith = (over: Record<string, unknown> = {}) =>
  ({ ALLOW_UNAUTHENTICATED: "true", ASSETS: { fetch: async () => new Response("ASSET") }, ...over }) as unknown as Env;
const modules = async (over: Record<string, unknown> = {}) =>
  (await (await worker.fetch(new Request("https://studio.example/api/modules"), envWith(over), ctx)).json()) as Record<string, unknown>;

// Read the installed package from disk, independently of the import the code under test uses.
const installed = JSON.parse(
  readFileSync(join(process.cwd(), "node_modules", "@skyphusion-labs", "vivijure-core", "package.json"), "utf8"),
) as { version: string };

describe("core_version (cf#1347)", () => {
  it("is the installed vivijure-core version", () => {
    expect(CORE_VERSION).toBe(installed.version);
    expect(CORE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("GET /api/modules projects it, always", async () => {
    const body = await modules();
    expect(body.core_version).toBe(installed.version);
  });

  it("is distinct from studio_release, which is this repo's own version", async () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      version: string; dependencies: Record<string, string>;
    };
    const body = await modules();
    expect(body.studio_release).toBe(pkg.version);
    // The pin admits the installed version: the field reports what is installed, not the range.
    expect(pkg.dependencies["@skyphusion-labs/vivijure-core"]).toMatch(/^\^?\d+\.\d+\.\d+$/);
  });
});

describe("git_sha (cf#1347)", () => {
  it("is null, and present, when the deploy stamps no sha", async () => {
    const body = await modules();
    expect("git_sha" in body).toBe(true);
    expect(body.git_sha).toBeNull();
  });

  it("is the stamped sha, short or full, exactly as stamped", async () => {
    expect((await modules({ STUDIO_GIT_SHA: "194c7ac" })).git_sha).toBe("194c7ac");
    const full = "194c7ac3d1e0f2a4b5c6d7e8f9a0b1c2d3e4f5a6";
    expect((await modules({ STUDIO_GIT_SHA: full })).git_sha).toBe(full);
    expect((await modules({ STUDIO_GIT_SHA: "  194c7ac  " })).git_sha).toBe("194c7ac");
  });

  it("a value that is not a sha is null, never echoed on this unauthenticated route", async () => {
    for (const bad of ["ghp_notasha0000000000000000000000000000", "main", "v1.43.0", "abc12", "x".repeat(41), "194c7ac;rm"]) {
      const body = await modules({ STUDIO_GIT_SHA: bad });
      expect(body.git_sha, bad).toBeNull();
    }
    // The secret-shaped one appears nowhere in the response.
    const secret = "ghp_notasha0000000000000000000000000000";
    expect(JSON.stringify(await modules({ STUDIO_GIT_SHA: secret }))).not.toContain(secret);
    expect(resolveStudioRelease({ STUDIO_GIT_SHA: "ghp_notasha" }).git_sha).toBeNull();
  });
});
