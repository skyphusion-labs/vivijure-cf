// cf#924: what the modules were ACTUALLY told, surfaced on the renders row.
//
// A render recorded WHICH door ran (motion_backend, keyframe_backend, cf#393) but never WHAT it was
// told to do. The config bag was accepted at submit, carried into the job, handed to the module, and
// then dropped. So no one could read back the knobs a render actually used.
//
// That is not academic. lip29: a `size: "720p"` request to `infinitetalk` produced a 480p artifact, and
// separating "the value never reached the vendor" from "the vendor ignored it" took an afternoon of
// reading four files and running the real compiled validateConfig against a probe table -- and still
// ended undetermined. One recorded field answers it in a single read. (It also would have caught the
// inverse error: reading 832x464 as proof the 480p request was HONOURED, when 480p is the schema
// default and the artifact cannot distinguish "applied" from "never arrived".)
//
// WHY ON `output` AND NOT A COLUMN. Same pattern core already uses for clip_deliveries /
// keyframes_incomplete and the host uses for wan_lora_projection (cf#392): a host-owned field relayed
// onto the poll view's output bag, which updateRenderFromView persists. A first-class column would need
// a core change (NewRenderRow, buildInsertRenderStmt, the SELECT projection all live in core), a D1
// migration, a core release and a pin bump here -- four repos-worth of motion for the same readable
// value. If the column is wanted later, this field is the thing to backfill it from.
//
// RESOLVED vs REQUESTED is labelled, never conflated. The resolved value is what core's validateConfig
// produced per shot and the module actually received (render-orchestrator retains it as shot.config,
// #767). The requested value is the raw bag the caller sent. They differ exactly when something
// coerced, which is the case worth seeing.

import type { FilmJob } from "@skyphusion-labs/vivijure-core/film-orchestrator";
import type { ClipJob } from "@skyphusion-labs/vivijure-core/render-orchestrator";

export const APPLIED_MODULE_CONFIG_FIELD = "applied_module_config" as const;

export interface AppliedModuleConfig {
  motion_backend?: string | null;
  /** The raw bag the caller sent. */
  motion_requested?: Record<string, unknown>;
  /** What validateConfig produced and the module received, when every shot agrees. */
  motion_resolved?: Record<string, unknown>;
  /** Per shot, when shots disagree (a per-shot motion_backend override). */
  motion_resolved_by_shot?: Record<string, Record<string, unknown>>;
  keyframe_backend?: string | null;
  /** Requested only: the keyframe module resolves its config inside the keyframe worker, so the
   *  host never sees a resolved value for it. Labelled accordingly rather than implied. */
  keyframe_requested?: Record<string, unknown>;
}

function stable(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + stable(o[k])).join(",") + "}";
}

/** Build the surface. Returns null when there is nothing honest to say, so an absent field never
 *  reads as "no config was used" -- it reads as "not recorded", which is the truth for legacy rows
 *  and for a film that has not reached the clips phase yet. */
export function buildAppliedModuleConfig(job: FilmJob, clipJob: ClipJob | null): AppliedModuleConfig | null {
  const out: AppliedModuleConfig = {};

  if (job.motion_backend) out.motion_backend = job.motion_backend;
  if (job.keyframe_backend) out.keyframe_backend = job.keyframe_backend;
  if (job.motion_config && Object.keys(job.motion_config).length) out.motion_requested = job.motion_config;
  if (job.keyframe_config && Object.keys(job.keyframe_config).length) out.keyframe_requested = job.keyframe_config;

  const withConfig = (clipJob?.shots ?? []).filter(
    (s): s is typeof s & { config: Record<string, unknown> } => !!s.config && typeof s.config === "object",
  );
  if (withConfig.length) {
    const distinct = new Set(withConfig.map((s) => stable(s.config)));
    if (distinct.size === 1) {
      out.motion_resolved = withConfig[0].config;
    } else {
      out.motion_resolved_by_shot = Object.fromEntries(withConfig.map((s) => [s.shot_id, s.config]));
    }
  }

  return Object.keys(out).length ? out : null;
}
