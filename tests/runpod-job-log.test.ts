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
    expect(calls.bound[0]).toEqual(["job-1", "finish-upscale", "backend-error", "boom", 1_700_000_000, 1_700_000_060]);
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
