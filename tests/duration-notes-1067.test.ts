import { describe, it, expect, vi, beforeEach } from "vitest";

// cf#1067 part 1: submit does not run preflight, so a door that clamps a shot did it with no word to
// an API caller. Both render doors now say so in the 201, and still start the render (no new refusal).

const h = vi.hoisted(() => ({ started: [] as Array<Record<string, unknown>> }));
vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_env: unknown, args: Record<string, unknown>) => {
      h.started.push(args);
      return { film_id: "film-1067", phase: "keyframe", scenes: args.scenes, project: "p", created_at: 0 };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/renders-db", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/renders-db")>();
  return { ...actual, insertRender: vi.fn(async () => true) };
});
vi.mock("../src/film-render-bridge", async (orig) => {
  const actual = await orig<typeof import("../src/film-render-bridge")>();
  return { ...actual, filmRowFromJob: vi.fn(() => ({ jobId: "film-1067", project: "p" })) };
});
vi.mock("@skyphusion-labs/vivijure-core/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => []) };
});

import worker from "../src/index";
import { durationNotesForShots } from "../src/door-duration-preflight";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";
import type { Env } from "../src/env";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const USAGE = { native_audio: false, voice: "cast_tts", scatter_native_audio: true, min_seconds: 4, max_seconds: 8 };
const binding = (name: string, hooks: string[], usage?: unknown) => ({
  fetch: async () => new Response(JSON.stringify({ name, version: "0.1.0", api: MODULE_API, hooks, ui: { order: 1, locality: "cloud" }, usage }),
    { status: 200, headers: { "content-type": "application/json" } }),
});
const stmt = { first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
const env = {
  ALLOW_UNAUTHENTICATED: "true",
  DB: { prepare: () => ({ bind: () => stmt, ...stmt }), batch: async () => [] },
  R2_RENDERS: { get: async () => null, put: async () => {}, head: async () => null },
  SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
  MODULE_KEYFRAME: binding("keyframe-sdxl", ["keyframe"]),
  MODULE_EIGHT: binding("eight-second-door", ["motion.backend"], USAGE),
} as unknown as Env;
const post = (path: string, body: unknown) => new Request(`https://studio.example${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const shots = (...secs: number[]) => secs.map((s, i) => ({ shot_id: `shot_0${i + 1}`, prompt: "p", seconds: s }));
type Note = { shot_id: string; planned_seconds: number; level: string; message: string };

beforeEach(() => { _resetModuleDiscoveryCache(); h.started = []; });

describe("cf#1067: the render doors say when a shot will not be its planned length", () => {
  it("agent door: a 20 second shot on an 8 second door still starts, and the answer says it will be cut", async () => {
    const res = await worker.fetch(post("/api/render/film", { bundle_key: "bundles/b.tar.gz", scenes: shots(6, 20), motion_backend: "eight-second-door", shardCount: 1 }), env, ctx);
    expect(res.status).toBe(201);
    expect(h.started).toHaveLength(1);
    const notes = ((await res.json()) as { duration_notes?: Note[] }).duration_notes;
    expect(notes).toHaveLength(1);
    expect(notes![0]).toMatchObject({ shot_id: "shot_02", planned_seconds: 20, level: "error" });
    expect(notes![0].message).toMatch(/at most 8s/);
    expect(notes![0].message).toMatch(/cut to fit/);
  });
  it("panel door: the same, and a short shot is a warning", async () => {
    const res = await worker.fetch(post("/api/storyboard/render", { bundleKey: "bundles/b.tar.gz", scenes: shots(2, 6, 20), motion_backend: "eight-second-door" }), env, ctx);
    expect(res.status).toBe(201);
    const notes = ((await res.json()) as { duration_notes?: Note[] }).duration_notes!;
    expect(notes.map((n) => [n.shot_id, n.level])).toEqual([["shot_01", "warning"], ["shot_03", "error"]]);
  });
  it("shots the door makes as planned add no field", async () => {
    const res = await worker.fetch(post("/api/render/film", { bundle_key: "bundles/b.tar.gz", scenes: shots(4, 8), motion_backend: "eight-second-door", shardCount: 1 }), env, ctx);
    expect(res.status).toBe(201);
    expect("duration_notes" in ((await res.json()) as object)).toBe(false);
  });
});

describe("durationNotesForShots", () => {
  it("no door, no notes", () => expect(durationNotesForShots(shots(99), undefined)).toEqual([]));
});
