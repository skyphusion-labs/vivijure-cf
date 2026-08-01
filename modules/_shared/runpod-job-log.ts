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

// ---------------------------------------------------------------------------------------------
// READINESS (cf#284): can this worker actually RECORD, not merely is a binding attached.
//
// GET /ready used to report Boolean(env.TELEMETRY_DB), which is the presence of the BINDING. A
// worker bound to a real database where runpod_job_log does not exist reported job_log:true while
// being structurally incapable of writing a row, and that is not hypothetical: it was observed in
// the v1.13.0 pre-tag smoke, with a job running to completion while both writes failed. A probe that
// cannot distinguish a missing table from a working one reintroduces, one layer up, the exact defect
// the job log exists to end -- an empty log being indistinguishable from a clean run.
//
// THREE STATES, NOT A BOOLEAN, and that is the whole point. A boolean has nowhere to put I COULD NOT
// TELL, so it answers it as one of the two real states, and the safe-looking one is the lie:
//
//   ok           a read against runpod_job_log succeeded: the table is there and reachable
//   unavailable  DEFINITIVELY cannot record: no binding at all, or the table does not exist
//   unknown      the probe itself could not answer (the read threw, or it outran the timeout)
//
// unknown is NOT ok. An operator reading unknown knows the probe failed; an operator reading a true
// that was produced by a failed probe knows nothing and believes something.
//
// WHY A READ AND NOT A WRITE. A readiness probe must not leave litter, and a probe that inserts a row
// would put fabricated jobs in the very table operators query for real ones. A read costs one round
// trip on a path that was previously free, which is the tradeoff cf#284 raised: taken deliberately,
// because /ready is called before flipping a tenant live, and a free answer to the wrong question is
// worth less than a cheap answer to the right one.
//
// HONEST LIMIT, stated because the name invites more than it proves: this establishes the table is
// READABLE, not that an INSERT would succeed. A read-only replica or a constraint failure would
// still report ok. It closes the observed hole (missing table) and does not claim to close every one.
//
// WHY NOT CLASSIFY THE ERROR TEXT. Reading no such table out of an error message would be a parser
// only as fresh as the vendor string it was built from. sqlite_master answers the same question
// structurally: a row or no row, nothing to match. The distinction is decided by data, not by prose.
export type JobLogReadiness = "ok" | "unavailable" | "unknown";

/** Tighter than the write bound: /ready is an interactive probe, and a slow answer is a bad one. */
export const JOB_LOG_PROBE_TIMEOUT_MS = 1500;

/** Existence by DATA, not by error text: a row means the table is there, no row means it is not. */
export const JOB_LOG_TABLE_PROBE = "SELECT name FROM sqlite_master WHERE type = ?1 AND name = ?2";

/**
 * Probe whether this worker could record a job outcome. Never throws, never rejects, and never
 * outlives JOB_LOG_PROBE_TIMEOUT_MS: the same discipline as the writer, for the same reason. A
 * readiness endpoint that can fail the module it reports on is worse than no readiness endpoint.
 */
export async function probeRunpodJobLog(
  db: D1Database | undefined,
  timeoutMs: number = JOB_LOG_PROBE_TIMEOUT_MS,
): Promise<JobLogReadiness> {
  // No binding is not a measurement failure, it is a definitive answer: nothing to write through.
  if (!db) return "unavailable";
  try {
    const read = db
      .prepare(JOB_LOG_TABLE_PROBE)
      .bind("table", "runpod_job_log")
      .first<{ name?: string }>()
      .then(
        (row): JobLogReadiness => (row && typeof row.name === "string" ? "ok" : "unavailable"),
        (): JobLogReadiness => "unknown",
      );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expiry = new Promise<JobLogReadiness>((resolve) => {
      timer = setTimeout(() => resolve("unknown"), timeoutMs);
    });
    try {
      return await Promise.race([read, expiry]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  } catch {
    // prepare/bind threw synchronously, or the binding is not the shape we were handed.
    return "unknown";
  }
}
