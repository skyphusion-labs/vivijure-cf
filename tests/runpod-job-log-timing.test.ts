// cp#274: RunPod's OWN timing on the module job log. These tests exist because the ONE rule that
// matters here is a distinction, not a value: an ABSENT field must land NULL and a REPORTED zero
// must land zero, and a check that cannot tell those apart is the whole defect this column set was
// added to stop.
//
// Every case below is driven from a REAL observed /status shape rather than a minimal literal: a
// fixture that carries only the field under test cannot show that the extractor picks the right
// field out of a real envelope.
import { describe, it, expect } from "vitest";
import {
  timingFromStatus,
  recordRunpodJob,
  RUNPOD_JOB_LOG_UPSERT,
} from "../modules/_shared/runpod-job-log";

/** Records prepare/bind so a test can assert what actually reaches the statement. */
function recordingDb() {
  const bound: unknown[][] = [];
  const db = {
    prepare() {
      return {
        bind(...args: unknown[]) {
          bound.push(args);
          return { run: async () => ({ success: true }) };
        },
      };
    },
  } as unknown as D1Database;
  return { db, bound };
}

describe("timingFromStatus", () => {
  it("extracts both fields from a COMPLETED envelope", () => {
    // Shape as RunPod returns it, extra keys included on purpose.
    const s = { status: "COMPLETED", executionTime: 12345, delayTime: 678, output: { ok: true } };
    expect(timingFromStatus(s)).toEqual({ executionMs: 12345, delayMs: 678 });
  });

  it("returns NULL for BOTH on a CANCELLED envelope, which carries neither field", () => {
    // This is the measured real case the null-not-zero rule exists for.
    const s = { status: "CANCELLED" };
    expect(timingFromStatus(s)).toEqual({ executionMs: null, delayMs: null });
  });

  it("KEEPS a reported zero as zero, because absent and zero are different claims", () => {
    const s = { status: "COMPLETED", executionTime: 0, delayTime: 0 };
    const t = timingFromStatus(s);
    // The assertion that matters: not just falsy, actually 0 and NOT null.
    expect(t.executionMs).toBe(0);
    expect(t.delayMs).toBe(0);
    expect(t.executionMs).not.toBeNull();
  });

  it("rejects non-numeric, NaN, Infinity and negative values as NULL", () => {
    expect(timingFromStatus({ executionTime: "12345", delayTime: null })).toEqual({ executionMs: null, delayMs: null });
    expect(timingFromStatus({ executionTime: NaN, delayTime: Infinity })).toEqual({ executionMs: null, delayMs: null });
    // Deliberate divergence from the plane-side twin, asserted so it cannot be "tidied" back.
    expect(timingFromStatus({ executionTime: -1, delayTime: -0.5 })).toEqual({ executionMs: null, delayMs: null });
  });

  it("survives a non-object without throwing, so a caller cannot crash a poll path", () => {
    for (const junk of [null, undefined, 0, "", "COMPLETED", []]) {
      expect(() => timingFromStatus(junk)).not.toThrow();
    }
    expect(timingFromStatus(null)).toEqual({ executionMs: null, delayMs: null });
  });
});

describe("the timing reaches the statement in the right positions", () => {
  it("binds execution_ms and delay_ms as parameters 8 and 9", async () => {
    const { db, bound } = recordingDb();
    await recordRunpodJob(db, {
      jobId: "j1",
      module: "keyframe",
      outcome: "completed",
      submittedAtMs: 1_700_000_000_000,
      ...timingFromStatus({ status: "COMPLETED", executionTime: 4242, delayTime: 99 }),
    });
    expect(bound).toHaveLength(1);
    // Positive control on the row itself: if the record never reached bind, this is not a pass.
    expect(bound[0][0]).toBe("j1");
    expect(bound[0][7]).toBe(4242);
    expect(bound[0][8]).toBe(99);
  });

  it("binds NULL, not 0, when the envelope carried no timing", async () => {
    const { db, bound } = recordingDb();
    await recordRunpodJob(db, {
      jobId: "j2",
      module: "keyframe",
      outcome: "cancelled",
      submittedAtMs: 1_700_000_000_000,
      ...timingFromStatus({ status: "CANCELLED" }),
    });
    expect(bound[0][7]).toBeNull();
    expect(bound[0][8]).toBeNull();
  });

  it("binds NULL on the `gone` path, which passes no timing at all", async () => {
    // The 404 path has no envelope and deliberately does not call timingFromStatus. An omitted
    // field and an absent field must reach the statement identically.
    const { db, bound } = recordingDb();
    await recordRunpodJob(db, {
      jobId: "j3",
      module: "keyframe",
      outcome: "gone",
      submittedAtMs: 1_700_000_000_000,
    });
    expect(bound[0][7]).toBeNull();
    expect(bound[0][8]).toBeNull();
  });

  it("a hand-built record cannot smuggle a negative or non-finite past the boundary", async () => {
    const { db, bound } = recordingDb();
    await recordRunpodJob(db, {
      jobId: "j4",
      module: "keyframe",
      outcome: "completed",
      executionMs: -5,
      delayMs: Number.NaN,
    });
    expect(bound[0][7]).toBeNull();
    expect(bound[0][8]).toBeNull();
  });
});

describe("the upsert preserves timing the way it preserves detail", () => {
  it("COALESCEs both columns so a later write cannot erase an earlier measurement", () => {
    expect(RUNPOD_JOB_LOG_UPSERT).toContain(
      "execution_ms = COALESCE(excluded.execution_ms, runpod_job_log.execution_ms)",
    );
    expect(RUNPOD_JOB_LOG_UPSERT).toContain(
      "delay_ms = COALESCE(excluded.delay_ms, runpod_job_log.delay_ms)",
    );
  });

  it("still carries the first-terminal-write-wins guard", () => {
    // Negative control on the two assertions above: they must not have been satisfied by a rewrite
    // that dropped the guard the whole table depends on.
    expect(RUNPOD_JOB_LOG_UPSERT).toContain("WHERE runpod_job_log.terminal_at IS NULL");
  });
});
