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

/**
 * Terminal states we can observe from the module side. `submitted` is the open state.
 *
 * `cancelled` (cf#298) was added for a state RunPod ACTUALLY REPORTS and which this table previously
 * could not express at all: a job whose /status returns CANCELLED. Observed live -- job
 * dcbaaa55-d64d-4f0b-8a4a-002b149c99cc-e2 ran to completion, wrote its keyframe to R2, and RunPod
 * booked it CANCELLED; the poll path fell through to "not COMPLETED yet", no terminal write was ever
 * ATTEMPTED, and the row is stuck at `submitted` permanently. It also has a denominator consequence:
 * the endpoint health counters exclude CANCELLED, and the modules produce it deliberately (the F17
 * spend-leak cancel and the core cancel path), so without this value a deliberately-cancelled job is
 * neither a success nor a failure nor an open job -- it is simply missing from the arithmetic.
 *
 * READ THIS BEFORE ASSUMING cf#286 WAS OVERRULED. cf#286 and cf#288 both explicitly REFUSED a
 * `cancelled` value, and they were right about what they were refusing: it was proposed there as the
 * home for a DELIBERATE REFUSAL, and a refusal never becomes CANCELLED (a raise inside the handler
 * propagates and the SDK books the job FAILED), so it would have named the wrong thing and never
 * fired for its stated purpose. That reasoning is untouched. Refusals are discriminated by
 * `error_type` (cf#288, below), NOT by this value. This value names an observed RunPod terminal
 * status and nothing else.
 */
export type RunpodJobOutcome = "submitted" | "completed" | "backend-error" | "failed" | "gone" | "cancelled";

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
  /** Machine label for the fault CLASS (cf#288), e.g. HarnessError. Bounded to ERROR_TYPE_MAX.
   *  OMIT IT rather than passing a placeholder when the endpoint did not report one: NULL means
   *  "not told", which must stay distinguishable from "told, and it was not a refusal". */
  errorType?: string;
  /** RunPod's OWN execution time in ms, from the `/status` envelope. NULL when RunPod did not report
   *  it -- never 0. See `timingFromStatus`, which is the only thing that should produce this. */
  executionMs?: number | null;
  /** RunPod's OWN delay time in ms. Queue wait AND cold start together; the two are not separable
   *  from this field and only one of them is billed as compute. NULL when not reported, never 0. */
  delayMs?: number | null;
}

/** The timing half of a `/status` envelope, in the shape the record spreads in. */
export interface RunpodJobTiming {
  executionMs: number | null;
  delayMs: number | null;
}

/**
 * Read RunPod's own timing out of a `/status` envelope, or report that it was not there.
 *
 * NULL-NOT-ZERO IS ENFORCED HERE, once, so no caller can reintroduce a zero. This mirrors the
 * plane-side rule in vivijure-control-plane `src/runpod-proxy.ts` deliberately rather than inventing
 * a second convention for the same fact: a CANCELLED job's payload carries neither field at all, and
 * a 0 would read as a real measurement of a job that took no time and under-count every total.
 *
 * ALWAYS returns an object so callers can spread it unconditionally. A caller with no envelope in
 * hand (the 404 `gone` path) must simply not call this, rather than passing something empty: an
 * absent call and a call that found nothing both land NULL, which is the same honest answer.
 *
 * A REPORTED ZERO IS KEPT AS ZERO. The rule is that ABSENT becomes NULL, not that zero is forbidden:
 * a vendor saying "this took 0 ms" is a measurement, and rewriting it to NULL would destroy the very
 * distinction this function exists to preserve, just pointed the other way.
 *
 * ONE DELIBERATE DIVERGENCE from the plane-side twin, flagged so it does not read as drift: this
 * rejects NEGATIVE values, which the plane's version accepts because `Number.isFinite(-1)` is true.
 * A negative duration is not a measurement, it is corruption, and NULL is the honest answer for it.
 * The divergence is one comparison and it is strictly the safer direction; if the two are ever
 * unified, unify on this one.
 */
export function timingFromStatus(status: unknown): RunpodJobTiming {
  if (!status || typeof status !== "object") return { executionMs: null, delayMs: null };
  const s = status as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : null;
  return { executionMs: num(s.executionTime), delayMs: num(s.delayTime) };
}

/**
 * Bound on `detail` (cf#320). Was 160: short enough that a validation refusal's actionable tail
 * (the path prefix that was wrong, the project that was expected) was exactly what got cut. Measured
 * live: `HarnessError: preview: bundle_key: ... must belong to project 'lighthouse_smoke2b'...`
 * lost the diagnosis and forced an out-of-band RunPod status lookup that may have aged out.
 *
 * 480 still bounds operator-controlled strings; validation messages that ARE the diagnosis fit.
 * Truncation is always visible (see `boundDetail`) so a reader never mistakes a cut string for the
 * whole error.
 */
export const DETAIL_MAX = 480;

/** Marker appended when detail is cut. ASCII only; total length stays DETAIL_MAX. */
export const DETAIL_TRUNCATION_MARKER = "...";

/**
 * Bound a detail string to DETAIL_MAX. When cut, the last characters are DETAIL_TRUNCATION_MARKER
 * so truncation is visible (cf#320). Null/undefined stay null.
 */
export function boundDetail(detail: string | undefined | null): string | null {
  if (detail === undefined || detail === null) return null;
  const s = String(detail);
  if (s.length <= DETAIL_MAX) return s;
  const keep = DETAIL_MAX - DETAIL_TRUNCATION_MARKER.length;
  return s.slice(0, keep) + DETAIL_TRUNCATION_MARKER;
}

/** A class name, not prose. Generous enough for a fully-qualified python class, short enough that a
 *  vendor deciding to put a sentence in this key cannot widen the row. */
export const ERROR_TYPE_MAX = 80;

/** A D1 write on this path must not outlive a poll tick. Past this the write is abandoned, warned,
 *  and the caller proceeds; the row is lost, which is the correct trade for best-effort telemetry.
 *  This bound covers the retry too (see RUNPOD_JOB_LOG_RETRY_DELAY_MS), so the caller's worst case
 *  is unchanged from before the retry existed. */
export const RUNPOD_JOB_LOG_TIMEOUT_MS = 2000;

/** cf#298: one bounded retry on a failed write, INSIDE the existing timeout budget.
 *
 *  WHY. The terminal write happens on the module POLL path. Once the core advances past that phase
 *  nothing polls the job again, so a terminal write lost to a transient D1 error is lost
 *  PERMANENTLY: the row stays `submitted` and reads as an in-flight job forever. Measured at 2 of 20
 *  module jobs in a run with zero actual faults, i.e. a perfect run presenting as 10% unexplained.
 *
 *  WHAT THIS DOES NOT DO, stated plainly so nobody reads cf#298 as closed. This reduces the window;
 *  it does not remove it. A D1 outage longer than the budget still loses the row, and nothing here
 *  revisits a row after the fact. The real fix is a reconciler that re-asks RunPod for rows with
 *  terminal_at IS NULL, and it has a hard constraint: RunPod keeps async results for ~30 minutes and
 *  has no job-history API, so a reconciler running later than that cannot learn the outcome at all
 *  and must record `unknown` honestly rather than guess. That is filed separately, not done here.
 *
 *  The retry is safe to repeat: the upsert is keyed on job_id and guarded by
 *  `WHERE runpod_job_log.terminal_at IS NULL`, so a second attempt that lands after a first one
 *  actually succeeded is a no-op rather than a rewrite. */
export const RUNPOD_JOB_LOG_RETRY_DELAY_MS = 150;

/**
 * Upsert keyed on job_id. The submit write lands `submitted` with terminal_at NULL; the first
 * terminal write fills outcome, detail, error_type and terminal_at.
 *
 * `WHERE runpod_job_log.terminal_at IS NULL` makes the FIRST terminal write win: a repeated poll
 * after a terminal state is a no-op rather than a rewrite, so the recorded outcome is the one the
 * chain actually acted on. A terminal write whose submit write was lost still INSERTs a complete row,
 * because the poll token carries the original submit time.
 *
 * error_type uses the same COALESCE as detail: a later write that carries no class must not erase a
 * class an earlier write established.
 */
export const RUNPOD_JOB_LOG_UPSERT =
  "INSERT INTO runpod_job_log (job_id, module, outcome, detail, submitted_at, terminal_at, error_type, execution_ms, delay_ms) " +
  "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9) " +
  "ON CONFLICT(job_id) DO UPDATE SET " +
  "outcome = excluded.outcome, " +
  "detail = COALESCE(excluded.detail, runpod_job_log.detail), " +
  "error_type = COALESCE(excluded.error_type, runpod_job_log.error_type), " +
  // Same COALESCE as detail and error_type, for the same reason: a later write carrying no timing
  // must not erase timing an earlier one established. The terminal_at guard already makes the first
  // terminal write win, so this is belt-and-braces rather than the primary mechanism.
  "execution_ms = COALESCE(excluded.execution_ms, runpod_job_log.execution_ms), " +
  "delay_ms = COALESCE(excluded.delay_ms, runpod_job_log.delay_ms), " +
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
    const detail = boundDetail(rec.detail);
    const errorType =
      rec.errorType === undefined || rec.errorType === null || rec.errorType === ""
        ? null
        : String(rec.errorType).slice(0, ERROR_TYPE_MAX);
    // NULL-not-zero again at the boundary, so a caller that hand-built a record rather than using
    // timingFromStatus still cannot write a 0 that means "not reported".
    const nonNegative = (v: number | null | undefined): number | null =>
      typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.round(v) : null;
    const executionMs = nonNegative(rec.executionMs);
    const delayMs = nonNegative(rec.delayMs);
    const terminalAt = rec.outcome === "submitted" ? null : Math.floor(nowMs / 1000);
    const submittedAt = rec.submittedAtMs === undefined ? null : Math.floor(rec.submittedAtMs / 1000);
    // .then(ok, err) rather than a bare await: the write promise must never be able to reject, or a
    // rejection arriving after the timeout already won the race becomes an unhandled rejection.
    const attempt = (): Promise<"ok" | "failed"> =>
      db
        .prepare(RUNPOD_JOB_LOG_UPSERT)
        .bind(rec.jobId, rec.module, rec.outcome, detail, submittedAt, terminalAt, errorType, executionMs, delayMs)
        .run()
        .then(
          () => "ok" as const,
          (e: unknown) => {
            warn("write failed (module=" + rec.module + ", outcome=" + rec.outcome + "): " + describe(e));
            return "failed" as const;
          },
        );
    // cf#298: a lost terminal write never reconciles, so spend one bounded retry on it. Still one
    // race against ONE timer, so the caller's worst-case delay is unchanged.
    const write: Promise<"ok" | "failed"> = attempt().then(async (first) => {
      if (first === "ok") return "ok" as const;
      await new Promise<void>((resolve) => setTimeout(resolve, RUNPOD_JOB_LOG_RETRY_DELAY_MS));
      const second = await attempt();
      if (second !== "ok") {
        warn("write failed twice (module=" + rec.module + ", outcome=" + rec.outcome + ") -- row NOT recorded");
      }
      return second;
    });
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
// FAULT CLASS EXTRACTION (cf#288): read a STRUCTURED key, or read nothing.
//
// The RunPod /status `error` field for a vivijure-backend fault is a JSON STRING whose first key is
// `error_type`, e.g. "<class 'vivijure_backend.harness.handler.HarnessError'>". That class is the
// only thing separating a DELIBERATE REFUSAL from an OOM: both arrive as RunPod FAILED and both are
// written as outcome `failed`. Today it survives only inside `detail`, which is truncated at 160
// chars, and it survives only because `error_type` happens to be the first key emitted -- 87
// characters of headroom against a vendor reordering its own JSON, with a silent failure mode.
//
// THE THREE SATELLITE ENDPOINTS EMIT NO error_type AT ALL. musetalk, video-upscale and
// audio-upscale return a bare string in `error` for BOTH a validation refusal and a genuine crash:
//
//     return {"ok": False, "error": "lipsync needs both clip_key and audio_key"}   # refusal
//     except Exception as e: return {"ok": False, "error": str(e)[:500]}           # crash
//
// So this parser returns undefined for three of the four endpoints we submit to, and their rows
// carry NULL. That is the honest answer and it is deliberately NOT papered over: an extractor that
// fell back to matching the English message would classify those endpoints by prose, which is a
// parser only as fresh as the sample it was built from, and would make the classification LOOK
// solved on a surface where it is not. Fixing the satellites means the containers emitting a
// structured marker, which is a vivijure-musetalk / -upscale / -audio-upscale change, filed
// separately.
// ---------------------------------------------------------------------------------------------

/** Unwraps python's repr of a class object. "<class 'a.b.C'>" -> "C". Anything else is returned as
 *  given, so a plain class name from a future producer passes through unharmed. */
function normalizeClassName(raw: string): string {
  const m = /^<class\s+'([^']+)'>$/.exec(raw.trim());
  const qualified = m ? m[1] : raw.trim();
  const leaf = qualified.slice(qualified.lastIndexOf(".") + 1);
  return leaf || qualified;
}

/**
 * Extract the fault CLASS from a RunPod /status error field.
 *
 * Accepts the payload in the shapes it actually arrives in: an object, or a JSON string holding an
 * object. Returns undefined when there is no structured `error_type` key -- including for a bare
 * error string, which is the satellite containers' shape. NEVER derives a class from the message.
 */
export function parseRunpodErrorType(err: unknown): string | undefined {
  let obj: unknown = err;
  if (typeof err === "string") {
    try {
      obj = JSON.parse(err);
    } catch {
      // A bare error string carries no class. Saying so is the point; guessing one is the trap.
      return undefined;
    }
  }
  if (!obj || typeof obj !== "object") return undefined;
  const raw = (obj as { error_type?: unknown }).error_type;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  return normalizeClassName(raw).slice(0, ERROR_TYPE_MAX);
}

// ---------------------------------------------------------------------------------------------
// TERMINAL STATUSES THE POLL PATH USED TO WALK PAST (cf#298).
//
// The module poll paths test COMPLETED and FAILED, then treat everything else as "still running".
// RunPod also reports CANCELLED and TIMED_OUT, both of which are TERMINAL: the job will never
// advance, no further poll can learn anything new, and the row stays `submitted` forever because no
// terminal write is ever ATTEMPTED. That is a different bug from a terminal write being LOST, and a
// retry cannot touch it.
//
// SCOPE, deliberately narrow: this classifies for the RECORDER only. Callers record the outcome and
// then leave their existing render-path behaviour EXACTLY as it was. Telemetry must never gate the
// render path, and there is a live counter-example to changing it here: the CANCELLED job in cf#298
// had already written its artifact to R2 and the film consumed it, so failing a shot on CANCELLED
// would break a path that works today. What the chain should DO about a terminal-cancelled job is a
// render-path question with its own evidence requirement, filed separately.
// ---------------------------------------------------------------------------------------------

/**
 * Map a RunPod status that the poll paths otherwise walk past onto the outcome that names it.
 * Returns undefined for COMPLETED, FAILED (both already handled by every caller) and for the
 * genuinely non-terminal statuses (IN_QUEUE, IN_PROGRESS), so a caller can use it as a guard.
 */
export function runpodWalkedPastOutcome(status: string | undefined): RunpodJobOutcome | undefined {
  switch (status) {
    case "CANCELLED":
      return "cancelled";
    // A job killed by the endpoint execution timeout is a genuine infra failure, and `failed` is
    // where infra failures already live. It is NOT given its own outcome value: unlike CANCELLED it
    // has not been observed on our endpoints, and a vocabulary member added on speculation is
    // harder to remove later than one added on evidence (cf#286's standing objection).
    case "TIMED_OUT":
      return "failed";
    default:
      return undefined;
  }
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
