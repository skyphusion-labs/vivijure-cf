// cf#284: /ready must report whether this worker can RECORD, not whether a binding is attached.
//
// The bug being fenced was observed, not theorised: a module bound to a real database with
// runpod_job_log absent reported job_log:true while a real job ran to completion and both writes
// failed. Every case below is a state where the BINDING IS PRESENT, because that is the only
// interesting region: binding-absent was already reported correctly.
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  probeRunpodJobLog,
  JOB_LOG_PROBE_TIMEOUT_MS,
  JOB_LOG_TABLE_PROBE,
} from "../modules/_shared/runpod-job-log";

afterEach(() => {
  vi.useRealTimers();
});

/** A binding whose read result is scripted, recording every statement it was asked to prepare. */
function db(first: () => Promise<unknown>): { db: D1Database; sql: string[]; binds: unknown[][] } {
  const sql: string[] = [];
  const binds: unknown[][] = [];
  const handle = {
    prepare: (q: string) => {
      sql.push(q);
      return { bind: (...args: unknown[]) => { binds.push(args); return { first }; } };
    },
  } as unknown as D1Database;
  return { db: handle, sql, binds };
}

describe("probeRunpodJobLog: the three states", () => {
  it("no binding at all is DEFINITIVE, not unknown", async () => {
    expect(await probeRunpodJobLog(undefined)).toBe("unavailable");
  });

  it("the table exists -> ok", async () => {
    const { db: d } = db(async () => ({ name: "runpod_job_log" }));
    expect(await probeRunpodJobLog(d)).toBe("ok");
  });

  it("THE cf#284 CASE: bound database, table absent -> unavailable (was reported as true)", async () => {
    const { db: d } = db(async () => null);
    expect(await probeRunpodJobLog(d)).toBe("unavailable");
  });

  it("a row without the expected shape is not treated as proof", async () => {
    const { db: d } = db(async () => ({}));
    expect(await probeRunpodJobLog(d)).toBe("unavailable");
  });
});

describe("probeRunpodJobLog: I COULD NOT TELL never reads as healthy", () => {
  it("the read rejects -> unknown", async () => {
    const { db: d } = db(async () => { throw new Error("D1_ERROR: connection lost"); });
    expect(await probeRunpodJobLog(d)).toBe("unknown");
  });

  it("prepare throws synchronously -> unknown", async () => {
    const d = { prepare: () => { throw new Error("boom"); } } as unknown as D1Database;
    expect(await probeRunpodJobLog(d)).toBe("unknown");
  });

  it("a binding of the wrong shape -> unknown (this stub used to report true)", async () => {
    const d = { prepare: () => ({}) } as unknown as D1Database;
    expect(await probeRunpodJobLog(d)).toBe("unknown");
  });

  it("a thrown non-Error does not become a crash", async () => {
    const d = { prepare: () => { throw "a bare string"; } } as unknown as D1Database;
    expect(await probeRunpodJobLog(d)).toBe("unknown");
  });

  it("the read HANGS -> unknown at the bound, and the probe still resolves", async () => {
    vi.useFakeTimers();
    const { db: d } = db(() => new Promise(() => {}));
    const p = probeRunpodJobLog(d);
    await vi.advanceTimersByTimeAsync(JOB_LOG_PROBE_TIMEOUT_MS + 100);
    await expect(p).resolves.toBe("unknown");
  });
});

describe("the probe leaves no litter, and asks the question it claims to", () => {
  it("issues exactly one statement, and it is a READ", async () => {
    const { db: d, sql } = db(async () => ({ name: "runpod_job_log" }));
    await probeRunpodJobLog(d);
    expect(sql.length).toBe(1);
    expect(sql[0]).toBe(JOB_LOG_TABLE_PROBE);
    // A readiness probe that INSERTs would put fabricated jobs in the table operators query for
    // real ones. Asserting the shape, not just trusting the constant.
    expect(sql[0].trim().slice(0, 6).toUpperCase()).toBe("SELECT");
    for (const forbidden of ["INSERT", "UPDATE", "DELETE", "DROP", "CREATE"]) {
      expect(sql[0].toUpperCase()).not.toContain(forbidden);
    }
  });

  it("asks about the runpod_job_log TABLE specifically, by data and not by error text", async () => {
    const { db: d, binds } = db(async () => ({ name: "runpod_job_log" }));
    await probeRunpodJobLog(d);
    expect(binds).toEqual([["table", "runpod_job_log"]]);
  });

  it("CONTROL: the recorder can distinguish states at all (else every case above is one answer)", async () => {
    const ok = await probeRunpodJobLog(db(async () => ({ name: "runpod_job_log" })).db);
    const missing = await probeRunpodJobLog(db(async () => null).db);
    const broken = await probeRunpodJobLog(db(async () => { throw new Error("x"); }).db);
    expect(new Set([ok, missing, broken]).size).toBe(3);
  });
});
