// EVERY RunPod SUBMITTER HANDS THE CALLER THE PROVIDER JOB ID (cf#289, cf#296).
//
// THE DEFECT. RunPod cannot enumerate jobs -- the whole surface is /run, /status, /stream, /cancel,
// /retry, /purge-queue, /health, and /status is BY ID ONLY -- and async results expire after 30
// minutes. So a job id the caller is not handed at submit is unreachable PERMANENTLY. cf#289 filed
// this for the non-motion submitters; cf#296 filed the motion.backend half and closed it in PR #304
// with tests/motion-backend-submit-jobid-296.test.ts. This file is the other half, and it is what
// keeps the class closed rather than one module closed.
//
// WHY IT MATTERS NOW AND NOT ONLY AS TELEMETRY. Conrad's metering rule (vivijure#805) deducts per
// SUCCESSFULLY COMPLETED job, tracked BY JOB ID. Pooling removes endpoint identity as an attribution
// route, and RunPod billing cannot supply it either (`get-billing scope=endpoints` returns
// time-bucketed totals with no endpoint identifier; `scope` filters by resource TYPE and does not
// group). Per-tenant cost therefore has to be computed from our own job records, keyed on job id --
// so this envelope field is the meter's primary key, not an observability nicety.
//
// WHY THIS IS BEHAVIOURAL AND NOT A GREP. cf#289 built its table with a line-anchored grep, got the
// wrong set because two modules inline the field at the end of the return line, and said so in the
// issue: "anyone acting on this table should re-derive it behaviourally rather than trusting a grep,
// mine included." So every module below is driven through its real POST /invoke, through its real
// submit path, with RunPod stubbed only at the fetch boundary. Routing, guards and envelope
// construction are all shipped code; the field is read off the actual response body.
//
// MEASURED CORRECTION TO cf#289's TABLE. The issue enumerates FIVE RunPod submitters (keyframe,
// finish-upscale, speech-upscale, narration-gen, vidu-q3). The real population is FOURTEEN. It never
// listed finish-lipsync or finish-rife at all, and it counted only one of the nine motion backends.
// The census at the bottom of this file derives the population instead of asserting it, so the next
// person does not inherit a hand-written list that can go stale the same way.
import { describe, it, expect, vi, afterEach } from "vitest";

import keyframeWorker from "../modules/keyframe/src/index";
import finishUpscaleWorker from "../modules/finish-upscale/src/index";
import finishRifeWorker from "../modules/finish-rife/src/index";
import finishLipsyncWorker from "../modules/finish-lipsync/src/index";
import speechUpscaleWorker from "../modules/speech-upscale/src/index";
import narrationGenWorker from "../modules/narration-gen/src/index";

type Worker = { fetch(request: Request, env: never): Promise<Response> };

const STUB_JOB_ID = "3f2a1b09-0000-4ccc-8ddd-1a2b3c4d5e6f";
/** The FILM job id on the invoke context. Deliberately distinct from every provider id used here:
 *  narration-gen binds a local `jobId` to exactly this value, so the one-word shorthand that every
 *  sibling module uses would return THIS and still typecheck. One test below pins that apart. */
const FILM_JOB_ID = "film_job_0001";

/** RUNPOD_WORKERS_MAX is left unset on purpose everywhere: set, the submit detours through the
 *  endpoint reconcile, which is not the path under test. */
const RUNPOD_ENV = { RUNPOD_API_KEY: "rpa_stub", RUNPOD_ENDPOINT_ID: "nbfj3iatp62ek9" };

interface Case {
  name: string;
  worker: Worker;
  hook: string;
  env: Record<string, unknown>;
  input: Record<string, unknown>;
  config: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    name: "keyframe",
    worker: keyframeWorker as unknown as Worker,
    hook: "keyframe",
    env: RUNPOD_ENV,
    input: { project: "p_test", bundle_key: "renders/p_test/bundle.json" },
    config: {},
  },
  {
    name: "finish-upscale",
    worker: finishUpscaleWorker as unknown as Worker,
    hook: "finish",
    env: RUNPOD_ENV,
    input: { shot_id: "shot_01", clip_key: "renders/p_test/clips/shot_01.mp4" },
    config: {},
  },
  {
    // finish-rife no-ops deliberately when nothing is enabled, so the config has to turn something
    // on or the module never reaches /run and this file would be testing the no-op path.
    name: "finish-rife",
    worker: finishRifeWorker as unknown as Worker,
    hook: "finish",
    env: RUNPOD_ENV,
    input: { shot_id: "shot_01", clip_key: "renders/p_test/clips/shot_01.mp4" },
    config: { interpolate: true },
  },
  {
    // finish-lipsync no-ops without dialogue audio for the shot, same reasoning.
    name: "finish-lipsync",
    worker: finishLipsyncWorker as unknown as Worker,
    hook: "finish",
    env: RUNPOD_ENV,
    input: {
      shot_id: "shot_01",
      clip_key: "renders/p_test/clips/shot_01.mp4",
      audio_key: "renders/p_test/dialogue/shot_01.wav",
    },
    config: {},
  },
  {
    // speech-upscale is opt-in; `enable` off is a clean no-op, not a submit.
    name: "speech-upscale",
    worker: speechUpscaleWorker as unknown as Worker,
    hook: "speech",
    env: RUNPOD_ENV,
    input: { shot_id: "shot_01", audio_key: "renders/p_test/dialogue/shot_01.wav" },
    config: { enable: true },
  },
  {
    // narration-gen submits to a fixed hosted endpoint slug, so it needs no RUNPOD_ENDPOINT_ID.
    // config.text is REQUIRED for a real submit: with neither text nor storyboard scenes the module
    // refuses before it reaches /run. The first version of this fixture omitted it and the reach
    // control caught it -- which is the control doing its job, not a stray failure.
    name: "narration-gen",
    worker: narrationGenWorker as unknown as Worker,
    hook: "score",
    env: { RUNPOD_API_KEY: "rpa_stub" },
    input: { film_key: "renders/p_test/film.mp4", seconds: 30 },
    config: { text: "The city exhales, and the neon holds its breath." },
  },
];

/** Answers the vendor /run with a job id and everything else with something harmless. Records the
 *  URLs it was asked for, so a test can prove the module really reached the submit call. */
function stubRunpod(runBody: unknown = { id: STUB_JOB_ID }) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    seen.push(u);
    if (u.endsWith("/run")) {
      return new Response(JSON.stringify(runBody), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  });
  return seen;
}

const invoke = async (c: Case, input: unknown = c.input) => {
  const res = await c.worker.fetch(
    new Request("https://m.internal/invoke", {
      method: "POST",
      body: JSON.stringify({
        hook: c.hook,
        input,
        config: c.config,
        context: { project: "p_test", job_id: FILM_JOB_ID },
      }),
    }),
    c.env as never,
  );
  return (await res.json()) as Record<string, unknown>;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(CASES)("$name: POST /invoke submit envelope", (c) => {
  it("returns the provider job id the vendor handed it, at the top level", async () => {
    const seen = stubRunpod();
    const body = await invoke(c);
    // CONTROL: the module actually reached the vendor submit. Without it, a module that
    // short-circuited on a guard fails the assertion below for the wrong reason, and a module that
    // returned a hardcoded id passes it for the wrong reason.
    expect(seen.some((u) => u.endsWith("/run")), c.name + " never called /run; saw " + JSON.stringify(seen)).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.pending).toBe(true);
    expect(typeof body.poll).toBe("string");
    expect(body.jobId).toBe(STUB_JOB_ID);
  });

  it("carries the id the STUB chose, not a value baked into the module", async () => {
    // A module that hardcoded STUB_JOB_ID, or echoed a shot id, passes the test above and fails this.
    const other = "8e7d6c5b-1111-4aaa-9bbb-0f1e2d3c4b5a";
    stubRunpod({ id: other });
    const body = await invoke(c);
    expect(body.jobId).toBe(other);
  });

  it("returns the PROVIDER job id, never the film job id off the invoke context", async () => {
    // narration-gen is the reason this test exists: `jobId` in its submit scope is
    // req.context.job_id, so the `jobId,` shorthand its siblings use would compile and ship the
    // wrong id. Applied to every module because the collision is a naming hazard, not a module.
    stubRunpod();
    const body = await invoke(c);
    expect(body.jobId).not.toBe(FILM_JOB_ID);
    expect(body.jobId).toBe(STUB_JOB_ID);
  });

  it("DISCRIMINATES: a refused submit carries no jobId at all", async () => {
    // Without this, `jobId` could be set unconditionally (to undefined, to a placeholder) and every
    // assertion above would still pass. A caller must be able to tell "here is the id" from "there
    // is no job".
    stubRunpod();
    const body = await invoke(c, {});
    expect(body.ok).toBe(false);
    expect(body.jobId).toBeUndefined();
  });

  it("DISCRIMINATES: a vendor /run that returns no id yields no jobId and no pending job", async () => {
    // The finish/speech family soft-degrades here (ok:true + a passthrough output) rather than
    // failing the chain, which is deliberate (#77/#249). Either shape is fine; what must never
    // happen is an envelope that claims a pending job while carrying a blank id.
    stubRunpod({});
    const body = await invoke(c);
    expect(body.jobId).toBeUndefined();
    expect(body.pending).not.toBe(true);
  });
});

describe("the population under test is the whole one (cf#289)", () => {
  it("covers every RunPod submitter not already covered by the motion.backend suite", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(import.meta.dirname, "..", "modules");

    const candidates = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "_shared")
      .map((e) => e.name);
    const read = (name: string): string => {
      try {
        return readFileSync(join(dir, name, "src", "index.ts"), "utf8");
      } catch {
        return "";
      }
    };

    // Derived, not asserted: a module is a RunPod submitter iff its worker names the RunPod API
    // host. Motion backends are identified the same way the #296 suite identifies them -- matching
    // the hook INSIDE the array, because keying on `hooks: ["motion.backend"]` matches eight of the
    // nine and silently drops local-gpu, which is dual-hook.
    const submitters = candidates.filter((n) => read(n).includes("api.runpod.ai"));
    const motion = candidates.filter((n) => /hooks:\s*\[[^\]]*"motion\.backend"/.test(read(n)));
    const mine = submitters.filter((n) => !motion.includes(n));
    const covered = CASES.map((c) => c.name);

    // DENOMINATOR, printed beside the result: a matcher that returns almost everything has failed
    // as completely as one returning nothing, and only the denominator shows either.
    console.log(
      JSON.stringify({
        modulesScanned: candidates.length,
        runpodSubmitters: submitters.length,
        motionBackends: motion.length,
        coveredHere: mine.length,
      }),
    );

    // POSITIVE CONTROL: the scan reads real files. A path or parse regression would otherwise make
    // every assertion below vacuous by leaving all three sets empty.
    expect(candidates.length).toBeGreaterThanOrEqual(26);
    expect(submitters).toContain("narration-gen");
    expect(submitters).toContain("seedance");
    // NEGATIVE CONTROL: the RunPod filter must reject non-submitters, or "nothing uncovered" below
    // becomes satisfiable by covering everything. local-gpu is the sharp case -- it is a motion
    // backend that submits to a LOCAL door, so its id is not a RunPod id at all.
    expect(submitters).not.toContain("cast-image");
    expect(submitters).not.toContain("local-gpu");
    // NEGATIVE CONTROL on the split: this file must not claim the motion half.
    expect(mine).not.toContain("seedance");

    // cf#289's table named five submitters. It is fourteen. Pinned so the corrected population
    // cannot quietly narrow back to the issue's version.
    expect(submitters.length).toBeGreaterThanOrEqual(14);
    expect(mine.sort()).toEqual(covered.slice().sort());
  });
});
