// cf#279: the module-side RunPod job log. These tests exist to make the ONE hard guarantee fail on
// purpose: the write is best-effort and must never throw, reject, or stall the degrade path it is
// attached to. Every failure mode below is exercised through a caller that returns a value AFTER
// awaiting the helper, so a broken guarantee shows up as a missing return rather than as a green
// assertion about the helper in isolation.
//
// The SQL itself is not proven here. A fake D1 accepts any string, so a statement exercised only
// through a fake is untested; migrations/0014 and this upsert were run against a real D1
// (wrangler d1 execute --local) and the helper was driven against a real binding in wrangler dev.
// See docs/runpod-job-log.md.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  recordRunpodJob,
  RUNPOD_JOB_LOG_UPSERT,
  RUNPOD_JOB_LOG_TIMEOUT_MS,
  DETAIL_MAX,
  ERROR_TYPE_MAX,
  parseRunpodErrorType,
  runpodWalkedPastOutcome,
  terminalOutcomeFromRunpodStatus,
  reconcileOpenRunpodJobs,
  LIST_OPEN_RUNPOD_JOBS_SQL,
  RECONCILE_MIN_AGE_SEC,
  RECONCILE_UNKNOWN_AFTER_SEC,
} from "../modules/_shared/runpod-job-log";

/** Records every prepare/bind/run call. `run` is injectable so a test can make the real failure. */
function recordingDb(run: () => Promise<unknown> = async () => ({ success: true })) {
  const calls: { sql: string[]; bound: unknown[][] } = { sql: [], bound: [] };
  const db = {
    prepare(sql: string) {
      calls.sql.push(sql);
      return {
        bind(...args: unknown[]) {
          calls.bound.push(args);
          return { run };
        },
      };
    },
  } as unknown as D1Database;
  return { db, calls };
}

/** Stands in for a module poll path: record, then return what the chain acts on. */
async function degradePath(db: D1Database | undefined, outcome: "submitted" | "backend-error" = "backend-error"): Promise<string> {
  await recordRunpodJob(db, { jobId: "job-1", module: "finish-upscale", outcome, submittedAtMs: 1_700_000_000_000, detail: "boom" }, 1_700_000_060_000);
  return "degrade-completed";
}

let warns: string[] = [];
beforeEach(() => {
  warns = [];
  vi.spyOn(console, "warn").mockImplementation((m: unknown) => { warns.push(String(m)); });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("recordRunpodJob: what it writes", () => {
  it("binds the row the migration declares, in order, with ms converted to unix seconds", async () => {
    const { db, calls } = recordingDb();
    await recordRunpodJob(db, { jobId: "job-1", module: "finish-upscale", outcome: "backend-error", submittedAtMs: 1_700_000_000_000, detail: "boom" }, 1_700_000_060_000);
    // CONTROL: the proxy records at all. Without this, every assertion below passes on a dead proxy.
    expect(calls.sql).toHaveLength(1);
    expect(calls.sql[0]).toBe(RUNPOD_JOB_LOG_UPSERT);
    expect(calls.bound[0]).toEqual(["job-1", "finish-upscale", "backend-error", "boom", 1_700_000_000, 1_700_000_060, null]);
  });

  it("leaves terminal_at NULL on the submit row and fills it on a terminal row", async () => {
    const open = recordingDb();
    await recordRunpodJob(open.db, { jobId: "j", module: "m", outcome: "submitted", submittedAtMs: 1_700_000_000_000 }, 1_700_000_060_000);
    expect(open.calls.bound[0][5]).toBeNull();
    const closed = recordingDb();
    await recordRunpodJob(closed.db, { jobId: "j", module: "m", outcome: "completed", submittedAtMs: 1_700_000_000_000 }, 1_700_000_060_000);
    expect(closed.calls.bound[0][5]).toBe(1_700_000_060);
  });

  it("binds NULL rather than the string undefined when there is no detail", async () => {
    const { db, calls } = recordingDb();
    await recordRunpodJob(db, { jobId: "j", module: "m", outcome: "completed", submittedAtMs: 0 });
    expect(calls.bound[0][3]).toBeNull();
  });

  it("binds NULL submit time rather than inventing one when a legacy poll token carried none", async () => {
    const { db, calls } = recordingDb();
    await recordRunpodJob(db, { jobId: "j", module: "m", outcome: "gone" }, 1_700_000_060_000);
    expect(calls.bound[0][4]).toBeNull();
    // CONTROL: the same call WITH a submit time binds it, so the NULL above is the absent case and
    // not a helper that never binds this column at all.
    const known = recordingDb();
    await recordRunpodJob(known.db, { jobId: "j", module: "m", outcome: "gone", submittedAtMs: 1_700_000_000_000 }, 1_700_000_060_000);
    expect(known.calls.bound[0][4]).toBe(1_700_000_000);
  });

  it("bounds detail to DETAIL_MAX so an unbounded backend error cannot widen the row", async () => {
    const { db, calls } = recordingDb();
    await recordRunpodJob(db, { jobId: "j", module: "m", outcome: "failed", submittedAtMs: 0, detail: "x".repeat(5000) });
    expect(String(calls.bound[0][3])).toHaveLength(DETAIL_MAX);
  });
});

describe("recordRunpodJob: the best-effort guarantee, made to fail on purpose", () => {
  it("survives a run() that REJECTS (the real D1 error shape) and the caller still completes", async () => {
    const { db } = recordingDb(async () => { throw new Error("D1_ERROR: no such table: runpod_job_log"); });
    await expect(degradePath(db)).resolves.toBe("degrade-completed");
    expect(warns.join("|")).toContain("write failed");
    expect(warns.join("|")).toContain("no such table");
  });

  it("survives a prepare() that throws SYNCHRONOUSLY", async () => {
    const db = { prepare() { throw new Error("prepare exploded"); } } as unknown as D1Database;
    await expect(degradePath(db)).resolves.toBe("degrade-completed");
    expect(warns.join("|")).toContain("unusable binding");
  });

  it("survives a bind() that throws (wrong parameter count is the classic)", async () => {
    const db = { prepare: () => ({ bind() { throw new Error("bind exploded"); } }) } as unknown as D1Database;
    await expect(degradePath(db)).resolves.toBe("degrade-completed");
    expect(warns.join("|")).toContain("unusable binding");
  });

  it("survives a NON-Error throw (a bare string) without producing undefined in the warn", async () => {
    const { db } = recordingDb(async () => { throw "just a string"; });
    await expect(degradePath(db)).resolves.toBe("degrade-completed");
    expect(warns.join("|")).toContain("just a string");
    expect(warns.join("|")).not.toContain("undefined");
  });

  it("survives a db that is not the shape we were handed at all", async () => {
    await expect(degradePath({} as unknown as D1Database)).resolves.toBe("degrade-completed");
    expect(warns.join("|")).toContain("unusable binding");
  });

  it("does not stall the caller when the write HANGS: abandons it at the timeout", async () => {
    vi.useFakeTimers();
    try {
      const { db } = recordingDb(() => new Promise(() => { /* never settles */ }));
      const pending = degradePath(db);
      let settled = false;
      void pending.then(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(RUNPOD_JOB_LOG_TIMEOUT_MS - 1);
      expect(settled).toBe(false);           // CONTROL: it really was still waiting
      await vi.advanceTimersByTimeAsync(2);
      await expect(pending).resolves.toBe("degrade-completed");
      expect(warns.join("|")).toContain("abandoned");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("recordRunpodJob: absence must not read as a clean run", () => {
  it("warns with its own marker when there is no D1 binding", async () => {
    await expect(degradePath(undefined)).resolves.toBe("degrade-completed");
    expect(warns.join("|")).toContain("no D1 binding");
  });

  it("drops a blank job id rather than writing a row nothing can be reconciled against", async () => {
    const { db, calls } = recordingDb();
    await recordRunpodJob(db, { jobId: "", module: "m", outcome: "failed", submittedAtMs: 0 });
    expect(calls.sql).toHaveLength(0);
    expect(warns.join("|")).toContain("empty job id");
  });
});

// ------------------------------------------------------------------------------------------------
// cf#288: the fault CLASS is read from a STRUCTURED key or it is not read at all.
//
// The measured payload below is the real one from a deliberate refusal against the prod backend
// endpoint during cf#278 phase 1 (job 07f9e72b-cd0d-4012-8216-007b440dbd51-e1, finish_clip with no
// clip_key). It is kept verbatim rather than paraphrased because the whole point of this column is
// that the classification must not depend on where in that blob the class happens to sit.
// ------------------------------------------------------------------------------------------------
const MEASURED_REFUSAL_ERROR = JSON.stringify({
  error_type: "<class 'vivijure_backend.harness.handler.HarnessError'>",
  error_message: "finish_clip: clip_key is required",
  error_traceback: "Traceback (most recent call last):\n" + "  File \"/app/handler.py\", line 1, in <module>\n".repeat(12),
  hostname: "runpod-worker-9zjije5t9aqrhl",
  worker_id: "9zjije5t9aqrhl",
  runpod_version: "1.11.0",
});

describe("parseRunpodErrorType", () => {
  it("extracts the class from the measured refusal payload and unwraps python's class repr", () => {
    expect(parseRunpodErrorType(MEASURED_REFUSAL_ERROR)).toBe("HarnessError");
  });

  it("does not depend on error_type being the FIRST key, which is the entire reason for the column", () => {
    // Today the class survives inside the 160-char `detail` only because RunPod emits error_type
    // first, with 87 characters of headroom. Nothing in our code or their contract establishes that.
    const reordered = JSON.stringify({
      hostname: "x".repeat(200),
      error_message: "finish_clip: clip_key is required",
      runpod_version: "1.11.0",
      error_type: "<class 'vivijure_backend.harness.handler.HarnessError'>",
    });
    expect(reordered.length).toBeGreaterThan(DETAIL_MAX); // CONTROL: `detail` would have lost it
    expect(reordered.indexOf("HarnessError")).toBeGreaterThan(DETAIL_MAX);
    expect(parseRunpodErrorType(reordered)).toBe("HarnessError");
  });

  it("REFUSES to invent a class from a bare error string (the three satellite endpoints)", () => {
    // musetalk / video-upscale / audio-upscale return a bare string for BOTH a validation refusal
    // and a genuine crash. There is no class to read, and reading one out of the prose would be a
    // parser only as fresh as the sentence it was built from. undefined is the honest answer.
    expect(parseRunpodErrorType("lipsync needs both clip_key and audio_key")).toBeUndefined();
    expect(parseRunpodErrorType("audio_key: R2 key must be a plain relative key under renders/")).toBeUndefined();
  });

  it("DISCRIMINATES: a structured payload with no error_type key still yields undefined", () => {
    // Without this, a parser that returned some other field (or a truthy default) would pass every
    // assertion above. NULL must mean "not told", never "told, and it was not a refusal".
    expect(parseRunpodErrorType(JSON.stringify({ error_message: "boom", worker_id: "w" }))).toBeUndefined();
    expect(parseRunpodErrorType({ error_message: "boom" })).toBeUndefined();
    expect(parseRunpodErrorType({ error_type: "   " })).toBeUndefined();
    expect(parseRunpodErrorType(undefined)).toBeUndefined();
    expect(parseRunpodErrorType(null)).toBeUndefined();
    expect(parseRunpodErrorType(42)).toBeUndefined();
  });

  it("accepts the object form and passes a plain class name through unharmed", () => {
    expect(parseRunpodErrorType({ error_type: "<class 'builtins.MemoryError'>" })).toBe("MemoryError");
    expect(parseRunpodErrorType({ error_type: "HarnessError" })).toBe("HarnessError");
  });

  it("bounds the class so a vendor putting a sentence in this key cannot widen the row", () => {
    const long = parseRunpodErrorType({ error_type: "C" + "x".repeat(500) });
    expect(long).toHaveLength(ERROR_TYPE_MAX);
  });
});

describe("recordRunpodJob: error_type column", () => {
  it("binds NULL when the caller has no class, and the class when it does (CONTROL pair)", async () => {
    const absent = recordingDb();
    await recordRunpodJob(absent.db, { jobId: "j", module: "m", outcome: "failed", submittedAtMs: 0 });
    expect(absent.calls.bound[0][6]).toBeNull();
    const present = recordingDb();
    await recordRunpodJob(present.db, { jobId: "j", module: "m", outcome: "failed", submittedAtMs: 0, errorType: "HarnessError" });
    expect(present.calls.bound[0][6]).toBe("HarnessError");
  });

  it("treats an empty-string class as absent rather than writing a blank label", async () => {
    const { db, calls } = recordingDb();
    await recordRunpodJob(db, { jobId: "j", module: "m", outcome: "failed", submittedAtMs: 0, errorType: "" });
    expect(calls.bound[0][6]).toBeNull();
  });

  it("bounds the class at the statement, not only at the parser", async () => {
    const { db, calls } = recordingDb();
    await recordRunpodJob(db, { jobId: "j", module: "m", outcome: "failed", submittedAtMs: 0, errorType: "y".repeat(500) });
    expect(String(calls.bound[0][6])).toHaveLength(ERROR_TYPE_MAX);
  });

  it("COALESCEs error_type in the upsert so a later classless write cannot erase a known class", () => {
    expect(RUNPOD_JOB_LOG_UPSERT).toContain("error_type = COALESCE(excluded.error_type, runpod_job_log.error_type)");
    // CONTROL: the same statement does NOT COALESCE outcome, which must be overwritten by the
    // first terminal write. A matcher that passed on any COALESCE would prove nothing.
    expect(RUNPOD_JOB_LOG_UPSERT).toContain("outcome = excluded.outcome");
    expect(RUNPOD_JOB_LOG_UPSERT).not.toContain("outcome = COALESCE");
  });
});

describe("runpodWalkedPastOutcome (cf#298)", () => {
  it("names the two terminal statuses the poll paths used to treat as still-running", () => {
    expect(runpodWalkedPastOutcome("CANCELLED")).toBe("cancelled");
    expect(runpodWalkedPastOutcome("TIMED_OUT")).toBe("failed");
  });

  it("DISCRIMINATES: it must not fire on a genuinely open job, or every poll writes a terminal row", () => {
    // This is the control that matters. A guard that returned a truthy value for IN_PROGRESS would
    // close the row on the first poll tick and make every job look terminal seconds after submit --
    // a failure far worse than the stuck rows it exists to fix, and one the assertions above cannot
    // see. COMPLETED and FAILED are excluded too: both are already handled by every caller.
    for (const s of ["IN_QUEUE", "IN_PROGRESS", "COMPLETED", "FAILED", "", "cancelled", undefined]) {
      expect(runpodWalkedPastOutcome(s), "must not fire on " + String(s)).toBeUndefined();
    }
  });
});

describe("recordRunpodJob: the cf#298 retry", () => {
  it("retries ONCE when the write fails, and the second attempt lands", async () => {
    let attempts = 0;
    const { db, calls } = recordingDb(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("D1_ERROR: transient");
      return { success: true };
    });
    await expect(degradePath(db)).resolves.toBe("degrade-completed");
    expect(attempts).toBe(2);
    expect(calls.sql).toHaveLength(2);
    expect(warns.join("|")).not.toContain("row NOT recorded");
  });

  it("gives up after the second failure and says so, rather than reporting nothing", async () => {
    const { db } = recordingDb(async () => { throw new Error("D1_ERROR: still down"); });
    await expect(degradePath(db)).resolves.toBe("degrade-completed");
    expect(warns.join("|")).toContain("write failed twice");
    expect(warns.join("|")).toContain("row NOT recorded");
  });

  it("DISCRIMINATES: a write that succeeds first time is attempted exactly once", async () => {
    // Without this, an unconditional double-write would pass both assertions above while doubling
    // the D1 traffic of every job in the studio.
    const { db, calls } = recordingDb();
    await expect(degradePath(db)).resolves.toBe("degrade-completed");
    expect(calls.sql).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------
// cf#298 reconciler: re-ask RunPod for rows stuck at submitted after the poll path moved on.
//
// The issue's acceptance shape: a deliberately dropped terminal write, failing before the
// reconciler runs and closing after. Also: honest `unknown` past retention, never invent completed.
// ------------------------------------------------------------------------------------------------

/** Fake D1 that can list open rows AND accept upserts (reconciler does both). */
function reconcileDb(openRows: Array<{ job_id: string; module: string; submitted_at: number | null }>) {
  const upserts: unknown[][] = [];
  const lists: unknown[][] = [];
  const db = {
    prepare(sql: string) {
      if (sql === LIST_OPEN_RUNPOD_JOBS_SQL) {
        return {
          bind(...args: unknown[]) {
            lists.push(args);
            return {
              all: async () => ({ results: openRows }),
            };
          },
        };
      }
      if (sql === RUNPOD_JOB_LOG_UPSERT) {
        return {
          bind(...args: unknown[]) {
            upserts.push(args);
            return { run: async () => ({ success: true }) };
          },
        };
      }
      throw new Error("unexpected sql: " + sql.slice(0, 80));
    },
  } as unknown as D1Database;
  return { db, upserts, lists };
}

describe("terminalOutcomeFromRunpodStatus (cf#298)", () => {
  it("maps RunPod terminal statuses the same way the poll path does", () => {
    expect(terminalOutcomeFromRunpodStatus("COMPLETED")).toBe("completed");
    expect(terminalOutcomeFromRunpodStatus("FAILED")).toBe("failed");
    expect(terminalOutcomeFromRunpodStatus("CANCELLED")).toBe("cancelled");
    expect(terminalOutcomeFromRunpodStatus("CANCELED")).toBe("cancelled");
    expect(terminalOutcomeFromRunpodStatus("TIMED_OUT")).toBe("failed");
    expect(terminalOutcomeFromRunpodStatus("timed-out")).toBe("failed");
  });

  it("returns null for still-running and unrecognised statuses (leave the row open)", () => {
    for (const s of ["IN_QUEUE", "IN_PROGRESS", "", "BOGUS", undefined, null]) {
      expect(terminalOutcomeFromRunpodStatus(s), "must leave open: " + String(s)).toBeNull();
    }
  });
});

describe("reconcileOpenRunpodJobs (cf#298)", () => {
  const nowMs = 1_700_000_600_000; // fixed clock
  const nowSec = Math.floor(nowMs / 1000);

  it("closes a stuck submitted row when RunPod still reports COMPLETED (deliberately dropped terminal write)", async () => {
    // The issue shape: submit wrote, terminal write never landed, job actually finished.
    const submittedAt = nowSec - 120; // older than RECONCILE_MIN_AGE_SEC
    const { db, upserts, lists } = reconcileDb([
      { job_id: "0c27e837-aae6-4921-9123-84fd4a50a4c6-e2", module: "keyframe", submitted_at: submittedAt },
    ]);
    const result = await reconcileOpenRunpodJobs(db, {
      module: "keyframe",
      fetchStatus: async () => "COMPLETED",
      nowMs,
    });
    expect(result).toEqual({ examined: 1, closed: 1, unknown: 0 });
    expect(lists[0][0]).toBe("keyframe");
    expect(lists[0][1]).toBe(nowSec - RECONCILE_MIN_AGE_SEC);
    expect(upserts).toHaveLength(1);
    expect(upserts[0][0]).toBe("0c27e837-aae6-4921-9123-84fd4a50a4c6-e2");
    expect(upserts[0][2]).toBe("completed");
    expect(upserts[0][5]).toBe(nowSec); // terminal_at filled
  });

  it("writes gone when RunPod no longer has the job", async () => {
    const { db, upserts } = reconcileDb([
      { job_id: "gone-job", module: "own-gpu", submitted_at: nowSec - 200 },
    ]);
    const result = await reconcileOpenRunpodJobs(db, {
      module: "own-gpu",
      fetchStatus: async () => "gone",
      nowMs,
    });
    expect(result.closed).toBe(1);
    expect(upserts[0][2]).toBe("gone");
  });

  it("writes unknown past retention when RunPod gives no terminal answer (never invents completed)", async () => {
    const old = nowSec - (RECONCILE_UNKNOWN_AFTER_SEC + 60);
    const { db, upserts } = reconcileDb([
      { job_id: "stale-job", module: "keyframe", submitted_at: old },
    ]);
    const result = await reconcileOpenRunpodJobs(db, {
      module: "keyframe",
      fetchStatus: async () => null, // retention expired / fetch failed
      nowMs,
    });
    expect(result).toEqual({ examined: 1, closed: 1, unknown: 1 });
    expect(upserts[0][2]).toBe("unknown");
  });

  it("leaves IN_PROGRESS rows open when still inside the retention window", async () => {
    const { db, upserts } = reconcileDb([
      { job_id: "running", module: "keyframe", submitted_at: nowSec - 120 },
    ]);
    const result = await reconcileOpenRunpodJobs(db, {
      module: "keyframe",
      fetchStatus: async () => "IN_PROGRESS",
      nowMs,
    });
    expect(result).toEqual({ examined: 1, closed: 0, unknown: 0 });
    expect(upserts).toHaveLength(0);
  });

  it("maps CANCELLED and FAILED through the same terminal writer", async () => {
    const { db, upserts } = reconcileDb([
      { job_id: "c1", module: "keyframe", submitted_at: nowSec - 100 },
      { job_id: "f1", module: "keyframe", submitted_at: nowSec - 100 },
    ]);
    let n = 0;
    await reconcileOpenRunpodJobs(db, {
      module: "keyframe",
      fetchStatus: async () => (n++ === 0 ? "CANCELLED" : "FAILED"),
      nowMs,
    });
    expect(upserts.map((u) => u[2])).toEqual(["cancelled", "failed"]);
  });

  it("returns zeros and does not throw when there is no D1 binding", async () => {
    await expect(
      reconcileOpenRunpodJobs(undefined, { module: "keyframe", fetchStatus: async () => "COMPLETED", nowMs }),
    ).resolves.toEqual({ examined: 0, closed: 0, unknown: 0 });
  });

  it("survives a list() failure without rejecting", async () => {
    const db = {
      prepare() {
        return {
          bind() {
            return {
              all: async () => {
                throw new Error("D1_ERROR: list boom");
              },
            };
          },
        };
      },
    } as unknown as D1Database;
    await expect(
      reconcileOpenRunpodJobs(db, { module: "keyframe", fetchStatus: async () => "COMPLETED", nowMs }),
    ).resolves.toEqual({ examined: 0, closed: 0, unknown: 0 });
    expect(warns.join("|")).toContain("reconcile list failed");
  });

  it("treats a throwing fetchStatus as transient (leave open) inside the retention window", async () => {
    const { db, upserts } = reconcileDb([
      { job_id: "net-fail", module: "own-gpu", submitted_at: nowSec - 120 },
    ]);
    const result = await reconcileOpenRunpodJobs(db, {
      module: "own-gpu",
      fetchStatus: async () => {
        throw new Error("fetch exploded");
      },
      nowMs,
    });
    expect(result.closed).toBe(0);
    expect(upserts).toHaveLength(0);
    expect(warns.join("|")).toContain("reconcile fetch failed");
  });
});
