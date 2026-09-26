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
import type { RenderRow } from "@skyphusion-labs/vivijure-core/renders-db";
import type { OrchestratorEnv } from "@skyphusion-labs/vivijure-core/platform";
import type { RunpodJobView } from "@skyphusion-labs/vivijure-core/runpod-types";
import { animateFromPreview } from "./finalize-from-keyframes";
import { readIdempotencyKey } from "./film-idempotency";

const RETRYABLE = new Set(["FAILED", "CANCELLED", "TIMED_OUT"]);

export type RetryResult =
  | { ok: true; view: RunpodJobView; mode: string }
  | { ok: false; error: string; status: number };

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

  // finalized / cloud-finalized: reuse animateFromPreview (needs parent keyframes on the row)
  if (row.mode === "finalized" || row.mode === "cloud-finalized") {
    if (!row.keyframes || row.keyframes.length === 0) {
      return {
        ok: false,
        error: "retry of a finalize/cloud row requires keyframes on the failed row",
        status: 400,
      };
    }
    const r = await animateFromPreview(env, {
      parent: row,
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
  };
}
