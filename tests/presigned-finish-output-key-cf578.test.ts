// cf#578 -- PRESIGNED FINISH: the satellite returns `output_key` and NO `clip_key`, and two of the
// finish doors reject it. The job burns the GPU, PUTs the artifact, and THEN fails on the response
// parse; and because it comes back ok:false it routes to the chain failure path instead of the
// honest-degrade path, so the whole class is invisible to degrade telemetry.
//
// WHY THIS FILE IMPORTS NOTHING FROM THE FIX. Every assertion drives a SHIPPED worker over its real
// POST /invoke and POST /poll and reads the response body, so the file COMPILES AND RUNS UNCHANGED
// AT origin/main. That is what makes the fail-first evidence mean something: the same file, the same
// stub, must go RED on the presigned shape before the fix and GREEN after. A test that only exists
// after the fix has demonstrated nothing.
//
// ASSERT THE DELTA, NOT THE ABSENCE. "no longer throws" is an absence check and passes when the
// output was eaten along with everything else. The claim here is an EQUALITY: the presigned response
// must yield the SAME downstream artifact reference the credentialed response yields.
//
// NON-DEFAULT VALUE. The key the stub returns is deliberately NOT the key the module derives from
// its own input (upscaledKey appends _up). On a derivable key, "honoured the handler output" and
// "reconstructed it locally" are byte-identical; on this one they are not.
//
// POSITIVE CONTROL. speech-upscale is the in-tree reference implementation and is included
// unchanged: it already does pollPassthrough(st, "no-output-key"). It must be GREEN on every case
// here BOTH before and after the fix. A run where the reference also reddens is measuring the
// harness, not the modules.
//
// MEASURED SATELLITE SHAPES (cf#578, and rollins on cf#312):
//   R2 mode        -> { ok: true, clip_key: <written key>, applied: [...] }
//   presigned mode -> { ok: true, output_key: <written key> }   // no clip_key, no applied
import { describe, it, expect, vi, afterEach } from "vitest";

import finishUpscaleWorker from "../modules/finish-upscale/src/index";
import finishLipsyncWorker from "../modules/finish-lipsync/src/index";
import speechUpscaleWorker from "../modules/speech-upscale/src/index";

type Worker = { fetch(request: Request, env: never): Promise<Response> };

const STUB_JOB_ID = "cf578-0000-4bbb-8ccc-9aa8b7c6d5e4";
const ENV = { RUNPOD_API_KEY: "rpa_cf578_probe", RUNPOD_ENDPOINT_ID: "nbfj3iatp62ek9" };

const CLIP_IN = "renders/p_test/clips/shot_01.mp4";
const AUDIO_IN = "renders/p_test/dialogue/shot_01.wav";

/** NOT derivable from CLIP_IN by any rule in this repo: not <stem>_up.mp4, not the input itself.
 *  See NON-DEFAULT VALUE above. */
const WRITTEN_CLIP = "renders/p_test/clips/cf578_written_by_the_satellite.mp4";
const WRITTEN_AUDIO = "renders/p_test/dialogue/cf578_written_by_the_satellite.wav";

interface Case {
  name: string;
  worker: Worker;
  hook: string;
  input: Record<string, unknown>;
  config: Record<string, unknown>;
  /** The key the satellite says it WROTE, in this module units. */
  written: string;
  /** The key the module was HANDED, i.e. what an honest degrade must pass through. */
  passedThrough: string;
  /** The output field the chain reads downstream. */
  outField: string;
  /** What the applied array must be after an honest degrade.
   *
   *  PER CASE, NOT A UNIVERSAL, and that is the point. The finish-hook degrade counter is
   *  summarizeFinish (vivijure-core src/film-model.ts:421-423) and it counts shots whose tags
   *  START WITH passthrough: -- so for the two finish doors the exact tag IS the counter, and
   *  asserting it is asserting that the degrade is countable at all. speech-upscale records an
   *  EMPTY applied and carries its reason in degraded; its summarizer is a different one. One
   *  universal assertion here would pass VACUOUSLY on the empty array and prove nothing about
   *  either module. */
  degradeApplied: string[];
  /** The credentialed (R2-mode) COMPLETED payload. */
  r2: Record<string, unknown>;
  /** The presigned COMPLETED payload: output_key only, no clip_key, no applied. */
  presigned: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    name: "finish-upscale",
    worker: finishUpscaleWorker as unknown as Worker,
    hook: "finish",
    input: { shot_id: "shot_01", clip_key: CLIP_IN, src_fps: 16, frames: 80 },
    config: {},
    written: WRITTEN_CLIP,
    passedThrough: CLIP_IN,
    outField: "clip_key",
    degradeApplied: ["passthrough:no-output-key"],
    r2: { ok: true, shot_id: "shot_01", clip_key: WRITTEN_CLIP, out_fps: 16, frames: 80, bytes: 1121158, scale: 2, model: "realesr-animevideov3", encoder: "h264_nvenc", applied: ["upscale:2x"] },
    // MEASURED, vivijure-upscale@d34135d handler.py:770. Note it drops `applied` on this branch,
    // which the R2 branch at :674 sends. That asymmetry is real and is why the module must not
    // fabricate a tag when none arrives.
    presigned: { ok: true, output_key: WRITTEN_CLIP, bytes: 1121158, frames: 80, scale: 2, model: "realesr-animevideov3", encoder: "h264_nvenc" },
  },
  {
    name: "finish-lipsync",
    worker: finishLipsyncWorker as unknown as Worker,
    hook: "finish",
    input: { shot_id: "shot_01", clip_key: CLIP_IN, audio_key: AUDIO_IN, src_fps: 16, frames: 80 },
    config: {},
    written: WRITTEN_CLIP,
    passedThrough: CLIP_IN,
    outField: "clip_key",
    degradeApplied: ["passthrough:no-output-key"],
    // MEASURED, vivijure-musetalk@c97bd61 handler.py:671 (R2) and :717 (presigned). Unlike upscale,
    // musetalk KEEPS `applied` on the presigned branch. The two satellites are NOT symmetric, and a
    // fixture copied from one to the other would test a shape that does not exist.
    r2: { ok: true, clip_key: WRITTEN_CLIP, bytes: 998877, version: "v15", applied: ["lipsync:v15"] },
    presigned: { ok: true, output_key: WRITTEN_CLIP, bytes: 998877, version: "v15", applied: ["lipsync:v15"] },
  },
  {
    // THE IN-TREE REFERENCE. Green before and after; see POSITIVE CONTROL above.
    name: "speech-upscale",
    worker: speechUpscaleWorker as unknown as Worker,
    hook: "speech",
    input: { shot_id: "shot_01", audio_key: AUDIO_IN },
    config: { enable: true },
    written: WRITTEN_AUDIO,
    passedThrough: AUDIO_IN,
    outField: "audio_key",
    degradeApplied: [],
    // MEASURED, vivijure-audio-upscale@f2b3908 handler.py:315 (R2) and :358 (presigned). The R2
    // branch returns BOTH `output_key` and `audio_key` carrying the same value; the presigned
    // branch returns `output_key` only. This module never had a `clip_key` shape, which is why it
    // is the one written correctly and why it is the control here.
    r2: { ok: true, output_key: WRITTEN_AUDIO, audio_key: WRITTEN_AUDIO, bytes: 220500, sr: 44100, applied: ["speech-upscale:resemble-enhance"] },
    presigned: { ok: true, output_key: WRITTEN_AUDIO, bytes: 220500, sr: 44100, applied: ["speech-upscale:resemble-enhance"] },
  },
];

/** ONE stub. /run always succeeds so every case reaches a real poll token; /status answers COMPLETED
 *  with whatever payload the case under test configures. Records every URL asked for, so "the module
 *  never polled" and "the module polled and answered wrongly" cannot be confused: they produce the
 *  same body. */
function stub(output: unknown) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    seen.push(u);
    const jsonHeaders = { "content-type": "application/json" };
    if (u.endsWith("/run")) return new Response(JSON.stringify({ id: STUB_JOB_ID }), { status: 200, headers: jsonHeaders });
    if (u.includes("/status/")) {
      return new Response(JSON.stringify({ status: "COMPLETED", output }), { status: 200, headers: jsonHeaders });
    }
    return new Response(JSON.stringify({}), { status: 200, headers: jsonHeaders });
  });
  return seen;
}

async function post(worker: Worker, path: string, body: unknown) {
  const res = await worker.fetch(
    new Request("https://m.internal" + path, { method: "POST", body: JSON.stringify(body) }),
    ENV as never,
  );
  return (await res.json()) as Record<string, unknown>;
}

/** Submit for real, take the module own poll token, then poll for real. Nothing about the token
 *  format is known here, which is what keeps this a test of shipped behaviour. */
async function submitThenPoll(c: Case, output: unknown) {
  const seen = stub(output);
  const submitted = await post(c.worker, "/invoke", {
    hook: c.hook,
    input: c.input,
    config: c.config,
    context: { project: "p_test", job_id: "film_job_cf578" },
  });
  return { submitted, poll: async () => post(c.worker, "/poll", { poll: submitted.poll }), seen };
}

function outputOf(body: Record<string, unknown>): Record<string, unknown> {
  return (body.output ?? {}) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(CASES)("$name: a presigned satellite return (cf#578)", (c) => {
  it("PRECONDITION: the submit yields a real poll token and the poll actually reaches /status", async () => {
    // Not decoration. If the submit refuses, every assertion below is about a module that never
    // polled, and a module returning ok:false unconditionally would pass the degrade case for the
    // wrong reason.
    const { submitted, poll, seen } = await submitThenPoll(c, c.r2);
    expect(submitted.error ?? "", c.name + " refused the submit").toBe("");
    expect(submitted.pending, c.name + " did not submit a job").toBe(true);
    expect(typeof submitted.poll).toBe("string");
    await poll();
    expect(seen.some((u) => u.endsWith("/run")), c.name + " never called /run; saw " + JSON.stringify(seen)).toBe(true);
    expect(seen.some((u) => u.includes("/status/")), c.name + " never polled; saw " + JSON.stringify(seen)).toBe(true);
  });

  it("CONTROL: the credentialed R2 return shape completes and surfaces the written key", async () => {
    // The baseline the presigned case is compared AGAINST. This passes at origin/main; if it ever
    // does not, the claim below is being compared to a broken reference.
    const { poll } = await submitThenPoll(c, c.r2);
    const body = await poll();
    expect(body.ok, c.name + " failed the credentialed shape").toBe(true);
    expect(body.pending).toBeUndefined();
    const out = outputOf(body);
    expect(out[c.outField]).toBe(c.written);
    expect(out.degraded, c.name + " reported a successful finish as degraded").toBeUndefined();
  });

  it("CLAIM: the PRESIGNED return shape yields the SAME downstream artifact reference", async () => {
    // THE ASSERTION THAT GOES RED AT origin/main for finish-upscale and finish-lipsync.
    // Equality against the control, not "did not throw": an absence check passes when the output
    // vanished with everything else.
    const controlBody = await (await submitThenPoll(c, c.r2)).poll();
    vi.unstubAllGlobals();
    const presignedBody = await (await submitThenPoll(c, c.presigned)).poll();

    expect(presignedBody.ok, c.name + " rejected a valid presigned satellite return").toBe(true);
    expect(presignedBody.pending).toBeUndefined();

    const presignedOut = outputOf(presignedBody);
    const controlOut = outputOf(controlBody);
    expect(presignedOut[c.outField], c.name + " lost the artifact the satellite wrote").toBe(c.written);
    expect(presignedOut[c.outField], c.name + " presigned and credentialed disagree on the artifact").toBe(controlOut[c.outField]);

    // A SUCCESS, NOT A DEGRADE. The GPU ran and the artifact landed; recording it as degraded would
    // be the same defect wearing the opposite coat.
    expect(presignedOut.degraded, c.name + " recorded a successful presigned finish as degraded").toBeUndefined();
    // And never the passthrough of the INPUT, which is what a silent fallback would surface.
    expect(presignedOut[c.outField], c.name + " silently passed the input through").not.toBe(c.passedThrough);

    // THE PROVENANCE HALF OF THE SAME DELTA. vivijure-upscale presigned branch sends NO applied
    // array at all (handler.py:770) while the R2 branch sends ["upscale:2x"] (:674). A fix that
    // mapped only the key name would have passed every assertion above and still lost the tag on
    // every presigned render, silently -- an absence wearing the appearance of success, one field
    // over from the one being fixed. musetalk keeps applied on both branches, so this assertion is
    // discriminating for finish-upscale and a no-change control for the other two.
    expect(presignedOut.applied, c.name + " lost its provenance tag on the presigned branch").toEqual(controlOut.applied);
    expect((presignedOut.applied as string[]).length, c.name + " reported a completed finish with no tag at all").toBeGreaterThan(0);
  });

  it("DEGRADE: a genuinely EMPTY satellite output degrades honestly, it does not fail the chain", async () => {
    // The second defect wearing the first one clothes. ok:false routes to the chain failure path and
    // never touches the degrade counter, so this whole class is invisible in telemetry. A polish step
    // must never fail the chain: pass the input through, applied EMPTY (no fake tag), degraded SET.
    const { poll } = await submitThenPoll(c, { ok: true });
    const body = await poll();
    expect(body.ok, c.name + " hard-failed the chain on an empty polish result").toBe(true);
    expect(body.pending).toBeUndefined();
    const out = outputOf(body);
    expect(out[c.outField], c.name + " did not pass the input through").toBe(c.passedThrough);
    expect(out.degraded, c.name + " degraded silently, with no reason recorded (#77/#249)").toBeTruthy();
    // THE COUNTER. summarizeFinish (vivijure-core src/film-model.ts:421-423) counts a degraded shot
    // by its passthrough:-prefixed tag, and applyFinishOutput (:468-480) never reads output.degraded
    // at all -- so for the finish hook the TAG is the only degrade channel there is. An ok:false
    // never reaches applyFinishOutput, so before the fix this class of failure was uncountable by
    // construction, not merely uncounted. Asserting the exact tag asserts the increment.
    expect(out.applied, c.name + " did not record a countable degrade").toEqual(c.degradeApplied);
  });
});


// ------------------------------------------------------------------------------------------------
// THE DENOMINATOR, DERIVED FROM SOURCE RATHER THAN ASSERTED (cf#578)
//
// cf#578 filed this as "two of three". A review comment on cf#449 raised it to four, counting every
// module that hard-fails on a missing `clip_key`. BOTH numbers are wrong as a population, and in
// opposite directions, so the census is derived here instead of transcribed.
//
// MEASURED SATELLITE SIDE, at the HEAD of each default branch:
//   vivijure-upscale       d34135d  presigned returns output_key, NO clip_key   -> finish-upscale  AFFECTED
//   vivijure-musetalk      c97bd61  presigned returns output_key, NO clip_key   -> finish-lipsync  AFFECTED
//   vivijure-audio-upscale f2b3908  output_key in both modes, never a clip_key  -> speech-upscale  ALREADY CORRECT
//   vivijure-blender       4fa33fe  ONE unified return, clip_key in BOTH modes  -> finish-blender  NOT AFFECTED
//   vivijure-backend       f9dc930  NO presigned branch anywhere (0 hits for
//                                   presigned/video_url/output_url/audio_url
//                                   across src/, against 710 _key and 1496 def
//                                   hits as the positive control)             -> finish-rife     NOT IN POPULATION
//
// So the affected population is 2 of the 5 finish-class doors. finish-blender and finish-rife hard-
// fail on a missing clip_key too, and including them would have widened the scope to make a number
// work: their satellites cannot produce the shape. The census below re-derives the 5 from source so
// a NEW finish door cannot join the class unnoticed.
describe("the finish-class population is derived, not asserted (cf#578 denominator)", () => {
  it("every finish-class door that parses a terminal artifact key is accounted for", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(import.meta.dirname, "..", "modules");

    const candidates = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "_shared")
      .map((e) => e.name);
    const read = (name: string, file: string): string => {
      try {
        return readFileSync(join(dir, name, "src", file), "utf8");
      } catch {
        return "";
      }
    };
    const src = (name: string): string => read(name, "index.ts");
    // The parse layer lives in a per-module helper, never shared: finish.ts, lipsync.ts, speech.ts.
    const helper = (name: string): string =>
      read(name, "finish.ts") + read(name, "lipsync.ts") + read(name, "speech.ts");

    // A finish-class door is one that parses a COMPLETED job envelope for a terminal artifact key.
    // Same reach predicate the cf#398 census uses (RunPod host OR the shared route helper), so the
    // two cannot drift into two different populations. Derived, so a NEW finish door joins the
    // census by existing rather than by someone remembering to add it here.
    const finishClass = candidates.filter(
      (n) => src(n).includes("parseBackendOutput(s.output)") &&
        (src(n).includes("api.runpod.ai") || src(n).includes("_shared/runpod-route")),
    );
    // Accepts the presigned shape iff its PARSE LAYER reads output_key OFF THE RESPONSE.
    // The naive matcher (helper mentions output_key at all) scores finish-rife and finish-blender
    // as fixed too, because both SEND an output_key in the request body: it counted 4 of 5 before
    // this was tightened. Anchoring on the parse expression is what lets this matcher go red.
    const READS_RESPONSE = "output_key: typeof o.output_key";
    const readsOutputKey = finishClass.filter((n) => helper(n).includes(READS_RESPONSE));

    // THE AFFECTED POPULATION, and the two the sweep DELIBERATELY does not touch.
    //
    // A door is affected iff its satellite can actually emit output_key without clip_key. That is a
    // fact about the OTHER repo, so it cannot be asserted here; it is recorded above with the sha it
    // was measured at. What IS assertable here is that the class is fully classified: every
    // finish-class door is either fixed or explicitly exempt, so a SIXTH door cannot join silently.
    const AFFECTED = ["finish-lipsync", "finish-upscale"];
    // NOT a to-do list. finish-rife talks to vivijure-backend, which has no presigned branch at all;
    // finish-blender talks to vivijure-blender, whose single return path emits clip_key in BOTH
    // modes. Widening the fix to them to make a count look tidier would be changing code on a
    // hypothesis, and the two of them are why the four-hard-failing-modules number is not the
    // cf#578 population.
    const EXEMPT = ["finish-blender", "finish-rife"];

    console.log(JSON.stringify({ modulesScanned: candidates.length, finishClass: finishClass.length, readsOutputKey: readsOutputKey.length, finishClassNames: finishClass.slice().sort() }));

    // POSITIVE CONTROL: the scan reads real files. Without it a path regression empties every set
    // and every claim below passes vacuously on empty arrays.
    expect(candidates.length, "the module scan read nothing").toBeGreaterThanOrEqual(26);
    expect(finishClass.length, "the finish-class matcher found nothing").toBeGreaterThanOrEqual(5);

    // NO UNCLASSIFIED DOOR. Union of the two lists must be the whole class, both ways.
    expect(finishClass.slice().sort(), "a finish-class door is neither fixed nor exempt")
      .toEqual(AFFECTED.concat(EXEMPT).concat(["speech-upscale"]).sort());

    // THE CLAIM: both affected doors read output_key at the PARSE layer, and speech-upscale, which
    // was already correct, still does. Three of five, and the five is printed above.
    for (const n of AFFECTED.concat(["speech-upscale"])) {
      expect(readsOutputKey, n + " drops output_key at its parse layer").toContain(n);
    }

    // NO HALF FIX. A parse layer that declares output_key while the poll site still branches on
    // clip_key alone reads as fixed to the matcher above and is not. Mutation-checked: reverting
    // finishedKey to return clip_key only leaves the census GREEN, which is exactly the blind spot
    // this assertion covers.
    for (const n of AFFECTED) {
      expect(src(n), n + " parses output_key but never resolves it at the poll site").toContain("finishedKey(");
    }
  });
});
