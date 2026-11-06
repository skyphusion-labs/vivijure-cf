import { describe, it, expect, vi, beforeEach } from "vitest";

// vivijure-cf#1168, then vivijure-core#442. A per-shot door map that mixes a door driven by a line's audio
// with a silent door used to be refused with a 400 (cf#1289), because core lost the map after pre-clip
// dialogue or sent the driven shot no audio. Core 1.33.0 keeps the map and decides each shot's audio from
// its own door, so every shape here now STARTS, with its map intact. Each case asserts the result AND what
// the film was started with. The spoken-clip prep now runs per door (prepareSpokenClipsPerDoor).

const h = vi.hoisted(() => ({
  started: [] as Array<Record<string, unknown>>,
  lines: {} as Record<string, string>,
}));

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

import { animateFromPreview, prepareSpokenClipsPerDoor } from "../src/finalize-from-keyframes";
import type { RenderRow } from "@skyphusion-labs/vivijure-core/renders-db";
import type { RegisteredModule } from "@skyphusion-labs/vivijure-core";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";

function shot(id: string) {
  const text = h.lines[id];
  return { shot_id: id, prompt: `a ${id}`, seconds: 4, ...(text ? { dialogue: { text } } : {}) };
}
const SILENT = { native_audio: false, driving_audio: false, voice: "cast_tts", scatter_native_audio: true, min_seconds: 1, max_seconds: 10 };
const DRIVEN = { native_audio: false, driving_audio: true, voice: "cast_tts", scatter_native_audio: true, min_seconds: 1, max_seconds: 10 };
const AUDIO_SWITCH = { generate_audio: { type: "bool", default: true } };
function door(name: string, locality: string, usage: Record<string, unknown>, config_schema: Record<string, unknown> = {}) {
  return {
    fetch: async () => new Response(
      JSON.stringify({ name, version: "0.1.0", api: MODULE_API, hooks: ["motion.backend"], ui: { order: 10, locality }, usage, config_schema }),
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
  MODULE_TALKER: door("talker", "cloud", DRIVEN, AUDIO_SWITCH),
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
  h.lines = {};
});

describe("vivijure-cf#1168 lifted by core#442: animate-cloud", () => {
  it("CONTROL: one audio-driven door for every shot starts", async () => {
    const r = await cloud("talker");
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.started).toHaveLength(1);
  });
  it("CONTROL: a map of silent doors starts", async () => {
    const r = await cloud("silent-a", { shot_02: "silent-b" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.started[0]?.per_shot_motion).toEqual({ shot_01: "silent-a", shot_02: "silent-b" });
  });
  it("a silent default with one shot on an audio-driven door starts, map intact", async () => {
    const r = await cloud("silent-a", { shot_02: "talker" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.started).toHaveLength(1);
    expect(h.started[0]).toMatchObject({ motion_backend: "silent-a", per_shot_motion: { shot_01: "silent-a", shot_02: "talker" } });
  });
  it("an audio-driven default with one shot on another door starts, map intact", async () => {
    const r = await cloud("talker", { shot_02: "silent-a" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.started[0]).toMatchObject({ motion_backend: "talker", per_shot_motion: { shot_01: "talker", shot_02: "silent-a" } });
  });
  it("a spoken shot on the audio-driven door gets that door native audio off, as its own config", async () => {
    h.lines = { shot_02: "Say it." };
    const r = await cloud("silent-a", { shot_02: "talker" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.started[0]?.motion_configs).toEqual({ talker: { generate_audio: false } });
    expect(h.started[0]?.dialogue_lines).toEqual([expect.objectContaining({ shot_id: "shot_02", text: "Say it." })]);
  });
  it("CONTROL: a spoken shot only on the silent door leaves every door config alone", async () => {
    h.lines = { shot_01: "Say it." };
    const r = await cloud("silent-a", { shot_02: "talker" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.started[0]?.motion_configs).toBeUndefined();
  });
});

describe("vivijure-cf#1168 lifted by core#442: animate-hybrid", () => {
  it("CONTROL: every shot on the silent gpu door starts", async () => {
    const r = await hybrid({});
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
  it("a gpu default with one shot on an audio-driven cloud door starts, map intact", async () => {
    const r = await hybrid({ shot_02: { backend: "cloud", model: "talker" } }, "silent-a");
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(h.started[0]?.per_shot_motion).toEqual({ shot_01: "gpu-door", shot_02: "talker" });
  });
});

describe("prepareSpokenClipsPerDoor", () => {
  const mods = [
    { name: "s", usage: SILENT, config_schema: {} },
    { name: "t", usage: DRIVEN, config_schema: AUDIO_SWITCH },
    { name: "t2", usage: DRIVEN, config_schema: {} },
  ] as unknown as RegisteredModule[];
  const refs = { a: "r/a.wav", b: "r/b.wav" };
  it("turns native audio off and drops voice samples only for a driven door holding a spoken shot", () => {
    const r = prepareSpokenClipsPerDoor(mods, { a: "s", b: "t" }, { x: 1 }, refs, [{ shot_id: "b", text: "hi" }] as never);
    expect(r).toEqual({ ok: true, motionConfigs: { t: { x: 1, generate_audio: false } }, voiceRefs: { a: "r/a.wav" } });
  });
  it("leaves a driven door with no spoken shot, and a silent door with one, untouched", () => {
    const r = prepareSpokenClipsPerDoor(mods, { a: "s", b: "t" }, { x: 1 }, refs, [{ shot_id: "a", text: "hi" }] as never);
    expect(r).toEqual({ ok: true, motionConfigs: undefined, voiceRefs: refs });
  });
  it("a blank line is not a spoken shot", () => {
    const r = prepareSpokenClipsPerDoor(mods, { a: "s", b: "t" }, {}, refs, [{ shot_id: "b", text: "   " }] as never);
    expect(r).toEqual({ ok: true, motionConfigs: undefined, voiceRefs: refs });
  });
  it("a driven door with no audio switch keeps its config and still drops its voice samples", () => {
    const r = prepareSpokenClipsPerDoor(mods, { a: "t2", b: "s" }, { x: 1 }, refs, [{ shot_id: "a", text: "hi" }] as never);
    expect(r).toEqual({ ok: true, motionConfigs: { t2: { x: 1 } }, voiceRefs: { b: "r/b.wav" } });
  });
  it("every voice sample dropped reads as none, as on the single-door path", () => {
    const r = prepareSpokenClipsPerDoor(mods, { a: "t", b: "t" }, {}, refs, [{ shot_id: "a", text: "hi" }] as never);
    expect(r).toMatchObject({ ok: true, voiceRefs: undefined });
  });
  it("does not mutate its inputs", () => {
    const refsIn = { ...refs };
    prepareSpokenClipsPerDoor(mods, { a: "t", b: "t" }, {}, refsIn, [{ shot_id: "a", text: "hi" }] as never);
    expect(refsIn).toEqual(refs);
  });
});
