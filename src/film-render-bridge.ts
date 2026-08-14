// CF host bridge: poll view + scene helpers from core; renders-table row mapping stays host-shaped.
// filmJobToPollView is wrapped so host-owned fields (wan_lora_projection, cf#392) surface on the
// planner poll contract without a core pin bump.
export {
  isFilmJobId,
  mapRenderOverridesToModuleConfigs,
  normalizeFilmScenes,
  filterScenesByShotIds,
  orderScenesByShotIds,
  filmRenderRowSeedFromJob,
  stallSignal,
  KEYFRAME_STALL_SECONDS,
} from "@skyphusion-labs/vivijure-core/film-render-bridge";
import {
  filmJobToPollView as coreFilmJobToPollView,
  filmRenderRowSeedFromJob,
  type FilmRenderRowSeed,
} from "@skyphusion-labs/vivijure-core/film-render-bridge";
import {
  summarizeFilm as coreSummarizeFilm,
  type FilmJob,
  type FilmSummary,
} from "@skyphusion-labs/vivijure-core/film-orchestrator";
import type { ClipJob } from "@skyphusion-labs/vivijure-core/render-orchestrator";
import type { RunpodJobView } from "@skyphusion-labs/vivijure-core/runpod-types";
import type { NewRenderRow } from "@skyphusion-labs/vivijure-core/renders-db";
import {
  readWanLoraProjection,
  WAN_LORA_PROJECTION_FIELD,
  type WanLoraProjectionSurface,
} from "./wan-lora-projection";

/** Film summary plus the optional host-owned Wan projection surface (cf#392). */
export type FilmSummaryWithWan = FilmSummary & {
  [WAN_LORA_PROJECTION_FIELD]?: WanLoraProjectionSurface;
};

/** Core filmJobToPollView + relay of host-persisted `wan_lora_projection` onto `output` when present
 *  (same pattern as core's keyframes_incomplete / clip_deliveries relay). Absent stays absent. */
export function filmJobToPollView(
  job: FilmJob,
  clipJob: ClipJob | null,
  keyframeDone?: number,
): RunpodJobView {
  const view = coreFilmJobToPollView(job, clipJob, keyframeDone);
  const proj = readWanLoraProjection(job as { [WAN_LORA_PROJECTION_FIELD]?: unknown });
  if (!proj) return view;
  // Match core: only attach when an output bag already exists (IN_PROGRESS / COMPLETED). FAILED /
  // CANCELLED keep no output, so the field is not invented on a terminal-error shape.
  if (!view.output || typeof view.output !== "object") return view;
  return {
    ...view,
    output: {
      ...(view.output as Record<string, unknown>),
      [WAN_LORA_PROJECTION_FIELD]: proj,
    },
  };
}

/** Core summarizeFilm + host `wan_lora_projection` for the film-status door (GET/POST film). */
export function summarizeFilmWithProjection(
  job: FilmJob,
  clipJob: ClipJob | null,
): FilmSummaryWithWan {
  const summary: FilmSummaryWithWan = coreSummarizeFilm(job, clipJob);
  const proj = readWanLoraProjection(job as { [WAN_LORA_PROJECTION_FIELD]?: unknown });
  if (proj) summary[WAN_LORA_PROJECTION_FIELD] = proj;
  return summary;
}

/** Map core film row seed into the D1 renders-table insert shape. */
export function filmRowFromJob(job: FilmJob): NewRenderRow {
  const seed: FilmRenderRowSeed = filmRenderRowSeedFromJob(job);
  // cf#393's two widening casts are GONE. They existed only because this host pinned core ^1.7.2,
  // which declared neither FilmRenderRowSeed.motionBackend/keyframeBackend nor
  // FilmJob.keyframe_backend -- so the fields were read through a hand-written intersection type.
  // The host now pins ^1.11.0, which declares all three, and their deletion is the evidence that
  // gap closed rather than a claim that it did.
  return {
    jobId: seed.jobId,
    project: seed.project,
    bundleKey: seed.bundleKey,
    qualityTier: seed.qualityTier,
    status: seed.status,
    mode: seed.mode,
    parentId: seed.parentId,
    motionBackend: seed.motionBackend ?? job.motion_backend ?? null,
    keyframeBackend: seed.keyframeBackend ?? job.keyframe_backend ?? null,
  } as NewRenderRow;
}
