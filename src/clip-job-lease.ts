// cf#1315: one advancer at a time for a standalone clip job.
//
// WHY. From vivijure-core 1.35.0 a clip job over CLIP_SUBMIT_BATCH shots is bought in claimed batches,
// and every batch after the first is bought by advanceClipJob, which is what GET /api/render/clips/:id
// runs. A film's clip job is advanced under the film advance lease, so its ticks never overlap. This
// route had no lease, and core's object store has no conditional put, so two polls that both read the
// doc before either batch claim landed could each buy the same batch.
//
// HOW. The film advance lease, keyed by the clip job id. It is a conditional UPDATE on the renders row
// (core film-advance-lease.ts), and since cf#1309 a standalone clip job HAS a renders row whose job_id
// is the clips id. So there is no new table, no new TTL and no second implementation: the same short
// lease, renewed while the tick runs, released by token.
//
// THE MISSING ROW. The lease fails OPEN when no row exists (a legacy, untracked job must not deadlock).
// A standalone job's row can be missing when the start's best-effort insert failed (#695). An open
// claim there would leave exactly the concurrent case this file closes, so the caller passes
// `ensureRow`: on a claim that won with no token, the row is written and the claim is asked again.
//
// WHAT IS NOT GUARDED. A film's clip job has no owner marker and no row of its own, so a poll of it
// through this route still fails open, as before. Its own driver is the film tick.
//
// For a second driver (the sweep in cf#1316): call withClipJobLease the same way and skip the job when
// it returns { ran: false }.

import type { ClipJob } from "@skyphusion-labs/vivijure-core/render-orchestrator";
import { clipJobDocKey } from "@skyphusion-labs/vivijure-core/film-model";
import {
  claimFilmAdvance,
  holdFilmAdvance,
  insertRender,
  releaseFilmAdvance,
  type FilmAdvanceClaim,
} from "@skyphusion-labs/vivijure-core/renders-db";

import type { StudioEnv } from "./orchestrator-env";
import { clipJobRowSeed } from "./clip-job-row";

export type ClipJobLeaseOutcome<T> = { ran: true; value: T } | { ran: false };

async function claimOrFailOpen(env: StudioEnv, jobId: string): Promise<FilmAdvanceClaim> {
  try {
    return await claimFilmAdvance(env, jobId);
  } catch (e) {
    // The film tick's posture: a lease that cannot be asked does not stop the work.
    console.warn(JSON.stringify({ ev: "clips.lease_unavailable", job_id: jobId, reason: e instanceof Error ? e.message : String(e) }));
    return { won: true };
  }
}

/**
 * Run `fn` only while this caller holds the clip job's lease. Returns { ran: false } when another
 * driver holds it, and never runs `fn` then.
 */
export async function withClipJobLease<T>(
  env: StudioEnv,
  jobId: string,
  fn: () => Promise<T>,
  opts: { ensureRow?: () => Promise<void> } = {},
): Promise<ClipJobLeaseOutcome<T>> {
  let claim = await claimOrFailOpen(env, jobId);
  if (claim.won && claim.token === undefined && opts.ensureRow) {
    await opts.ensureRow();
    claim = await claimOrFailOpen(env, jobId);
  }
  if (!claim.won) return { ran: false };
  const hold = holdFilmAdvance(env, jobId, claim);
  try {
    return { ran: true, value: await fn() };
  } finally {
    hold.stop();
    if (claim.token !== undefined) {
      await releaseFilmAdvance(env, jobId, claim.token).catch((e: unknown) => {
        // Not fatal: the lease expires on its own within its TTL.
        console.warn(JSON.stringify({ ev: "clips.lease_release_failed", job_id: jobId, reason: e instanceof Error ? e.message : String(e) }));
      });
    }
  }
}

/** The clip job doc as stored, without advancing it. Null when there is none. */
export async function readClipJobDoc(env: StudioEnv, jobId: string): Promise<ClipJob | null> {
  const obj = await env.R2_RENDERS.get(clipJobDocKey(jobId));
  if (!obj) return null;
  return JSON.parse(await obj.text()) as ClipJob;
}

/** Write a standalone job's renders row if it is missing, so its lease has a row to hold. */
export async function ensureClipJobRow(env: StudioEnv, jobId: string): Promise<void> {
  const job = await readClipJobDoc(env, jobId);
  if (job) await insertRender(env, clipJobRowSeed(job)); // false on conflict: the row was already there
}
