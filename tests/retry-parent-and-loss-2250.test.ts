import { describe, it, expect, vi, beforeEach } from "vitest";

// fc#2250 item 6 -- RETRY IS BROKEN (finalize) AND LOSSY (full).
//
// HALF ONE: FINALIZE RETRY ALWAYS 400s. src/render-retry.ts passes the FAILED ROW ITSELF as
// `parent` to animateFromPreview, and validatePreviewParent requires
// `mode === "keyframes-only"` AND `status === "COMPLETED"`. A failed finalize row is
// mode "finalized"/"cloud-finalized" with status FAILED, so the first condition can NEVER hold.
// Every finalize retry that has ever been attempted returned 400 "parent render is not a
// keyframes-only preview".
//
// THE FIX IS NOT TO WEAKEN THE GUARD. The row already records where its real parent is:
// finalize-from-keyframes.ts:295 inserts the derived row with `parentId: args.parent.id`. So the
// failed finalize row POINTS AT the completed keyframes-only preview it was derived from, and retry
// was simply passing the wrong row. Loading the parent by `parent_id` makes validatePreviewParent
// pass on its own terms, with the finalize door's precondition fully intact. That distinction is
// what rows 3 and 4 below exist to pin: a fix that deleted the mode/status check would pass row 2
// and fail row 3.
//
// HALF TWO: FULL RETRY REBUILDS A DIFFERENT FILM AND RETURNS 201. It rebuilds from the bundle
// scenes plus the stored overrides only. `renders` does not persist the submit-time inputs
// (RenderRow in core carries bundle_key, quality_tier, render_overrides, keyframes, locked_shots,
// mode, parent_id and nothing else), so `pretrained_loras`, `cast_loras`, `voice_ref_keys`,
// `audio_key`, `film_titles` and the `processShotIds` subset are all structurally unrecoverable,
// and cast voices with them (resolveCastLoras needs the slot -> cast_id map, which is not stored).
//
// That is a SCHEMA gap, not a logic bug, so it cannot be fixed by deriving harder. What it must not
// do is return a bare 201, which claims a faithful replay of a film it did not rebuild. The honest
// minimum, and the shape this repo already uses for polish steps (#249/#77), is to declare the
// degrade rather than hide it: the caller learns this is a RE-DERIVATION. Whether `renders` should
// persist the submit args instead is flagged for a ruling, not decided here.

const h = vi.hoisted(() => ({
  film: [] as Array<Record<string, unknown>>,
  fromKeyframes: [] as Array<Record<string, unknown>>,
  rows: new Map<number, Record<string, unknown>>(),
  bundleScenes: [] as Array<Record<string, unknown>>,
}));

vi.mock("@skyphusion-labs/vivijure-core/film-orchestrator", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/film-orchestrator")>();
  return {
    ...actual,
    startFilmJob: vi.fn(async (_e: unknown, args: Record<string, unknown>) => {
      h.film.push(args);
      return { film_id: "film-retry", phase: "keyframe", scenes: args.scenes, project: "p", created_at: 0 };
    }),
    startFilmFromKeyframes: vi.fn(async (_e: unknown, args: Record<string, unknown>) => {
      h.fromKeyframes.push(args);
      return { film_id: "film-retry-kf", phase: "clips", scenes: args.scenes, project: "p", created_at: 0 };
    }),
  };
});
vi.mock("@skyphusion-labs/vivijure-core/renders-db", async (orig) => {
  const actual = await orig<typeof import("@skyphusion-labs/vivijure-core/renders-db")>();
  return {
    ...actual,
    insertRender: vi.fn(async () => true),
    // The seam the fix needs: retry must be able to load the parent preview by parent_id.
    getRenderByIdForUser: vi.fn(async (_e: unknown, id: number) => h.rows.get(id) ?? null),
  };
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

import { retryFailedRender } from "../src/render-retry";
import { _resetModuleDiscoveryCache } from "@skyphusion-labs/vivijure-core/modules/registry";
import { MODULE_API } from "@skyphusion-labs/vivijure-core/modules/types";
import type { RenderRow } from "@skyphusion-labs/vivijure-core/renders-db";
import type { OrchestratorEnv } from "@skyphusion-labs/vivijure-core/platform";

function moduleBinding(name: string, hooks: string[], locality: string, usage?: Record<string, unknown>) {
  return {
    fetch: async () =>
      new Response(
        JSON.stringify({ name, version: "0.1.0", api: MODULE_API, hooks, ui: { order: 10, locality }, usage }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  };
}

const DB = {
  prepare: () => ({
    bind: () => ({ first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }) }),
    first: async () => null, all: async () => ({ results: [] }), run: async () => ({ success: true }),
  }),
  batch: async () => [],
};

const env = {
  DB,
  R2_RENDERS: { get: async () => null, head: async () => null, put: async () => {} },
  MODULE_KEYFRAME: moduleBinding("keyframe-sdxl", ["keyframe"], "byo"),
  MODULE_WAN: moduleBinding("alibaba-wan", ["motion.backend"], "byo", {
    native_audio: true, voice: "prompt_lock", scatter_native_audio: true, min_seconds: 1, max_seconds: 10,
  }),
  // A CLOUD motion door as well: the cloud-finalized mode resolves one specifically, and a byo door
  // does not satisfy it. defaultGpuDoorModule still picks the byo door for the full path, so the
  // two cases below stay distinct rather than collapsing onto one module.
  MODULE_CLOUD_SEEDANCE: moduleBinding("cf-seedance", ["motion.backend"], "cloud", {
    native_audio: true, voice: "prompt_lock", scatter_native_audio: true, min_seconds: 1, max_seconds: 10,
  }),
} as unknown as OrchestratorEnv;

const KEYFRAMES = [{ shot_id: "shot_01", key: "renders/p/clips/shot_01_keyframe.png" }];

function row(over: Partial<RenderRow>): RenderRow {
  return {
    id: 1, public_id: "pub-1", job_id: "job-1", project: "p",
    bundle_key: "bundles/good.tar.gz", quality_tier: "final",
    motion_backend: null, keyframe_backend: null, render_overrides: null,
    status: "FAILED", output_key: null, output: null, error: null,
    execution_time_ms: null, delay_time_ms: null, output_ms: null, finish_elapsed_ms: null,
    submitted_at: 0, updated_at: 0, completed_at: null, label: null,
    keyframes: KEYFRAMES, mode: "full", locked_shots: null, project_id: null,
    folder_path: null, tags: [], parent_id: null,
    project_public_id: null, parent_public_id: null,
    ...over,
  } as RenderRow;
}

const PREVIEW = row({ id: 1, public_id: "pub-preview", mode: "keyframes-only", status: "COMPLETED" });

beforeEach(() => {
  _resetModuleDiscoveryCache();
  h.film = [];
  h.fromKeyframes = [];
  h.bundleScenes = [{ shot_id: "shot_01", prompt: "a shot", seconds: 4 }];
  h.rows = new Map<number, Record<string, unknown>>([[1, PREVIEW as unknown as Record<string, unknown>]]);
});

describe("fc#2250 item 6 half one -- finalize retry reaches its real parent preview", () => {
  it("THE DEFECT: a failed finalize row with a valid parent must NOT 400", async () => {
    // Before the fix this returned 400 "parent render is not a keyframes-only preview" for EVERY
    // finalize retry, because the failed row was passed as its own parent.
    const failed = row({ id: 2, public_id: "pub-2", mode: "finalized", status: "FAILED", parent_id: 1 });
    const r = await retryFailedRender(env, failed);
    expect(
      r.ok,
      `finalize retry refused: ${r.ok ? "" : r.error}`,
    ).toBe(true);
    // And it must have gone through the from-keyframes submit, not the full startFilmJob path.
    expect(h.fromKeyframes, "animateFromPreview must reach startFilmFromKeyframes").toHaveLength(1);
    expect(h.film, "a finalize retry must not start a full film job").toHaveLength(0);
  });

  it("cloud-finalized reaches its parent too (the sibling mode)", async () => {
    const failed = row({ id: 3, public_id: "pub-3", mode: "cloud-finalized", status: "TIMED_OUT", parent_id: 1 });
    const r = await retryFailedRender(env, failed);
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    expect(h.fromKeyframes).toHaveLength(1);
  });

  it("THE GUARD IS NOT WEAKENED: a parent that is not a completed preview is still refused", async () => {
    // The row that fails if someone "fixes" this by deleting the mode/status check in
    // validatePreviewParent instead of loading the right parent.
    h.rows.set(9, row({ id: 9, mode: "keyframes-only", status: "IN_PROGRESS" }) as unknown as Record<string, unknown>);
    const failed = row({ id: 4, public_id: "pub-4", mode: "finalized", status: "FAILED", parent_id: 9 });
    const r = await retryFailedRender(env, failed);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/not completed|not a keyframes-only preview/i);
    expect(h.fromKeyframes, "nothing may be submitted on a refusal").toHaveLength(0);
    expect(h.film).toHaveLength(0);
  });

  it("a finalize row with NO parent_id is refused honestly, naming the missing parent", async () => {
    // Legacy rows predate the parentId column being written. That must be an honest refusal that
    // says what is missing, never a crash and never a silent full-film rebuild.
    const orphan = row({ id: 5, public_id: "pub-5", mode: "finalized", status: "FAILED", parent_id: null });
    const r = await retryFailedRender(env, orphan);
    expect(r.ok).toBe(false);
    expect((r as { error: string }).error).toMatch(/parent/i);
    expect(h.fromKeyframes).toHaveLength(0);
    expect(h.film, "must not fall through to a full film rebuild").toHaveLength(0);
  });

  it("a finalize row whose parent row is GONE is refused, not retried as something else", async () => {
    const dangling = row({ id: 6, public_id: "pub-6", mode: "finalized", status: "FAILED", parent_id: 404 });
    const r = await retryFailedRender(env, dangling);
    expect(r.ok).toBe(false);
    // The diagnostic has to identify WHAT is missing, not merely refuse.
    expect((r as { error: string }).error).toMatch(/preview/i);
    expect((r as { error: string }).error).toMatch(/no longer exists/i);
    expect(h.fromKeyframes).toHaveLength(0);
    expect(h.film).toHaveLength(0);
  });
});

describe("fc#2250 item 6 half two -- a full retry declares what the stored row cannot preserve", () => {
  it("full retry still submits (the positive control)", async () => {
    const failed = row({ id: 7, public_id: "pub-7", mode: "full", status: "FAILED" });
    const r = await retryFailedRender(env, failed);
    expect(r.ok, r.ok ? "" : (r as { error: string }).error).toBe(true);
    expect(h.film).toHaveLength(1);
  });

  it("THE LOSS IS DECLARED, not hidden behind a bare success", async () => {
    // A bare ok:true claims a faithful replay of a film this path did not rebuild. The submit-time
    // inputs are not on the row, so the honest answer names them.
    const failed = row({ id: 8, public_id: "pub-8", mode: "full", status: "FAILED" });
    const r = await retryFailedRender(env, failed);
    expect(r.ok).toBe(true);
    const degraded = (r as { degraded?: string }).degraded;
    expect(degraded, "a lossy retry must say so").toBeTruthy();
    // It has to name the fields, or it is a warning nobody can act on.
    for (const field of ["audio_key", "film_titles", "cast_loras", "voice_ref_keys"]) {
      expect(degraded, `degrade reason must name ${field}`).toContain(field);
    }
  });

  it("a finalize retry is NOT labelled lossy (the discrimination control)", async () => {
    // animateFromPreview rebuilds from the parent row's own stored state, so it is not subject to
    // the same loss. If `degraded` were set unconditionally it would be noise rather than signal,
    // and this row is what keeps it meaningful.
    const failed = row({ id: 9, public_id: "pub-9", mode: "finalized", status: "FAILED", parent_id: 1 });
    const r = await retryFailedRender(env, failed);
    expect(r.ok).toBe(true);
    expect((r as { degraded?: string }).degraded).toBeUndefined();
  });

  it("dialogue lines are still derived from the bundle on a full retry", async () => {
    // What IS recoverable must still be recovered: the storyboard text lives in the bundle.
    h.bundleScenes = [
      { shot_id: "shot_01", prompt: "a shot", seconds: 4, dialogue: { slot: "A", text: "We move now." } },
    ];
    const failed = row({ id: 10, public_id: "pub-10", mode: "full", status: "FAILED" });
    const r = await retryFailedRender(env, failed);
    expect(r.ok).toBe(true);
    const lines = h.film[0].dialogue_lines as Array<Record<string, unknown>> | undefined;
    expect(lines, "the bundle storyboard carries a spoken line; retry must not drop it").toHaveLength(1);
    expect(lines![0].text).toBe("We move now.");
  });
});
