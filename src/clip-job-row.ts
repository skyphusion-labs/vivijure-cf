// cf#1309: a standalone clip job (POST /api/render/clips) gets a renders row.
//
// Before this the door called startClipJob and wrote nothing to D1, so nothing named the job: it was
// missing from render history, render delete could not reach it, and the #1009 orphan sweep had to
// leave every renders/clips-<uuid>/ tree alone because a dead standalone tree and a legacy one looked
// the same. Now the door writes, in this order:
//
//   1. renders/<clips-id>/clips-job.json   startClipJob (core), as before;
//   2. renders/<clips-id>/owner.json       the owner marker (clipJobOwnerKey), this file;
//   3. the renders row                     job_id = the clips id, so the row owns the tree.
//
// Each step fails toward KEEP. A crash after 1 leaves a tree with no marker, which the sweep treats
// as legacy and never deletes. A crash after 2 leaves a marked tree with no row; the next poll heals
// the row (insert if missing), and a tree nobody polls again becomes an orphan only after the grace
// window. That last case is the film door's behaviour too (#695: its row insert is best effort).
//
// The row reuses the existing columns. job_id carries the kind (clips-*), so nothing new is needed in
// the schema. Mode: core's NewRenderRow type has no clip value, so the row is inserted as "full" and
// the poll view's output carries mode "clips", which updateRenderFromView mirrors into the column
// (COALESCE, the same path a GPU envelope uses). D1 then reads "clips"; core's list projection
// collapses any value it does not know to "full", so the panel discriminates on the job_id prefix.
//
// No IO except the marker helpers at the bottom, so the row and view shape unit-test.

import type { ClipJob } from "@skyphusion-labs/vivijure-core/render-orchestrator";
import { describeClipFailures, summarizeJob } from "@skyphusion-labs/vivijure-core/render-orchestrator";
import type { NewRenderRow } from "@skyphusion-labs/vivijure-core/renders-db";
import type { RunpodJobView, RunpodStatus } from "@skyphusion-labs/vivijure-core/runpod-types";

import type { StudioEnv } from "./orchestrator-env";
import { clipJobOwnerKey } from "./record-reclaim";

/** The row mode the poll view writes. Raw D1 only; see the header for why the type does not carry it. */
export const CLIP_JOB_MODE = "clips";

/** A clip job's status in the RunPod vocabulary the renders row uses.
 *  Not complete: IN_PROGRESS. Complete with no clip: FAILED. Otherwise COMPLETED, with the failed
 *  shots named in the view's error so a partial job does not read as clean. */
export function clipJobStatus(job: ClipJob): RunpodStatus {
  const s = summarizeJob(job);
  if (!s.complete) return "IN_PROGRESS";
  return s.done === 0 ? "FAILED" : "COMPLETED";
}

/** The renders row a standalone clip job is inserted with. */
export function clipJobRowSeed(job: ClipJob): NewRenderRow {
  return {
    jobId: job.job_id,
    project: job.project,
    // A clip job has no bundle and no quality tier. The empty bundle names no key (renderRowKeys skips
    // it) and makes the panel's bundle actions inert; the tier is the film seed's own default.
    bundleKey: "",
    qualityTier: "final",
    status: clipJobStatus(job),
    mode: "full",
    motionBackend: job.motion_backend ?? null,
  };
}

/** The poll view that keeps the row current. output.clips is the #519 shape ({shot_id, key, model}),
 *  which the row's output_json already harvests as keys, so the row names every finished clip. */
export function clipJobToPollView(job: ClipJob): RunpodJobView {
  const status = clipJobStatus(job);
  const clips = job.shots
    .filter((sh) => sh.status === "done" && typeof sh.clip_key === "string" && sh.clip_key.length > 0)
    .map((sh) => ({ shot_id: sh.shot_id, key: sh.clip_key as string, model: sh.motion_backend ?? job.motion_backend ?? null }));
  const failures = describeClipFailures(job);
  return {
    jobId: job.job_id,
    status,
    statusRaw: status,
    output: { mode: CLIP_JOB_MODE, clips, summary: summarizeJob(job) },
    ...(status !== "IN_PROGRESS" && failures ? { error: failures } : {}),
  };
}

/** Write the owner marker. Called after startClipJob has written the doc and before the row. */
export async function writeClipJobOwner(env: StudioEnv, jobId: string): Promise<void> {
  await env.R2_RENDERS.put(
    clipJobOwnerKey(jobId),
    JSON.stringify({ owner: "renders", job_id: jobId, door: "POST /api/render/clips" }),
    { httpMetadata: { contentType: "application/json" } },
  );
}

/** Whether this clip job was born standalone. A film's clip job has no marker, so a poll of it through
 *  the clips route never inserts a row for it. */
export async function isStandaloneClipJob(env: StudioEnv, jobId: string): Promise<boolean> {
  return (await env.R2_RENDERS.head(clipJobOwnerKey(jobId))) !== null;
}
