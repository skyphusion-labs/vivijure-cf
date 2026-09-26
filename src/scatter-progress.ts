// Fold completed-shard counts onto a scatter poll view so the planner can
// show "3 of 7 shots", a percent, and an ETA. Core's scatterJobToPollView
// only sends phase + shard/shot totals; the done counts live on the child
// render rows (and, when present, the scatter job doc).

import { getRenderIdByJobId, getScatterChildren } from "@skyphusion-labs/vivijure-core/renders-db";
import type { OrchestratorEnv } from "@skyphusion-labs/vivijure-core/platform";

export type ScatterChild = { job_id: string; status: string };

type ScatterPollView = {
  jobId: string;
  status: string;
  statusRaw?: string;
  error?: string;
  output?: unknown;
};

const DONE = new Set(["COMPLETED", "COMPLETE", "DONE"]);

export function scatterProgressFields(
  phase: string,
  children: ScatterChild[],
  shardFilmIds: string[],
  shardShots: string[][],
  expectedShotIds: string[],
): Record<string, unknown> {
  const statusById = new Map(children.map((c) => [c.job_id, c.status.toUpperCase()]));
  const ids = shardFilmIds.length ? shardFilmIds : children.map((c) => c.job_id);
  let shardsDone = 0;
  let shotsDone = 0;
  for (let i = 0; i < ids.length; i++) {
    if (!DONE.has(statusById.get(ids[i]) || "")) continue;
    shardsDone += 1;
    const shots = shardShots[i];
    shotsDone += Array.isArray(shots) && shots.length ? shots.length : 1;
  }
  const shotTotal = expectedShotIds.length
    || shardShots.reduce((n, s) => n + (s ? s.length : 0), 0)
    || ids.length;
  const shardTotal = ids.length;
  const inShards = phase === "shards" || phase === "";
  const progress = inShards
    ? (shotTotal > 0 ? Math.min(1, shotsDone / shotTotal) : 0)
    : phase === "mux"
      ? 0.97
      : 0.9;
  return {
    phase: phase || "shards",
    scene_index: shotTotal > 0 ? Math.min(shotTotal, shotsDone + 1) : 1,
    scene_total: shotTotal,
    progress,
    shots_done: shotsDone,
    shards_done: shardsDone,
    shards: shardTotal,
  };
}

const GATHER_GENERIC = /can never arrive|owning shard dead/i;

export function preferredScatterError(parentError: string | undefined, childErrors: string[]): string | undefined {
  const child = childErrors.map((e) => String(e || "").trim()).find(Boolean);
  const parent = (parentError || "").trim();
  if (child && (!parent || GATHER_GENERIC.test(parent))) return child;
  return parent || child || undefined;
}

async function childRenderErrors(env: OrchestratorEnv, parentId: number): Promise<string[]> {
  try {
    const rs = await env.DB.prepare(
      `SELECT error FROM renders WHERE parent_id = ? AND error IS NOT NULL AND TRIM(error) != '' ORDER BY id ASC`,
    )
      .bind(parentId)
      .all<{ error: string }>();
    return (rs.results ?? []).map((r) => String(r.error || "")).filter(Boolean);
  } catch {
    return [];
  }
}

async function readScatterJobDoc(env: OrchestratorEnv, scatterId: string): Promise<{
  shard_film_ids?: string[];
  shard_shots?: string[][];
  expected_shot_ids?: string[];
} | null> {
  try {
    const obj = await env.R2_RENDERS.get("renders/" + scatterId + "/scatter-job.json");
    if (!obj) return null;
    return JSON.parse(await obj.text()) as {
      shard_film_ids?: string[];
      shard_shots?: string[][];
      expected_shot_ids?: string[];
    };
  } catch {
    return null;
  }
}

export async function enrichScatterPollView<T extends ScatterPollView>(
  env: OrchestratorEnv,
  view: T,
): Promise<T> {
  const jobId = view.jobId;
  if (!jobId || !String(jobId).startsWith("scatter-")) return view;

  if (view.status === "FAILED") {
    const parentId = await getRenderIdByJobId(env, jobId);
    if (parentId == null) return view;
    const childErrors = await childRenderErrors(env, parentId);
    const error = preferredScatterError(view.error, childErrors);
    return error && error !== view.error ? { ...view, error } : view;
  }

  if (view.status !== "IN_PROGRESS") return view;

  const parentId = await getRenderIdByJobId(env, jobId);
  const children = parentId != null ? await getScatterChildren(env, parentId) : [];
  const doc = await readScatterJobDoc(env, jobId);
  const out = (view.output && typeof view.output === "object")
    ? (view.output as Record<string, unknown>)
    : {};
  const phase = typeof out.phase === "string" ? out.phase : (view.statusRaw || "shards");
  const fields = scatterProgressFields(
    String(phase),
    children,
    doc?.shard_film_ids || [],
    doc?.shard_shots || [],
    doc?.expected_shot_ids || (typeof out.scene_total === "number" ? Array(out.scene_total).fill("") : []),
  );
  return {
    ...view,
    output: { ...out, ...fields },
  };
}
