// Best-effort durable record of a RunPod job a module worker submitted (cf#279).
//
// THE ONE HARD GUARANTEE: this helper never throws, never rejects, and never delays its caller by
// more than RUNPOD_JOB_LOG_TIMEOUT_MS. It is telemetry attached to a soft-degrade path, and a
// telemetry failure that converted a soft degrade into a hard failure would be strictly worse than
// the gap it closes. Every exit is a warn plus a return. tests/runpod-job-log.test.ts makes each
// failure mode fail on purpose (throwing prepare, throwing bind, rejecting run, hanging run, absent
// binding, non-Error throw) and asserts the caller still completes.
//
// WHY THE BINDING IS OPTIONAL. A module deployed without the D1 binding must still work: the studio
// runs in several shapes and a dangling binding is a deploy failure, not a degrade. But an absent
// binding must never be INDISTINGUISHABLE from a clean run, which is the exact failure shape cf#277
// is about, so absence warns with its own marker and the module /ready probe reports it as a boolean.
//
// CONTENT-FREE: the caller supplies a RunPod job id, a compile-time module name, an outcome from a
// closed union, and (on a fault) the backend error text bounded to DETAIL_MAX. Nothing here reads
// user input, and the RunPod endpoint id is deliberately not a column (see migrations/0014).

/** Terminal states we can observe from the module side. `submitted` is the open state. */
export type RunpodJobOutcome = "submitted" | "completed" | "backend-error" | "failed" | "gone";

export interface RunpodJobRecord {
  /** RunPod job id. The upsert key; a blank id is dropped (nothing to reconcile against later). */
  jobId: string;
  /** Module worker name, e.g. finish-upscale. A constant in the module, never user input. */
  module: string;
  outcome: RunpodJobOutcome;
  /** Submit time in ms (Date.now at submit, or the poll token). OPTIONAL: a legacy poll token
   *  carries no submit time, and that is stored as NULL rather than as the current time -- an
   *  unknown submit time must stay distinguishable from a known one. */
  submittedAtMs?: number;
  /** Backend error text on a fault outcome. Bounded to DETAIL_MAX before it reaches the statement. */
  detail?: string;
}

/** Same bound the module poll paths already apply to a backend error string. */
export const DETAIL_MAX = 160;

/** A D1 write on this path must not outlive a poll tick. Past this the write is abandoned, warned,
 *  and the caller proceeds; the row is lost, which is the correct trade for best-effort telemetry. */
export const RUNPOD_JOB_LOG_TIMEOUT_MS = 2000;

/**
 * Upsert keyed on job_id. The submit write lands `submitted` with terminal_at NULL; the first
 * terminal write fills outcome, detail and terminal_at.
 *
 * `WHERE runpod_job_log.terminal_at IS NULL` makes the FIRST terminal write win: a repeated poll
 * after a terminal state is a no-op rather than a rewrite, so the recorded outcome is the one the
 * chain actually acted on. A terminal write whose submit write was lost still INSERTs a complete row,
 * because the poll token carries the original submit time.
 */
export const RUNPOD_JOB_LOG_UPSERT =
  "INSERT INTO runpod_job_log (job_id, module, outcome, detail, submitted_at, terminal_at) " +
  "VALUES (?1, ?2, ?3, ?4, ?5, ?6) " +
  "ON CONFLICT(job_id) DO UPDATE SET " +
  "outcome = excluded.outcome, " +
  "detail = COALESCE(excluded.detail, runpod_job_log.detail), " +
  "terminal_at = excluded.terminal_at " +
  "WHERE runpod_job_log.terminal_at IS NULL";

function warn(message: string): void {
  // Marked so a sink can separate "telemetry did not record" from "nothing failed".
  console.warn("runpod-job-log: " + message);
}

/**
 * Record one RunPod job outcome. Best-effort by contract: resolves to void on every path.
 *
 * Pass the binding straight through; `undefined` is a supported argument, not a caller bug.
 */
export async function recordRunpodJob(
  db: D1Database | undefined,
  rec: RunpodJobRecord,
  nowMs: number = Date.now(),
): Promise<void> {
  try {
    if (!db) {
      warn("no D1 binding (module=" + rec.module + ", outcome=" + rec.outcome + ") -- job NOT recorded");
      return;
    }
    if (!rec.jobId) {
      warn("empty job id (module=" + rec.module + ", outcome=" + rec.outcome + ") -- nothing to key on");
      return;
    }
    const detail = rec.detail === undefined || rec.detail === null ? null : String(rec.detail).slice(0, DETAIL_MAX);
    const terminalAt = rec.outcome === "submitted" ? null : Math.floor(nowMs / 1000);
    const submittedAt = rec.submittedAtMs === undefined ? null : Math.floor(rec.submittedAtMs / 1000);
    // .then(ok, err) rather than a bare await: the write promise must never be able to reject, or a
    // rejection arriving after the timeout already won the race becomes an unhandled rejection.
    const write = db
      .prepare(RUNPOD_JOB_LOG_UPSERT)
      .bind(rec.jobId, rec.module, rec.outcome, detail, submittedAt, terminalAt)
      .run()
      .then(
        () => "ok" as const,
        (e: unknown) => {
          warn("write failed (module=" + rec.module + ", outcome=" + rec.outcome + "): " + describe(e));
          return "failed" as const;
        },
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), RUNPOD_JOB_LOG_TIMEOUT_MS);
    });
    try {
      if ((await Promise.race([write, expiry])) === "timeout") {
        warn("write exceeded " + RUNPOD_JOB_LOG_TIMEOUT_MS + "ms (module=" + rec.module + ", outcome=" + rec.outcome + ") -- abandoned");
      }
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch (e) {
    // Reached when prepare/bind throw SYNCHRONOUSLY, or db is not the shape we were handed.
    warn("unusable binding (module=" + rec.module + ", outcome=" + rec.outcome + "): " + describe(e));
  }
}

/** A thrown value is not necessarily an Error; a thrown string or undefined must not become a crash. */
function describe(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (typeof e === "string" && e) return e;
  return "unknown";
}
