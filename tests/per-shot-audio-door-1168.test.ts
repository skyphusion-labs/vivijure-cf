import { describe, it, expect, vi, beforeEach } from "vitest";

// vivijure-cf#1168: a per-shot door map is lost, or its audio-driven door gets no audio, when any door in
// it is driven by a line's audio. Until core keeps the map and decides pre-clip dialogue per shot, the
// studio refuses that combination with a 400 before anything is spent. Every case asserts the status AND
// whether a film started.

const h = vi.hoisted(() => ({ started: [] as Array<Record<string, unknown>> }));

vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmFromKeyframes: vi.fn(async (_env: unknown, args: Record<string, unknown>) => {
      h.started.push(args);
      return { film_id: "film-1168", phase: "clips", scenes: args.scenes, project: "p", created_at: 0 };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/renders-db", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/renders-db")>();
  return { ...actual, insertRender: vi.fn(async () => true) };
});
vi.mock("@skyphusion-labs/vivijure-core/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => [shot("shot_01"), shot("shot_02")]) };
});
vi.mock("@skyphusion-labs/vivijure-core/cast-loras", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/cast-loras")>();
  return {
    ...actual,
    resolveCastLoras: vi.fn(async () => ({
      pretrained: {}, wanPretrained: {}, castIds: {}, voices: {}, voiceRefs: {},
      speakerNames: {}, skipped: [] as string[], skippedDetail: [] as unknown[],
    })),
  };
});

import { animateFromPreview, perShotAudioDoorRefusal } from "../src/finalize-from-keyframes";
import type { RenderRow } from "@skyphusion-labs/vivijure-core/renders-db";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";

function shot(id: string) {
  return { shot_id: id, prompt: `a ${id}`, seconds: 4 };
}
const SILENT = { native_audio: false, driving_audio: false, voice: "cast_tts", scatter_native_audio: true, min_seconds: 1, max_seconds: 10 };
const DRIVEN = { native_audio: false, driving_audio: true, voice: "cast_tts", scatter_native_audio: true, min_seconds: 1, max_seconds: 10 };
function door(name: string, locality: string, usage: Record<string, unknown>) {
  return {
    fetch: async () => new Response(
      JSON.stringify({ name, version: "0.1.0", api: MODULE_API, hooks: ["motion.backend"], ui: { order: 10, locality }, usage }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  };
}
const stmt = { first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
const env = {
  DB: { prepare: () => ({ bind: () => stmt, ...stmt }), batch: async () => [] },
  R2_RENDERS: { get: async () => null, put: async () => {}, head: async () => null },
  MODULE_SILENT_A: door("silent-a", "cloud", SILENT),
  MODULE_SILENT_B: door("silent-b", "cloud", SILENT),
  MODULE_TALKER: door("talker", "cloud", DRIVEN),
  MODULE_GPU: door("gpu-door", "byo", SILENT),
};

const parent = {
  id: 1, public_id: "r_1", job_id: "film-preview", project: "p", bundle_key: "bundles/b.tar.gz", quality_tier: "final",
  render_overrides: null, status: "COMPLETED", output_key: null, output_ms: null, finish_elapsed_ms: null,
  motion_backend: null, keyframe_backend: null, output: null, error: null, execution_time_ms: null, delay_time_ms: null,
  submitted_at: 1, updated_at: 1, completed_at: 2, label: null, mode: "keyframes-only",
  keyframes: [{ shot_id: "shot_01", key: "k/0.png" }, { shot_id: "shot_02", key: "k/1.png" }], locked_shots: null,
  project_id: null, folder_path: null, tags: [], parent_id: null, project_public_id: null, parent_public_id: null,
} as unknown as RenderRow;

const cloud = (motionBackend: string, perShotModels?: Record<string, string>) =>
  animateFromPreview(env as never, { parent, deriveMode: "cloud-finalized", motionBackend, perShotModels });
const hybrid = (hybridBackends: Record<string, { backend: "gpu" | "cloud"; model?: string }>, defaultCloudModel?: string) =>
  animateFromPreview(env as never, { parent, deriveMode: "cloud-finalized", hybridBackends, defaultBackend: "gpu", defaultCloudModel });

beforeEach(() => {
  _resetModuleDiscoveryCache();
  h.started = [];
});

describe("vivijure-cf#1168: animate-cloud", () => {
  it("CONTROL: one audio-driven door for every shot still starts", async () => {
    const r = await cloud("talker");
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.started).toHaveLength(1);
  });
  it("CONTROL: a map of silent doors still starts", async () => {
    const r = await cloud("silent-a", { shot_02: "silent-b" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.started[0]?.per_shot_motion).toEqual({ shot_01: "silent-a", shot_02: "silent-b" });
  });
  it("a silent default with one shot on an audio-driven door is refused", async () => {
    const r = await cloud("silent-a", { shot_02: "talker" });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { error: string }).error).toMatch(/driven by a line's audio.*"talker"/);
    expect(h.started).toEqual([]);
  });
  it("an audio-driven default with one shot on another door is refused", async () => {
    const r = await cloud("talker", { shot_02: "silent-a" });
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { error: string }).error).toMatch(/driven by a line's audio.*"talker"/);
    expect(h.started).toEqual([]);
  });
});

describe("vivijure-cf#1168: animate-hybrid", () => {
  it("CONTROL: every shot on the silent gpu door still starts", async () => {
    const r = await hybrid({});
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
  it("a gpu default with one shot on an audio-driven cloud door is refused", async () => {
    const r = await hybrid({ shot_02: { backend: "cloud", model: "talker" } }, "silent-a");
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect((r as { error: string }).error).toMatch(/driven by a line's audio.*"talker"/);
    expect(h.started).toEqual([]);
  });
});

describe("perShotAudioDoorRefusal", () => {
  const mods = [{ name: "s", usage: SILENT }, { name: "t", usage: DRIVEN }];
  it("allows one door for every shot, even an audio-driven one", () => {
    expect(perShotAudioDoorRefusal(mods, "t", { a: "t", b: "t" })).toBeNull();
  });
  it("refuses an audio-driven door the default does not name", () => {
    expect(perShotAudioDoorRefusal(mods, undefined, { a: "t", b: "t" })).toMatch(/"t"/);
  });
  it("refuses every shot on an audio-driven door the default is not (core reads the default)", () => {
    expect(perShotAudioDoorRefusal(mods, "s", { a: "t", b: "t" })).toMatch(/"t"/);
  });
  it("refuses an audio-driven default whose shots all go to another door (the map is lost)", () => {
    expect(perShotAudioDoorRefusal(mods, "t", { a: "s", b: "s" })).toMatch(/"t"/);
  });
  it("allows a map with no audio-driven door", () => {
    expect(perShotAudioDoorRefusal(mods, "s", { a: "s", b: "x" })).toBeNull();
  });
});
