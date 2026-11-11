import { describe, it, expect, vi, beforeEach } from "vitest";

// cf#1056: the spoken-line gate reads the shots being rendered, not the whole board. Before, both
// render doors derived lines from every scene in the bundle, so a render of only silent shots on a
// silent door was refused because a DIFFERENT shot in the board speaks.
//
// What must not change: a rendered shot that speaks is still refused on a silent door, and when the
// rendered ids cannot be matched to the bundle the gate keeps every line (the fc#2250 direction: never
// ship a voiced film silent on a guess). Every case asserts the status AND whether a film started.

const h = vi.hoisted(() => ({
  started: [] as Array<Record<string, unknown>>,
  bundleScenes: [] as Array<Record<string, unknown>>,
}));

vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_env: unknown, args: Record<string, unknown>) => {
      h.started.push(args);
      return { film_id: "film-1056", phase: "keyframe", scenes: args.scenes, project: "p", created_at: 0 };
    }),
    startFilmFromKeyframes: vi.fn(async (_env: unknown, args: Record<string, unknown>) => {
      h.started.push(args);
      return { film_id: "film-1056-kf", phase: "clips", scenes: args.scenes, project: "p", created_at: 0 };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/renders-db", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/renders-db")>();
  return { ...actual, insertRender: vi.fn(async () => true) };
});
vi.mock("../src/film-render-bridge", async (orig) => {
  const actual = await orig<typeof import("../src/film-render-bridge")>();
  return { ...actual, filmRowFromJob: vi.fn(() => ({ jobId: "film-1056", project: "p" })) };
});
vi.mock("@skyphusion-labs/vivijure-core/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/bundle-storyboard")>();
  return { ...actual, readBundleScenes: vi.fn(async () => h.bundleScenes) };
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

import worker from "../src/index";
import { bundleScenesForRender } from "../src/dialogue-derivation";
import { animateFromPreview } from "../src/finalize-from-keyframes";
import type { RenderRow } from "@skyphusion-labs/vivijure-core/renders-db";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";
import type { Env } from "../src/env";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const TALKS = { native_audio: true, voice: "prompt_lock", scatter_native_audio: true, min_seconds: 1, max_seconds: 10 };
function moduleBinding(name: string, hooks: string[], usage?: Record<string, unknown>) {
  return {
    fetch: async () => new Response(
      JSON.stringify({ name, version: "0.1.0", api: MODULE_API, hooks, ui: { order: 10, locality: "cloud" }, usage }),
      { status: 200, headers: { "content-type": "application/json" } },
    ),
  };
}
const stmt = { first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) };
const env = {
  ALLOW_UNAUTHENTICATED: "true",
  DB: { prepare: () => ({ bind: () => stmt, ...stmt }), batch: async () => [] },
  R2_RENDERS: { get: async () => null, put: async () => {}, head: async () => null },
  ASSETS: { fetch: async () => new Response("ASSET") },
  SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
  MODULE_KEYFRAME: moduleBinding("keyframe-sdxl", ["keyframe"]),
  // alibaba-wan shape: it states usage and cannot speak, so it is also the hosted silent default.
  MODULE_SILENT: moduleBinding("silent-look-door", ["motion.backend"], { native_audio: false, voice: "cast_tts", scatter_native_audio: true, min_seconds: 1, max_seconds: 10 }),
  MODULE_TALKER: moduleBinding("talking-door", ["motion.backend"], TALKS),
} as unknown as Env;

const post = (path: string, body: unknown) => new Request(`https://studio.example${path}`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});
const shot = (id: string) => ({ shot_id: id, prompt: `a ${id}`, seconds: 4 });
// shot_01 is silent; shot_02 and shot_03 speak.
const BOARD = [
  shot("shot_01"),
  { ...shot("shot_02"), dialogue: { slot: "A", text: "We move now." } },
  { ...shot("shot_03"), dialogue: { slot: "A", text: "Not yet." } },
];
const ALL = BOARD.map((s) => shot(s.shot_id));
const panel = (extra: Record<string, unknown>) =>
  worker.fetch(post("/api/storyboard/render", { bundleKey: "bundles/b.tar.gz", scenes: ALL, motion_backend: "silent-look-door", ...extra }), env, ctx);
const film = (extra: Record<string, unknown>) =>
  worker.fetch(post("/api/render/film", { bundle_key: "bundles/b.tar.gz", scenes: ALL, motion_backend: "silent-look-door", shardCount: 1, ...extra }), env, ctx);
const lines = () => (h.started[0]?.dialogue_lines ?? []) as Array<{ shot_id: string }>;

beforeEach(() => {
  _resetModuleDiscoveryCache();
  h.started = [];
  h.bundleScenes = BOARD;
});

describe("cf#1056 panel door: only the rendered shots decide the spoken-line gate", () => {
  it("a render of only the silent shot starts on a silent door", async () => {
    const res = await panel({ processShotIds: ["shot_01"] });
    expect(res.status).toBe(201);
    expect(h.started).toHaveLength(1);
    expect(lines()).toEqual([]);
  });
  it("a render that includes a spoken shot is still refused on a silent door", async () => {
    const res = await panel({ processShotIds: ["shot_01", "shot_02"] });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/spoken lines/);
    expect(h.started).toEqual([]);
  });
  it("the whole board is still refused on a silent door", async () => {
    expect((await panel({})).status).toBe(400);
    expect(h.started).toEqual([]);
  });
  it("a talking door gets only the rendered shots' lines", async () => {
    const res = await panel({ processShotIds: ["shot_01", "shot_02"], motion_backend: "talking-door" });
    expect(res.status).toBe(201);
    expect(lines().map((l) => l.shot_id)).toEqual(["shot_02"]);
  });
  it("a rendered id the bundle does not know keeps every line, so the gate still refuses", async () => {
    const res = await panel({ scenes: [shot("shot_01"), shot("renamed")] });
    expect(res.status).toBe(400);
    expect(h.started).toEqual([]);
  });
});

describe("cf#1056 film door: the same rule", () => {
  it("a film of only the silent shot starts on a silent door", async () => {
    const res = await film({ scenes: [shot("shot_01")] });
    expect(res.status).toBe(201);
    expect(lines()).toEqual([]);
  });
  it("a film that includes a spoken shot is still refused on a silent door", async () => {
    expect((await film({ scenes: [shot("shot_01"), shot("shot_03")] })).status).toBe(400);
    expect(h.started).toEqual([]);
  });
  it("explicit dialogue_lines are unchanged: they always win, and a spoken one is refused", async () => {
    const res = await film({ scenes: [shot("shot_01")], dialogue_lines: [{ shot_id: "shot_02", text: "Hi." }] });
    expect(res.status).toBe(400);
    expect(h.started).toEqual([]);
  });
});

describe("cf#1056 finalize from keyframes: the picked keyframes decide", () => {
  const parent = (locked: string[] | null) => ({
    id: 1, public_id: "r_1", job_id: "film-preview", project: "p", bundle_key: "bundles/b.tar.gz", quality_tier: "final",
    render_overrides: null, status: "COMPLETED", output_key: null, output_ms: null, finish_elapsed_ms: null,
    motion_backend: null, keyframe_backend: null, output: null, error: null, execution_time_ms: null, delay_time_ms: null,
    submitted_at: 1, updated_at: 1, completed_at: 2, label: null, mode: "keyframes-only",
    keyframes: BOARD.map((s, i) => ({ shot_id: s.shot_id, key: `k/${i}.png` })), locked_shots: locked,
    project_id: null, folder_path: null, tags: [], parent_id: null, project_public_id: null, parent_public_id: null,
  }) as unknown as RenderRow;
  const go = (locked: string[] | null) =>
    animateFromPreview(env as never, { parent: parent(locked), deriveMode: "finalized", motionBackend: "silent-look-door" });

  it("finalizing only the silent shot starts on a silent door", async () => {
    const r = await go(["shot_01"]);
    expect(r.ok).toBe(true);
    expect(lines()).toEqual([]);
  });
  it("with no door named, only the picked shots decide whether a talking door is needed", async () => {
    const silentOnly = await animateFromPreview(env as never, { parent: parent(["shot_01"]), deriveMode: "finalized" });
    const spoken = await animateFromPreview(env as never, { parent: parent(["shot_02"]), deriveMode: "finalized" });
    // The picked door is what each run started on, or the refusal it got. They must differ: a silent
    // pick must not be judged by a shot it is not making.
    const doorOf = (r: unknown, i: number) => ((r as { ok: boolean }).ok ? String(h.started[i]?.motion_backend) : JSON.stringify(r));
    const a = doorOf(silentOnly, 0);
    const b = doorOf(spoken, silentOnly.ok ? 1 : 0);
    expect(silentOnly.ok, a).toBe(true);
    expect(a).not.toBe(b);
  });
  it("finalizing a spoken shot is still refused on a silent door", async () => {
    const r = await go(["shot_01", "shot_02"]);
    expect(r).toMatchObject({ ok: false, status: 400 });
    expect(h.started).toEqual([]);
  });
});

describe("bundleScenesForRender", () => {
  const B = [{ shot_id: "a" }, { shot_id: "b" }];
  it("keeps the rendered shots", () => expect(bundleScenesForRender(B, ["b"])).toEqual([{ shot_id: "b" }]));
  it("keeps every shot when a rendered id is unknown", () => expect(bundleScenesForRender(B, ["b", "x"])).toEqual(B));
  it("keeps every shot when nothing is rendered", () => expect(bundleScenesForRender(B, [])).toEqual(B));
});
