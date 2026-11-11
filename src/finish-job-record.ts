// cf#784: keep a running finish job awake, and keep a finished job's answer, from the Durable Object.
//
// THE TWO GAPS. (1) /async/finish returns at once, so no request is in flight while the encode runs, and
// only requests renew the container's sleepAfter timer. A job that outlives the timer was put to sleep
// under itself, and the next poll found nothing. (2) Job state is the container's process memory, so a
// finished job's result was lost with the process: a container that slept or restarted before core read
// the result answered not_found, and core had to fall back to adopting the R2 artifact.
//
// THE MECHANISM, all in the Durable Object in front of the container (src/finish-container.ts):
//   * When the timer runs out (`onActivityExpired`), the object asks the container for each job it saw
//     accepted and has not seen finish. A job still pending, or a probe that cannot tell, HOLDS the
//     instance awake. A hold is capped at core's phase deadline: past it core has failed the phase anyway.
//   * Every terminal status the object sees, from core's poll or from its own probe, is RECORDED in
//     Durable Object storage. A later status read for that job is answered from the record, before the
//     container is reached, so the answer survives a container restart or sleep and a poll never wakes a
//     container just to hear not_found.
// Nothing about the module contract or core's FilmFinishInput changes: the object already sees every
// submit and every status exchange.
import { PHASE_HARD_DEADLINE_SECONDS } from "@skyphusion-labs/vivijure-core/film-model";
import type { FinishJobTail } from "./finish-job-tail";

/** Longest the object holds an instance awake for one job: core fails a phase with no progress past this. */
export const FINISH_JOB_HOLD_MAX_MS = PHASE_HARD_DEADLINE_SECONDS * 1000;
/** How long a terminal record is kept. Matches the container's own JOB_TTL_S. */
export const FINISH_JOB_RECORD_TTL_MS = 60 * 60 * 1000;

const KEY_PREFIX = "finish-job:";

/** What one status probe of the container said about a job. */
export type ProbeStatus = "pending" | "terminal" | "not_found" | "unknown";

export interface JobRecord {
  status: "completed" | "failed";
  result?: unknown;
  error?: string;
  at: number;
}

/** The slice of DurableObjectStorage this uses, so a Map-backed fake can stand in. */
export interface RecordStorage {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}

/** Terminal results the object has seen, keyed by job id, in Durable Object storage. */
export class FinishJobRecords {
  constructor(private readonly storage: RecordStorage) {}

  async get(jobId: string, now = Date.now()): Promise<JobRecord | undefined> {
    const r = await this.storage.get<JobRecord>(KEY_PREFIX + jobId);
    if (!r) return undefined;
    if (now - r.at > FINISH_JOB_RECORD_TTL_MS) {
      await this.storage.delete(KEY_PREFIX + jobId);
      return undefined;
    }
    return r;
  }

  /** Record a terminal body. Anything that is not a terminal status is ignored. Prunes expired records. */
  async recordBody(jobId: string, body: { status?: unknown; result?: unknown; error?: unknown }, now = Date.now()): Promise<boolean> {
    if (body.status !== "completed" && body.status !== "failed") return false;
    const rec: JobRecord = { status: body.status, at: now };
    if (body.status === "completed") rec.result = body.result;
    else rec.error = typeof body.error === "string" ? body.error : "job failed";
    await this.storage.put(KEY_PREFIX + jobId, rec);
    for (const [key, r] of await this.storage.list<JobRecord>({ prefix: KEY_PREFIX })) {
      if (now - r.at > FINISH_JOB_RECORD_TTL_MS) await this.storage.delete(key);
    }
    return true;
  }
}

/** The status body a recorded job is answered with: the container's own shape, plus `recorded: true`. */
export function recordedStatusBody(rec: JobRecord): Record<string, unknown> {
  return rec.status === "completed"
    ? { ok: true, status: "completed", result: rec.result, recorded: true }
    : { ok: true, status: "failed", error: rec.error ?? "job failed", recorded: true };
}

/**
 * Decide, when the idle timer runs out, whether to hold the instance awake. Pure.
 *
 * Holds while any job the tail still has open is pending, or could not be read, and was opened less than
 * `maxHoldMs` ago. A job the container no longer knows is marked lost on the tail. A terminal job is not a
 * reason to hold: its result is recorded and will be answered from the record.
 */
export function expiryVerdict(
  tail: FinishJobTail,
  probes: ReadonlyMap<string, ProbeStatus>,
  now: number,
  maxHoldMs = FINISH_JOB_HOLD_MAX_MS,
): "hold" | "release" {
  let hold = false;
  for (const [jobId, status] of probes) {
    if (status === "not_found") {
      tail.lost(jobId);
      continue;
    }
    if (status !== "pending" && status !== "unknown") continue;
    const opened = tail.openedAt(jobId);
    if (opened !== undefined && now - opened < maxHoldMs) hold = true;
  }
  return hold ? "hold" : "release";
}

/** Read one probe response as a ProbeStatus. Never throws. */
export async function probeStatusOf(resp: Response): Promise<{ status: ProbeStatus; body?: Record<string, unknown> }> {
  let body: Record<string, unknown>;
  try {
    body = (await resp.clone().json()) as Record<string, unknown>;
  } catch {
    return { status: "unknown" };
  }
  if (resp.status === 404 && body.status === "not_found") return { status: "not_found", body };
  if (!resp.ok) return { status: "unknown", body };
  if (body.status === "pending") return { status: "pending", body };
  if (body.status === "completed" || body.status === "failed") return { status: "terminal", body };
  return { status: "unknown", body };
}
