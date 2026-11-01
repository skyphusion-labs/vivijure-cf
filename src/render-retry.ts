// cf#353: real retry -- re-submit a failed row's STORED args through the shared doors.
// Failed row stays for the audit trail; a new row is inserted for the retry job.

import {
  discoverModules,
  servingForHook,
} from "@skyphusion-labs/vivijure-core/modules/registry";
import { readBundleScenes } from "@skyphusion-labs/vivijure-core/bundle-storyboard";
import {
  startFilmJob,
  type FilmScene,
} from "@skyphusion-labs/vivijure-core/film-orchestrator";
import type { DialogueLine } from "@skyphusion-labs/vivijure-core/modules/types";
import {
  dialogueLinesFromBundleScenes,
  resolveExplicitLineVoices,
} from "@skyphusion-labs/vivijure-core/dialogue-lines";
import { filmJobToPollView } from "@skyphusion-labs/vivijure-core/film-render-bridge";
import { mapRenderOverridesToModuleConfigs } from "./film-render-bridge";
import { parseModuleRenderOverrides } from "@skyphusion-labs/vivijure-core/render-module-config";
import { hostedMotionFallback, prepareSpokenClip, spokenLinesPresent, withMotionBackend } from "./motion-scatter";
import { coerceQualityTier } from "@skyphusion-labs/vivijure-core/runpod-types";
import { getRenderByIdForUser, type RenderRow } from "@skyphusion-labs/vivijure-core/renders-db";
import type { OrchestratorEnv } from "@skyphusion-labs/vivijure-core/platform";
import type { RunpodJobView } from "@skyphusion-labs/vivijure-core/runpod-types";
import { animateFromPreview } from "./finalize-from-keyframes";
import { readIdempotencyKey } from "./film-idempotency";

const RETRYABLE = new Set(["FAILED", "CANCELLED", "TIMED_OUT"]);

/** The one statement of which rows can be retried, for both retry paths. */
export function retryStatusRefusal(status: string): string | null {
  return RETRYABLE.has(status) ? null : `only FAILED / CANCELLED / TIMED_OUT rows can be retried (status is ${status})`;
}

export type RetryResult =
  // fc#2250: `degraded` is set when the retry could not be a faithful replay of the original
  // submit. It is ABSENT, never empty-string, when the retry is faithful, so "no degrade" and
  // "a degrade nobody described" stay different facts (the #249/#77 honest-degrade discipline).
  | { ok: true; view: RunpodJobView; mode: string; degraded?: string }
  | { ok: false; error: string; status: number };

// fc#2250: what a FULL retry structurally cannot restore, named once so the message and the reason
// cannot drift apart.
//
// `renders` does not persist the submit-time inputs. RenderRow carries bundle_key, quality_tier,
// render_overrides, keyframes, locked_shots, mode and parent_id, and nothing else, so a full retry
// rebuilds from the bundle scenes plus the stored overrides bag and NOTHING more. Cast voices go
// with them: resolveCastLoras needs the slot -> cast_id map, which is a body field on the original
// request and is not stored either.
//
// This is a SCHEMA gap, not a logic bug, so it cannot be fixed by deriving harder. What it must not
// do is answer a bare 201, which claims a faithful replay of a film it did not rebuild. Whether
// `renders` should persist the submit args (and let retry be a true replay) is an open question
// above this file; until it is answered, the degrade is DECLARED rather than hidden.
const FULL_RETRY_NOT_PRESERVED = [
  "pretrained_loras",
  "cast_loras",
  "voice_ref_keys",
  "audio_key",
  "film_titles",
  "processShotIds",
];

export const FULL_RETRY_DEGRADE =
  "re-derived from the stored bundle and render_overrides, not replayed: the renders row does not "
  + "persist the submit-time inputs, so this job drops "
  + FULL_RETRY_NOT_PRESERVED.join(", ")
  + " and any cast voices from the original submit. Re-submit from the panel to reproduce the "
  + "original film exactly.";

async function dialogueFromBundle(
  scenes: Awaited<ReturnType<typeof readBundleScenes>>,
): Promise<DialogueLine[] | undefined> {
  try {
    let lines = dialogueLinesFromBundleScenes(scenes, {});
    if (!lines.length) return undefined;
    lines = resolveExplicitLineVoices(lines, scenes, {});
    return lines;
  } catch {
    return undefined;
  }
}

/** Re-submit a terminal failed/cancelled/timed-out render from its stored row fields. */
export async function retryFailedRender(
  env: OrchestratorEnv,
  row: RenderRow,
  opts?: { idempotency_key?: string },
): Promise<RetryResult> {
  const idempotency_key = readIdempotencyKey({ idempotency_key: opts?.idempotency_key });
  const statusRefusal = retryStatusRefusal(row.status);
  if (statusRefusal) {
    return {
      ok: false,
      error: statusRefusal,
      status: 400,
    };
  }

  const tier = coerceQualityTier(row.quality_tier) ?? "final";
  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  const overrides = row.render_overrides ?? undefined;
  const rawMotion = parseModuleRenderOverrides(overrides).motion_backend;
  let mapped = mapRenderOverridesToModuleConfigs(overrides, tier, modules);

  // finalized / cloud-finalized: reuse animateFromPreview.
  //
  // fc#2250. This used to pass `row` -- the FAILED row -- as `parent`, and validatePreviewParent
  // requires mode === "keyframes-only" AND status === "COMPLETED". A failed finalize row is
  // "finalized"/"cloud-finalized" with a terminal failure status, so the first condition could never
  // hold and EVERY finalize retry 400ed with "parent render is not a keyframes-only preview".
  //
  // The guard was right and the argument was wrong. The row already records where its real parent
  // is: animateFromPreview inserts the derived row with `parentId: args.parent.id`
  // (finalize-from-keyframes.ts), so a finalize row POINTS AT the completed keyframes-only preview
  // it came from. Loading that parent makes validatePreviewParent pass on its own terms, with the
  // finalize door's precondition fully intact -- deliberately NOT weakened, because the check is
  // what stops a caller finalizing a preview that has not finished.
  if (row.mode === "finalized" || row.mode === "cloud-finalized") {
    if (row.parent_id == null) {
      return {
        ok: false,
        error:
          "retry of a finalize/cloud row needs the keyframes-only preview it was derived from, and "
          + "this row records no parent render (rows created before the parent link was written). "
          + "Finalize the preview again instead.",
        status: 400,
      };
    }
    const parent = await getRenderByIdForUser(env as never, row.parent_id);
    if (!parent) {
      return {
        ok: false,
        error:
          "the keyframes-only preview this render was derived from no longer exists, so there is "
          + "nothing to re-animate from. Render a new preview instead.",
        status: 400,
      };
    }
    const r = await animateFromPreview(env, {
      parent,
      deriveMode: row.mode,
      // The stored bag's own motion_backend, not the pipeline default. An omitted
      // name lets animateFromPreview pick the hosted spoken or silent door.
      motionBackend: rawMotion,
      idempotency_key,
      reuse_finished: true, // cf#1166, same as the full retry below.
    });
    if (!r.ok) return { ok: false, error: r.error, status: r.status ?? 400 };
    return { ok: true, view: r.view as RunpodJobView, mode: row.mode };
  }

  // full / keyframes-only
  if (servingForHook(modules, "keyframe").length === 0) {
    return { ok: false, error: "no keyframe module installed", status: 503 };
  }
  const keyframesOnly = row.mode === "keyframes-only";
  if (!keyframesOnly && servingForHook(modules, "motion.backend").length === 0) {
    return { ok: false, error: "no motion.backend module installed", status: 503 };
  }

  const parsed = await readBundleScenes(env, row.bundle_key);
  if (!parsed.length) {
    return { ok: false, error: "bundle has no storyboard scenes", status: 400 };
  }
  const scenes: FilmScene[] = parsed.map((s) => ({
    shot_id: s.shot_id,
    prompt: s.prompt,
    seconds: s.seconds,
  }));
  const dialogue_lines = await dialogueFromBundle(parsed);
  const spoken = spokenLinesPresent(dialogue_lines);
  let motionBackend: string | undefined;
  let motionConfig = mapped.motion_config;
  if (!keyframesOnly) {
    const picked = hostedMotionFallback(modules, rawMotion, spoken);
    if (!("name" in picked)) {
      return { ok: false, error: picked.error, status: 400 };
    }
    if (!rawMotion) {
      mapped = mapRenderOverridesToModuleConfigs(withMotionBackend(overrides, picked.name), tier, modules);
    }
    motionBackend = mapped.motion_backend ?? picked.name;
    motionConfig = mapped.motion_config;
    const clip = prepareSpokenClip(
      modules,
      modules.find((m) => m.name === motionBackend),
      mapped.motion_config,
      undefined,
      spoken,
    );
    if (!clip.ok) return { ok: false, error: clip.error, status: 400 };
    motionConfig = clip.config ?? mapped.motion_config;
  }

  const job = await startFilmJob(
    env,
    {
      project: row.project,
      bundle_key: row.bundle_key,
      scenes,
      motion_backend: motionBackend,
      keyframe_backend: mapped.keyframe_backend,
      keyframe_config: mapped.keyframe_config,
      motion_config: motionConfig,
      finish_config: mapped.finish_config,
      finish_select: mapped.finish_select,
      speech_config: mapped.speech_config,
      film_finish_config: mapped.film_finish_config,
      master_config: mapped.master_config,
      keyframes_only: keyframesOnly,
      dialogue_lines,
      idempotency_key,
      // cf#1166: a retry re-runs a film that already paid for its lines, clips and finish steps.
      // Core keeps each one only when its inputs are proven identical, so a changed input still
      // rebuys. Off on every door except this one and an explicit submit.
      reuse_finished: true,
    },
    modules,
  );
  if (job.phase === "failed") {
    return { ok: false, error: job.error || "retry submit failed", status: 422 };
  }
  return {
    ok: true,
    view: filmJobToPollView(job, null) as RunpodJobView,
    mode: keyframesOnly ? "keyframes-only" : "full",
    // fc#2250: declared, not hidden. See FULL_RETRY_NOT_PRESERVED above. The finalize branch does
    // NOT set this: it rebuilds from the parent row's own stored state and is not subject to the
    // same loss, and a reason set unconditionally would be noise rather than signal.
    degraded: FULL_RETRY_DEGRADE,
  };
}
