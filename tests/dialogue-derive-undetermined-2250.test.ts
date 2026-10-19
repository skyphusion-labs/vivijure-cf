import { describe, it, expect, vi, beforeEach } from "vitest";

// fc#2250 item 7 -- A DIALOGUE DERIVATION FAILURE SHIPPED A SILENT FILM WITH 201.
//
// cf#334 added dialogue derivation to the panel render door so a voiced storyboard could not ship
// silent. The derivation was wrapped in `catch { /* best-effort */ }`. That catch is the defect:
//
//   readBundleScenes throws  ->  panelDialogue stays undefined
//                            ->  spokenLinesPresent(undefined) === false
//                            ->  the talking-door 400 never fires
//                            ->  startFilmJob runs, the operator is billed,
//                                and a voiced storyboard comes back SILENT with 201.
//
// This reintroduced exactly what cf#334 fixed, and nothing could report it, because a swallowed
// exception and a genuinely silent storyboard produce the IDENTICAL state: `dialogue` undefined.
//
// THE DISTINCTION THE FIX TURNS ON, and it is a property of core rather than a convention:
// `readBundleScenes` returns `[]` when the bundle object is missing or carries no storyboard.yaml,
// and THROWS only on a real failure (an R2 error, a corrupt gzip, unparseable YAML). So:
//
//   []     -> the storyboard genuinely has nothing to voice. Render silent. Correct, unchanged.
//   throw  -> whether this storyboard has spoken lines is UNDETERMINED. Refusing costs a retry;
//             proceeding spends money on a film that may be silently wrong.
//
// 503 mirrors the storage ceiling, which already answers "cannot be checked" that way rather than
// inventing a 400 for a condition the caller did not cause.
//
// THIS FILE ASSERTS THE OUTCOME, NOT THE LOG. A test that only asserted the catch logged would have
// passed against the defect, because the defect is not a missing log line: it is a 201 on a silent
// film. Every case below asserts the STATUS and whether startFilmJob was reached, since "was the
// operator billed" is the fact that matters.

const h = vi.hoisted(() => ({
  started: [] as Array<Record<string, unknown>>,
  bundleScenes: [] as Array<Record<string, unknown>>,
  bundleThrows: null as string | null,
  voices: {} as Record<string, string>,
  // Slot -> SDXL adapter key. The keyframe leg requires one per BOUND slot, so a case that
  // passes castLoras must supply this too or the door refuses with missingSdxl before dialogue.
  pretrained: {} as Record<string, string>,
}));

vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_env: unknown, args: Record<string, unknown>) => {
      h.started.push(args);
      return { film_id: "film-2250", phase: "keyframe", scenes: args.scenes, project: "p", created_at: 0 };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/renders-db", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/renders-db")>();
  return { ...actual, insertRender: vi.fn(async () => true) };
});
vi.mock("../src/film-render-bridge", async (orig) => {
  const actual = await orig<typeof import("../src/film-render-bridge")>();
  return { ...actual, filmRowFromJob: vi.fn(() => ({ jobId: "film-2250", project: "p" })) };
});
vi.mock("@skyphusion-labs/vivijure-core/bundle-storyboard", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/bundle-storyboard")>();
  return {
    ...actual,
    readBundleScenes: vi.fn(async () => {
      // The instrument for the whole file: core throws here on an R2 error, a corrupt gzip or
      // unparseable YAML, and returns [] for "no bundle / no storyboard.yaml".
      if (h.bundleThrows) throw new Error(h.bundleThrows);
      return h.bundleScenes;
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/cast-loras", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/cast-loras")>();
  return {
    ...actual,
    // The FULL ResolvedCastLoras shape. The preflight reads cast.skipped.length before anything
    // else, so a partial stub surfaces as a bare 500 rather than as a bad mock.
    resolveCastLoras: vi.fn(async () => ({
      pretrained: h.pretrained, wanPretrained: {}, castIds: {}, voices: h.voices, voiceRefs: {},
      speakerNames: {}, skipped: [] as string[], skippedDetail: [] as unknown[],
    })),
  };
});

import worker from "../src/index";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";
import type { Env } from "../src/env";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

// A COMPLETE MotionUsageDecl. core requires native_audio, voice, scatter_native_audio, min_seconds
// and max_seconds; a PARTIAL usage bag fails validateManifest and the module is dropped from
// discovery entirely, which reads downstream as "not an installed, serving module" rather than as a
// manifest error. Stated here because the first draft of this file hit exactly that.
const TALKS = {
  native_audio: true, voice: "prompt_lock", scatter_native_audio: true,
  min_seconds: 1, max_seconds: 10,
};

function moduleBinding(
  name: string, hooks: string[], locality: string, usage?: Record<string, unknown>,
) {
  return {
    fetch: async () =>
      new Response(
        JSON.stringify({ name, version: "0.1.0", api: MODULE_API, hooks, ui: { order: 10, locality }, usage }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  };
}

// Permissive D1 stub. hSubmitRender does post-start bookkeeping (/api/render/film does not):
// resolveProjectRef, persistWanLoraProjectionOnFilm and insertRenderBestEffort are all D1, and an
// unbound DB surfaced as a bare 500 that masked every assertion in this file.
const DB = {
  prepare: () => ({
    bind: () => ({
      first: async () => null,
      all: async () => ({ results: [] }),
      run: async () => ({ success: true }),
    }),
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({ success: true }),
  }),
  batch: async () => [],
};

const env = {
  ALLOW_UNAUTHENTICATED: "true",
  DB,
  ASSETS: { fetch: async () => new Response("ASSET") },
  SPEND_RATE_LIMITER: { limit: async () => ({ success: true }) },
  MODULE_KEYFRAME: moduleBinding("keyframe-sdxl", ["keyframe"], "cloud"),
  // A SILENT look door: no usage.native_audio / driving_audio, so doorCanSpeakLines is false.
  MODULE_SILENT: moduleBinding("silent-look-door", ["motion.backend"], "cloud"),
  // A TALKING door, so the voiced-storyboard cases have somewhere legitimate to go.
  MODULE_TALKER: moduleBinding("talking-door", ["motion.backend"], "cloud", TALKS),
} as unknown as Env;

function post(path: string, body: unknown): Request {
  return new Request(`https://studio.example${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SCENES = [{ shot_id: "shot_01", prompt: "a shot", seconds: 4 }];
const VOICED_BUNDLE = [
  { shot_id: "shot_01", prompt: "a shot", seconds: 4, dialogue: { slot: "A", text: "We move now." } },
];

function body(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { bundleKey: "bundles/good.tar.gz", scenes: SCENES, motion_backend: "silent-look-door", ...extra };
}

beforeEach(() => {
  // core#216: the MODULE_* service scan is cached for 30s keyed on the BINDING NAME SET, and a
  // vitest isolate evaluates many envs. Without this reset a sibling file's scan answers here.
  _resetModuleDiscoveryCache();
  h.started = [];
  h.bundleScenes = [];
  h.bundleThrows = null;
  h.voices = {};
  h.pretrained = {};
});

describe("fc#2250 item 7 -- POST /api/storyboard/render, dialogue derivation failure", () => {
  it("THE DEFECT: a derivation failure must NOT return 201, and must NOT bill a film", async () => {
    // The red row. Before the fix this returned 201 with dialogue_lines undefined: a silent film
    // reported as a success. The storyboard here is voiced and the door cannot speak, so the ONLY
    // reason this could ever have reached startFilmJob is the swallowed exception.
    h.bundleThrows = "R2 GET failed: connection reset";
    h.bundleScenes = VOICED_BUNDLE;
    const res = await worker.fetch(post("/api/storyboard/render", body()), env, ctx);
    expect(res.status, "a render whose dialogue state is undetermined must not report success").not.toBe(201);
    expect(res.status).toBe(503);
    const parsed = (await res.json()) as { error?: string };
    // The diagnostic has to say WHAT could not be established AND carry the underlying cause, or an
    // operator reads a bare refusal as a transient blip and retries forever against a corrupt bundle.
    expect(parsed.error ?? "").toMatch(/spoken lines/i);
    expect(parsed.error ?? "").toMatch(/silent/i);
    expect(parsed.error ?? "").toContain("connection reset");
    expect(h.started, "no film may be started when the dialogue state is undetermined").toEqual([]);
  });

  it("POSITIVE CONTROL: with derivation WORKING, the talking-door guard still fires (400)", async () => {
    // Proves the cf#334 guard itself is alive. Without this row, the assertion above could pass
    // simply because the door guard refuses everything, and the file would be measuring nothing.
    h.bundleScenes = VOICED_BUNDLE;
    const res = await worker.fetch(post("/api/storyboard/render", body()), env, ctx);
    expect(res.status).toBe(400);
    const parsed = (await res.json()) as { error?: string };
    expect(parsed.error ?? "").toContain("spoken lines");
    expect(h.started).toEqual([]);
  });

  it("THE LEGITIMATE SILENT PATH IS NOT BROKEN: an empty bundle still renders, 201", async () => {
    // readBundleScenes returns [] for a missing bundle or a bundle with no storyboard.yaml, which
    // means "nothing to voice", NOT "we could not tell". This row is what keeps the fix from
    // turning every genuinely silent render into a 503, and it must stay green forever.
    h.bundleScenes = [];
    const res = await worker.fetch(post("/api/storyboard/render", body()), env, ctx);
    expect(res.status).toBe(201);
    expect(h.started).toHaveLength(1);
    expect(h.started[0].dialogue_lines).toBeUndefined();
  });

  it("a voiced storyboard on a TALKING door renders, and carries its lines", async () => {
    h.bundleScenes = VOICED_BUNDLE;
    const res = await worker.fetch(
      post("/api/storyboard/render", body({ motion_backend: "talking-door" })), env, ctx,
    );
    expect(res.status).toBe(201);
    expect(h.started).toHaveLength(1);
    const lines = h.started[0].dialogue_lines as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0].text).toBe("We move now.");
  });

  it("THE voiceMap BUG: resolved cast voices reach the lines, not DEFAULT_VOICE_ID", async () => {
    // The second half of the same block. `voiceMap` was hardcoded `{}` with a comment claiming the
    // preflight "may only expose pretrained/castIds". It exposes `voices` too (see ResolvedCast in
    // src/render-door.ts), so every panel render spoke in the default voice even when the cast
    // member had one resolved -- the #582 shape, re-entered through the panel door.
    h.bundleScenes = VOICED_BUNDLE;
    h.voices = { A: "asteria" };
    h.pretrained = { A: "loras/cast-a.safetensors" };
    const res = await worker.fetch(
      post("/api/storyboard/render", body({ motion_backend: "talking-door", castLoras: { A: "cast-a" } })),
      env, ctx,
    );
    expect(res.status).toBe(201);
    const lines = h.started[0].dialogue_lines as Array<Record<string, unknown>>;
    expect(lines[0].voice_id, "the cast voice must win over DEFAULT_VOICE_ID").toBe("asteria");
    expect(lines[0].voice_id).not.toBe("angus");
  });

  it("a keyframes-only preview skips derivation entirely and is unaffected", async () => {
    // No motion leg, so there is nothing to say and nothing to refuse. A derivation failure here
    // must not block a preview that was never going to carry dialogue.
    h.bundleThrows = "R2 GET failed: connection reset";
    const res = await worker.fetch(
      post("/api/storyboard/render", { bundleKey: "bundles/good.tar.gz", scenes: SCENES, keyframesOnly: true }),
      env, ctx,
    );
    expect(res.status).toBe(201);
    expect(h.started).toHaveLength(1);
  });
});
