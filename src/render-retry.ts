// cf#353: real retry -- re-submit a failed row's STORED args through the shared doors.
// Failed row stays for the audit trail; a new row is inserted for the retry job.

import {
  defaultGpuDoorModule,
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
import { coerceQualityTier } from "@skyphusion-labs/vivijure-core/runpod-types";
import { getRenderByIdForUser, type RenderRow } from "@skyphusion-labs/vivijure-core/renders-db";
import type { OrchestratorEnv } from "@skyphusion-labs/vivijure-core/platform";
import type { RunpodJobView } from "@skyphusion-labs/vivijure-core/runpod-types";
import { animateFromPreview } from "./finalize-from-keyframes";
import { readIdempotencyKey } from "./film-idempotency";

const RETRYABLE = new Set(["FAILED", "CANCELLED", "TIMED_OUT"]);

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

const FULL_RETRY_DEGRADE =
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
  if (!RETRYABLE.has(row.status)) {
    return {
      ok: false,
      error: `only FAILED / CANCELLED / TIMED_OUT rows can be retried (status is ${row.status})`,
      status: 400,
    };
  }

  const tier = coerceQualityTier(row.quality_tier) ?? "final";
  const modules = await discoverModules(env as unknown as Record<string, unknown>);
  const overrides = row.render_overrides ?? undefined;
  const mapped = mapRenderOverridesToModuleConfigs(overrides, tier, modules);

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
      motionBackend:
        row.mode === "finalized"
          ? (mapped.motion_backend ?? defaultGpuDoorModule(modules)?.name)
          : mapped.motion_backend,
      idempotency_key,
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
  const motionBackend = keyframesOnly
    ? undefined
    : (mapped.motion_backend ?? defaultGpuDoorModule(modules)?.name);
  if (!keyframesOnly && !motionBackend) {
    return {
      ok: false,
      error: 'no gpu-door motion.backend module (ui.locality "byo"/"local") is installed',
      status: 400,
    };
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
      motion_config: mapped.motion_config,
      finish_config: mapped.finish_config,
      finish_select: mapped.finish_select,
      speech_config: mapped.speech_config,
      film_finish_config: mapped.film_finish_config,
      master_config: mapped.master_config,
      keyframes_only: keyframesOnly,
      dialogue_lines,
      idempotency_key,
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
