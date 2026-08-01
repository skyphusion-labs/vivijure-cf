// THE COST DOOR NOW WRITES A ROW (cf#305).
//
// THE DEFECT THIS FILE GUARDS. `runpod_job_log` held ZERO rows for the entire GPUless cost door.
// Eight modules submit jobs to RunPod and none of them held a `TELEMETRY_DB` binding or called
// `recordRunpodJob` at all. The failure shape is the one cf#279 exists to end, one layer out: an
// operator querying the table grouped by module sees the six tenant modules with healthy-looking
// rows and simply does not see the other eight. A module that never writes cannot appear in a
// census built from what was written, so the absence reads as a quiet lane rather than as a gap.
//
// WHY THIS IS BEHAVIOURAL AND NOT A GREP. tests/module-readiness-denominators-295.test.ts counts
// which modules MENTION recordRunpodJob, which is source shape: it proves the call site is present,
// never that a row would land. This file drives a real cost-door worker through each terminal path
// with a RECORDING D1 stub and asserts the bind arguments, so a call site that is present but
// unreachable (wrong branch, early return above it) fails here.
//
// WHAT IT DELIBERATELY DOES NOT CLAIM. Recording is not classifying. The cost-door endpoints are
// THIRD-PARTY public RunPod endpoints, not vivijure-backend, so what they put in `error` on a fault
// is the vendor's shape and we have not measured it. `error_type` lands when a structured key is
// present and NULL when it is not, and NULL means "not told", never "not a refusal" -- exactly as
// migrations/0015 says. The last test below pins both directions so a reader cannot mistake a
// populated column for a solved classification.
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import seedanceWorker from "../modules/seedance/src/index";
import { encodePoll, RUNPOD_COLD_GRACE_MS } from "../modules/seedance/src/seedance";

/** Captures every bind() argument list. A point-in-time read of final state cannot tell "wrote the
 *  right row" from "wrote nothing"; recording every call can. */
function recordingDb() {
  const calls: unknown[][] = [];
  const db = {
    prepare: (_sql: string) => ({
      bind: (...args: unknown[]) => {
        calls.push(args);
        return { run: async () => ({}), first: async () => ({ name: "runpod_job_log" }) };
      },
    }),
  };
  return { db: db as unknown, calls };
}

/** Column order of RUNPOD_JOB_LOG_UPSERT: job_id, module, outcome, detail, submitted_at,
 *  terminal_at, error_type. */
const OUTCOME = 2;
const ERROR_TYPE = 6;

const rows = (calls: unknown[][]) => calls.map((c) => ({ jobId: c[0], module: c[1], outcome: c[OUTCOME], detail: c[3], errorType: c[ERROR_TYPE] }));

const pollReq = (poll: string) => new Request("https://module/poll", { method: "POST", body: JSON.stringify({ poll }) });
const invokeReq = (body: unknown) => new Request("https://module/invoke", { method: "POST", body: JSON.stringify(body) });

const envWith = (db: unknown) =>
  ({
    RUNPOD_API_KEY: "k",
    TELEMETRY_DB: db,
    R2_RENDERS: { put: async () => ({}) },
  }) as unknown as Parameters<typeof seedanceWorker.fetch>[1];

const token = (submittedAt: number) => encodePoll({ jobId: "job-305", project: "p", shotId: "shot_01", seconds: 5, submittedAt });

describe("the recording stub itself records (positive control)", () => {
  it("a bind call is captured, so an empty capture below means nothing was written", () => {
    const { db, calls } = recordingDb();
    (db as { prepare: (s: string) => { bind: (...a: unknown[]) => unknown } }).prepare("x").bind("a", "b");
    expect(calls).toEqual([["a", "b"]]);
  });
});

describe("seedance (cost door) writes a runpod_job_log row on every terminal path (cf#305)", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("submit records `submitted` with the job id RunPod returned", async () => {
    const { db, calls } = recordingDb();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "job-305" }), { status: 200 })));
    const res = await seedanceWorker.fetch(
      invokeReq({ hook: "motion.backend", context: { project: "p" }, config: {}, input: { shot_id: "shot_01", keyframe_url: "https://r2/x.png", prompt: "a city", seconds: 5 } }),
      envWith(db),
    );
    const j = (await res.json()) as { ok: boolean; error?: string };
    expect(j.error ?? "no error").toBe("no error");
    expect(j.ok).toBe(true);
    expect(rows(calls)).toEqual([{ jobId: "job-305", module: "seedance", outcome: "submitted", detail: null, errorType: null }]);
  });

  it("a FAILED job records `failed`, and a STRUCTURED error_type lands in its own column", async () => {
    const { db, calls } = recordingDb();
    // A vivijure-backend-shaped payload. The cost door does not normally produce this (see the
    // header); it is asserted here so the column is proven to be POPULATED, not merely declared.
    const structured = JSON.stringify({ error_type: "<class 'vivijure_backend.harness.handler.HarnessError'>", error_message: "refused" });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "FAILED", error: structured }), { status: 200 })));
    const body = await (await seedanceWorker.fetch(pollReq(token(Date.now())), envWith(db))).json() as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(rows(calls)).toHaveLength(1);
    expect(rows(calls)[0].outcome).toBe("failed");
    expect(rows(calls)[0].errorType).toBe("HarnessError");
  });

  it("a FAILED job whose error is a BARE VENDOR STRING records `failed` with error_type NULL", async () => {
    // The honest half, and the one that matters for phase 1: NULL is "the endpoint did not tell us
    // the class". It must never be readable as "this was not a refusal". Never guessed from prose.
    const { db, calls } = recordingDb();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "FAILED", error: "provider rejected the request" }), { status: 200 })));
    await seedanceWorker.fetch(pollReq(token(Date.now())), envWith(db));
    expect(rows(calls)[0].outcome).toBe("failed");
    expect(rows(calls)[0].errorType).toBeNull();
  });

  it("a CANCELLED job records `cancelled` instead of staying `submitted` forever (cf#298)", async () => {
    const { db, calls } = recordingDb();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "CANCELLED" }), { status: 200 })));
    const body = await (await seedanceWorker.fetch(pollReq(token(Date.now())), envWith(db))).json() as { ok: boolean; pending?: boolean };
    expect(rows(calls)[0].outcome).toBe("cancelled");
    // RECORD ONLY: the render path is unchanged, so this still reports pending exactly as before.
    expect(body).toEqual({ ok: true, pending: true });
  });

  it("a GC'd job past the grace window records `gone`", async () => {
    const { db, calls } = recordingDb();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404 })));
    const old = Date.now() - (RUNPOD_COLD_GRACE_MS + 60_000);
    const body = await (await seedanceWorker.fetch(pollReq(token(old)), envWith(db))).json() as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(rows(calls)[0].outcome).toBe("gone");
  });

  it("the F17 returned-not-raised path records `backend-error`", async () => {
    const { db, calls } = recordingDb();
    const stuck = { status: "IN_PROGRESS", output: { status: "error", error: { message: "R2 config incomplete", stage: "config" } } };
    vi.stubGlobal("fetch", vi.fn(async (u: string) => (String(u).includes("/status/") ? new Response(JSON.stringify(stuck), { status: 200 }) : new Response("{}", { status: 200 }))));
    const body = await (await seedanceWorker.fetch(pollReq(token(Date.now())), envWith(db))).json() as { ok: boolean };
    expect(body.ok).toBe(false);
    expect(rows(calls)[0].outcome).toBe("backend-error");
  });

  it("a COMPLETED job records `completed` BEFORE the output is parsed", async () => {
    // Whether the ENDPOINT completed and whether WE could use its output are different facts. The
    // row must carry the first; the chain response carries the second. Asserted with an output the
    // module cannot use, so a recorder moved below the parse would drop the row and fail here.
    const { db, calls } = recordingDb();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "COMPLETED", output: {} }), { status: 200 })));
    const body = await (await seedanceWorker.fetch(pollReq(token(Date.now())), envWith(db))).json() as { ok: boolean; error?: string };
    expect(rows(calls)[0].outcome).toBe("completed");
    expect(body.ok).toBe(false);
    expect(body.error).toContain("no video url");
  });

  it("no D1 binding degrades to a warn: the render path is never gated by telemetry", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ status: "CANCELLED" }), { status: 200 })));
    const env = { RUNPOD_API_KEY: "k", R2_RENDERS: { put: async () => ({}) } } as unknown as Parameters<typeof seedanceWorker.fetch>[1];
    const body = await (await seedanceWorker.fetch(pollReq(token(Date.now())), env)).json() as { ok: boolean; pending?: boolean };
    expect(body).toEqual({ ok: true, pending: true });
  });
});

// ---------------------------------------------------------------------------------------------
// The other seven cost-door submitters are the same shape. Driving all eight worker-level would be
// eight copies of the block above; instead each is checked for the binding and for every outcome
// the behavioural block proved reachable in seedance. Source shape is a WEAKER claim and is labelled
// as one -- it catches a module nobody wired, not a call site that cannot be reached.
// ---------------------------------------------------------------------------------------------
const COST_DOOR = ["seedance", "kling", "vidu-q3", "google-veo", "minimax-hailuo", "alibaba-wan", "alibaba-wan-lora", "narration-gen"];
const MODULES_DIR = join(import.meta.dirname, "..", "modules");
const read = (mod: string, file: string) => readFileSync(join(MODULES_DIR, mod, file), "utf8");

describe("all eight cost-door submitters are wired (cf#305)", () => {
  it("the scan reads real files (positive control)", () => {
    const dirs = readdirSync(MODULES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    for (const m of COST_DOOR) expect(dirs, "cost-door module missing from the tree: " + m).toContain(m);
    expect(read("seedance", "src/index.ts")).toContain("recordRunpodJob");
    // Control the other way: a module that is NOT a cost-door submitter must not be in this list,
    // or the list has silently become "every module" and asserts nothing.
    expect(COST_DOOR).not.toContain("plan-enhance");
  });

  it("each binds TELEMETRY_DB to the studio D1, with the placeholder the deploy script fills", () => {
    for (const m of COST_DOOR) {
      const toml = read(m, "wrangler.toml");
      expect(toml, m + " has no TELEMETRY_DB binding").toContain('binding = "TELEMETRY_DB"');
      expect(toml, m + " does not point at the studio D1").toContain('database_name = "vivijure-studio"');
      expect(toml, m + " must keep the placeholder deploy-module-workers.sh substitutes").toContain("REPLACE_WITH_D1_DATABASE_ID");
    }
  });

  it("each records every terminal outcome, not just the happy path", () => {
    for (const m of COST_DOOR) {
      const src = read(m, "src/index.ts");
      for (const outcome of ["submitted", "completed", "failed", "gone", "backend-error"]) {
        expect(src, m + " never records outcome " + outcome).toContain('outcome: "' + outcome + '"');
      }
      expect(src, m + " walks past CANCELLED/TIMED_OUT without recording").toContain("runpodWalkedPastOutcome(s.status)");
      expect(src, m + " does not extract the fault class").toContain("parseRunpodErrorType");
      expect(src, m + " does not report telemetry readiness").toContain("telemetry: { job_log");
    }
  });

  it("the outcome matcher DISCRIMINATES (control): a module that records nothing fails it", () => {
    // Without this, the loop above passes on a file that merely mentions the words in a comment.
    const notAWriter = read("plan-enhance", "src/index.ts");
    expect(notAWriter).not.toContain('outcome: "submitted"');
  });
});
