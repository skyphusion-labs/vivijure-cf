// CF host bridge: poll view + scene helpers from core; renders-table row mapping stays host-shaped.
export {
  isFilmJobId,
  mapRenderOverridesToModuleConfigs,
  normalizeFilmScenes,
  filterScenesByShotIds,
  orderScenesByShotIds,
  filmJobToPollView,
  filmRenderRowSeedFromJob,
  stallSignal,
  KEYFRAME_STALL_SECONDS,
} from "@skyphusion-labs/vivijure-core/film-render-bridge";
import type { FilmJob } from "@skyphusion-labs/vivijure-core/film-orchestrator";
import {
  filmRenderRowSeedFromJob,
  type FilmRenderRowSeed,
} from "@skyphusion-labs/vivijure-core/film-render-bridge";
import type { NewRenderRow } from "@skyphusion-labs/vivijure-core/renders-db";

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
