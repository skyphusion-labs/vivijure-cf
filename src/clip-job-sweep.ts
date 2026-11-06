// cf#1316: advance the standalone clip jobs nobody polls.
//
// A standalone clip job (POST /api/render/clips) has a renders row since cf#1309, but only
// GET /api/render/clips/:id advanced it. Core's render sweep drives film-* and scatter-* ids and returns
// handled: false for anything else. So a clip job whose client stopped polling kept its row IN_PROGRESS,
// and the clips its door finished were never adopted into the doc or the row. From core 1.35.0 that is
// worse: a job over 20 shots buys its later batches from the advance, so an unpolled job also stops buying.
//
// This pass is the second driver cf#1315 named. It takes the SAME lease as the poll route
// (withClipJobLease, src/clip-job-lease.ts), so the two never advance one job at once: a job another driver
// holds is skipped this pass and picked up on a later one. A job that advances gets the same row update
// the poll gives it (clipJobToPollView).
//
// Bounded: CLIP_SWEEP_PAGE jobs a pass, paged with core's rotatingOffset by the minute index (the cron is
// every minute), so a run of jobs that cannot move does not starve the rest.

import { advanceClipJob } from "@skyphusion-labs/vivijure-core/render-orchestrator";
import { updateRenderFromView } from "@skyphusion-labs/vivijure-core/renders-db";
import { rotatingOffset } from "@skyphusion-labs/vivijure-core/render-sweep";

import type { StudioEnv } from "./orchestrator-env";
import { clipJobToPollView, isStandaloneClipJob } from "./clip-job-row";
import { ensureClipJobRow, withClipJobLease } from "./clip-job-lease";

/** The most standalone clip jobs one sweep pass advances. Each advance makes at most 20 polls and
 *  20 submits (core CLIP_MAX_IN_FLIGHT), so a pass makes at most about 200 door calls here. */
export const CLIP_SWEEP_PAGE = 5;

/** Statuses a clip job row never leaves. Mirrors core's TERMINAL_STATUSES (renders-db). */
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "TIMED_OUT"] as const;

export interface ClipSweepResult {
  total: number;
  listed: number;
  advanced: number;
  busy: number;
  not_standalone: number;
  missing: number;
  failed: number;
}

/** Non-terminal clip job rows, oldest submission first, one page. */
export async function listUnresolvedClipJobs(env: StudioEnv, limit: number, offset: number): Promise<{ ids: string[]; total: number }> {
  const terminal = TERMINAL.map(() => "?").join(", ");
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM renders WHERE job_id LIKE 'clips-%' AND status NOT IN (${terminal})`,
  ).bind(...TERMINAL).first<{ n: number }>();
  const res = await env.DB.prepare(
    `SELECT job_id FROM renders WHERE job_id LIKE 'clips-%' AND status NOT IN (${terminal})
       ORDER BY submitted_at ASC, id ASC LIMIT ? OFFSET ?`,
  ).bind(...TERMINAL, limit, offset).all<{ job_id: string }>();
  return { ids: (res.results ?? []).map((r) => String(r.job_id)).filter(Boolean), total: Number(count?.n ?? 0) };
}

/** One sweep pass over standalone clip jobs. Never throws for one job; counts what happened. */
export async function sweepStandaloneClipJobs(env: StudioEnv, now: number = Date.now()): Promise<ClipSweepResult> {
  const first = await listUnresolvedClipJobs(env, CLIP_SWEEP_PAGE, 0);
  const offset = rotatingOffset(first.total, CLIP_SWEEP_PAGE, Math.floor(now / 60_000));
  const page = offset === 0 ? first : await listUnresolvedClipJobs(env, CLIP_SWEEP_PAGE, offset);
  const out: ClipSweepResult = { total: page.total, listed: page.ids.length, advanced: 0, busy: 0, not_standalone: 0, missing: 0, failed: 0 };
  for (const id of page.ids) {
    try {
      // A clips-* row is written only for a standalone job; the marker is the proof, so check it.
      if (!(await isStandaloneClipJob(env, id))) { out.not_standalone += 1; continue; }
      const leased = await withClipJobLease(env, id, () => advanceClipJob(env, id), { ensureRow: () => ensureClipJobRow(env, id) });
      if (!leased.ran) { out.busy += 1; continue; }
      if (!leased.value) { out.missing += 1; continue; }
      await updateRenderFromView(env, clipJobToPollView(leased.value));
      out.advanced += 1;
    } catch (e) {
      out.failed += 1;
      console.warn(JSON.stringify({ ev: "clips.sweep_job_failed", job_id: id, reason: e instanceof Error ? e.message : String(e) }));
    }
  }
  console.log(JSON.stringify({ ev: "clips.sweep", ...out }));
  return out;
}
