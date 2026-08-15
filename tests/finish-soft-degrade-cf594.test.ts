/// <reference types="node" />
// A DOOR SOFT-DEGRADE MUST DEGRADE ONE SHOT IN ALL FOUR FINISH MODULES, NOT DESTROY THE FILM IN
// THREE OF THEM (cf#594).
//
// THE DEFECT THIS FILE GUARDS. Measured at origin/main 895c38c across all four
// modules/finish-*/src/index.ts, with `terminalErrorInOutput` as the CONTROL (present twice in all
// four, so the zeros are measured zeros and not a dead matcher):
//
//   module            ok === false   softDegradeInFailedEnvelope   terminalErrorInOutput (CONTROL)
//   finish-lipsync         1                    2                            2
//   finish-upscale         0                    0                            2
//   finish-rife            0                    0                            2
//   finish-blender         0                    0                            2
//
// The poll-path soft-degrade contract existed in 1 of 4. A door that cannot polish a clip but has
// not crashed returns a STRUCTURED `{"ok": false, ...}`; finish-lipsync passed the original clip
// through, and the other three fell through to the artifact parse, found no key, returned module
// ok:false, and had vivijure-core's failOrRetry classify it DETERMINISTIC and fail the render. The
// same honest door return was a one-shot degrade through one module and a destroyed film through
// three, and nothing anywhere said which was which.
//
// THE DENOMINATOR IS 4 OF 4, and it is enumerated from disk below rather than typed here, so a fifth
// finish module added later cannot join the estate untested by simply not being listed.
//
// WHY THIS FILE IS BEHAVIOURAL AND NOT A GREP. tests/finish-lipsync.test.ts unit-tests the pure
// discriminator, which proves the decision function and never that a module ACTS on it. This file
// drives each real worker's /poll through both door shapes with a recording D1 stub and asserts the
// returned FinishOutput and the telemetry row, so a helper that is imported but unreachable (wrong
// branch, an early return above it) fails here.
//
// WHAT WOULD MAKE THIS TEST WORTHLESS, stated so a later reader can check it has not happened: a
// happy-path assertion. "The module still returns a clip on a good render" passes identically before
// and after this fix and is structurally incapable of seeing the defect. Every case below is either
// a degrade that must be ABSORBED or a crash that must stay LOUD, and the loud half is what stops
// the fix from being "absorb everything".
//
// ONE ASYMMETRY IS DELIBERATE AND IS ASSERTED RATHER THAN HIDDEN. cf#585 made finish-lipsync and
// finish-upscale degrade on a COMPLETED result carrying no artifact key at all, scoped to those two
// on measured evidence about their satellites; finish-rife and finish-blender still fail loud there
// because vivijure-backend and vivijure-blender cannot produce that shape. cf#594 does not touch
// that decision, so `completedNoKey` below records which module does which. That case is NOT the
// soft-degrade contract: a soft degrade is `ok === false`, which is uniform in all four.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import finishLipsync from "../modules/finish-lipsync/src/index";
import finishUpscale from "../modules/finish-upscale/src/index";
import finishRife from "../modules/finish-rife/src/index";
import finishBlender from "../modules/finish-blender/src/index";

type Worker = { fetch(r: Request, e: never): Promise<Response> };

const SUBJECTS: Array<{ name: string; worker: Worker; completedNoKey: "degrade" | "loud" }> = [
  { name: "finish-lipsync", worker: finishLipsync as unknown as Worker, completedNoKey: "degrade" },
  { name: "finish-upscale", worker: finishUpscale as unknown as Worker, completedNoKey: "degrade" },
  { name: "finish-rife", worker: finishRife as unknown as Worker, completedNoKey: "loud" },
  { name: "finish-blender", worker: finishBlender as unknown as Worker, completedNoKey: "loud" },
];

const SOURCE_CLIP = "renders/lighthouse/clips/shot_01_seedance.mp4";
const JOB = "a1b2c3d4e5f60718293a4b5c6d7e8f90";

/** Captures every bind() argument list. A point-in-time read of final state cannot tell "wrote the
 *  right row" from "wrote nothing"; recording every call can. Column order of
 *  RUNPOD_JOB_LOG_UPSERT: job_id, module, outcome, detail, submitted_at, terminal_at, error_type. */
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
const outcomes = (calls: unknown[][]) => calls.map((c) => String(c[2]));

const token = (o: unknown) => btoa(JSON.stringify(o));
const pollToken = (extra: Record<string, unknown> = {}) =>
  token({ jobId: JOB, shotId: "shot_01", clipKey: SOURCE_CLIP, srcFps: 24, frames: 96, submittedAt: Date.now(), ...extra });

const envWith = (db: unknown) => ({ RUNPOD_API_KEY: "rpa_cf594_probe", RUNPOD_ENDPOINT_ID: "cf594endpoint", TELEMETRY_DB: db });

const post = (w: Worker, env: unknown, b: unknown) =>
  w.fetch(new Request("https://m.internal/poll", { method: "POST", body: JSON.stringify(b) }), env as never);

interface FinishOut { shot_id: string; clip_key: string; out_fps: number; frames: number; applied: string[]; degraded?: string }
interface PollBody { ok: boolean; error?: string; pending?: boolean; output?: FinishOut }

/** Drive one module's /poll against a single stubbed RunPod /status envelope. */
async function pollWith(worker: Worker, envelope: unknown, tok = pollToken()) {
  const { db, calls } = recordingDb();
  const fetchStub = vi.fn(async () => new Response(JSON.stringify(envelope), { status: 200, headers: { "content-type": "application/json" } }));
  globalThis.fetch = fetchStub as unknown as typeof fetch;
  const res = await post(worker, envWith(db), { poll: tok });
  return { body: (await res.json()) as PollBody, calls, fetchStub };
}

/** The door shape that RunPod LIFTS: a top-level `error` key in a handler RETURN becomes a job-level
 *  FAILED envelope with the handler's ok:false intact inside `output` (cf#565). */
const LIFTED_DEGRADE = { status: "FAILED", error: "wall-clock guard expired after 900s", output: { ok: false } };
/** The CURRENT door shape (musetalk#25): `detail` is not lifted, so the envelope stays COMPLETED. */
const COMPLETED_DEGRADE = { status: "COMPLETED", output: { ok: false, detail: "no detectable face in clip" } };
/** A GENUINE CRASH: a raise leaves NO structured output. This must keep failing loud, in all four. */
const CRASH = { status: "FAILED", error: "Traceback (most recent call last): RuntimeError: CUDA out of memory" };
/** A crash whose envelope carries an explicitly null output -- the same absence, spelled differently. */
const CRASH_NULL_OUTPUT = { status: "FAILED", error: "boom", output: null };

let realFetch: typeof fetch;
beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; vi.restoreAllMocks(); });

describe("the harness itself can report the failing reading (controls)", () => {
  it("the recording D1 stub records, so an empty capture below means nothing was written", () => {
    const { db, calls } = recordingDb();
    (db as { prepare: (s: string) => { bind: (...a: unknown[]) => unknown } }).prepare("x").bind("a", "b", "c");
    expect(calls).toEqual([["a", "b", "c"]]);
  });

  it("the DENOMINATOR is 4, enumerated from disk: every finish module on disk is a subject here", () => {
    const onDisk = readdirSync(join(__dirname, "..", "modules")).filter((d) => d.startsWith("finish-")).sort();
    expect(onDisk).toEqual(["finish-blender", "finish-lipsync", "finish-rife", "finish-upscale"]);
    expect(SUBJECTS.map((s) => s.name).sort()).toEqual(onDisk);
  });
});

for (const { name, worker, completedNoKey } of SUBJECTS) {
  describe(name + ": a door soft-degrade degrades ONE SHOT (cf#594)", () => {
    it("the LIFTED shape ({ok:false} inside a FAILED envelope) passes the original clip through", async () => {
      const { body, fetchStub } = await pollWith(worker, LIFTED_DEGRADE);
      expect(fetchStub).toHaveBeenCalled();                       // the envelope was actually read
      expect(body.error ?? "no error").toBe("no error");
      expect(body.ok).toBe(true);
      expect(body.output?.clip_key).toBe(SOURCE_CLIP);            // the ORIGINAL clip, unpolished
      expect(body.output?.applied).toEqual(["passthrough:backend-soft-degrade"]);
      expect(body.output?.degraded).toBe("backend-soft-degrade: wall-clock guard expired after 900s");
    });

    it("the CURRENT shape ({ok:false, detail} in a COMPLETED envelope) passes the original clip through", async () => {
      const { body } = await pollWith(worker, COMPLETED_DEGRADE);
      expect(body.ok).toBe(true);
      expect(body.output?.clip_key).toBe(SOURCE_CLIP);
      expect(body.output?.applied).toEqual(["passthrough:backend-soft-degrade"]);
      expect(body.output?.degraded).toBe("backend-soft-degrade: no detectable face in clip");
    });

    it("a GENUINE CRASH still fails LOUD -- no structured output is the discriminator", async () => {
      const { body } = await pollWith(worker, CRASH);
      expect(body.ok).toBe(false);
      expect(String(body.error)).toContain("job failed");
      expect(body.output).toBeUndefined();
    });

    it("a crash with an explicitly NULL output still fails loud", async () => {
      const { body } = await pollWith(worker, CRASH_NULL_OUTPUT);
      expect(body.ok).toBe(false);
    });

    it("TELEMETRY: a recovered degrade records the ENDPOINT's outcome, `completed`, not `failed`", async () => {
      // cf#594 finding 3. RunPod's FAILED here is an artifact of it lifting a top-level `error` key
      // out of a handler RETURN, not an endpoint failure: the endpoint ran to completion and
      // returned a structured result. Recording `failed` was wrong ABOUT THE ENDPOINT, independently
      // of whether we recovered anything, and it inflated the backend failure rate with successes.
      // This does NOT relax cf#279 -- the row is still the endpoint's outcome, still written before
      // the output is parsed for our own use.
      const { calls, body } = await pollWith(worker, LIFTED_DEGRADE);
      expect(body.ok).toBe(true);
      expect(outcomes(calls)).toEqual(["completed"]);             // exactly one row, and not `failed`
    });

    it("TELEMETRY CONTROL: a real crash still records `failed`, so the row above is a distinction", async () => {
      const { calls, body } = await pollWith(worker, CRASH);
      expect(body.ok).toBe(false);
      expect(outcomes(calls)).toEqual(["failed"]);
    });

    it("a COMPLETED result with NO artifact key behaves as cf#585 scoped it: " + completedNoKey, async () => {
      // NOT the cf#594 contract, asserted here so the asymmetry is visible rather than inferred.
      const { body } = await pollWith(worker, { status: "COMPLETED", output: { ok: true } });
      if (completedNoKey === "degrade") {
        expect(body.ok).toBe(true);
        expect(body.output?.applied).toEqual(["passthrough:no-output-key"]);
      } else {
        expect(body.ok).toBe(false);
        expect(String(body.error)).toContain("no clip_key");
      }
    });
  });
}

describe("a poll token with no source clip keeps the pre-cf#594 terminal path (cf#594)", () => {
  // The passthrough IS the original clip, so without its key there is nothing honest to return.
  // Bounded to renders already in their finish phase across one deploy. Returning ok:true with an
  // empty clip_key would be worse than failing: it hands the chain a reference that resolves to
  // nothing, which is the silent-degrade shape of #77 wearing a success. The row stays `failed`
  // because on this path nothing was recovered, so nothing about the endpoint's answer was usable.
  for (const { name, worker } of SUBJECTS) {
    it(name + ": fails loud, and the door's reason survives in the message", async () => {
      const legacy = token({ jobId: JOB, shotId: "shot_01", srcFps: 24, frames: 96, submittedAt: Date.now() });
      const { body, calls } = await pollWith(worker, LIFTED_DEGRADE, legacy);
      expect(body.ok).toBe(false);
      expect(String(body.error)).toContain("wall-clock guard expired after 900s");
      expect(outcomes(calls)).toEqual(["failed"]);
    });
  }
});
