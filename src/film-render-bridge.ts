// CF host bridge: poll view + scene helpers from core; renders-table row mapping stays host-shaped.
export {
  isFilmJobId,
  mapRenderOverridesToModuleConfigs,
  normalizeFilmScenes,
  filterScenesByShotIds,
  orderScenesByShotIds,
  filmJobToPollView,
  filmRenderRowSeedFromJob,
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
  return {
    jobId: seed.jobId,
    project: seed.project,
    bundleKey: seed.bundleKey,
    qualityTier: seed.qualityTier,
    status: seed.status,
    mode: seed.mode,
    parentId: seed.parentId,
  };
}
