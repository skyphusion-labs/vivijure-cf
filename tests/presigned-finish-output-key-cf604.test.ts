// cf#604 -- A COMPLETED FINISH JOB THAT PRODUCED NO ARTIFACT KEY MUST DEGRADE, NOT DESTROY THE FILM.
//
// cf#604 filed two halves against finish-rife and finish-blender. They are NOT the same claim and
// this file ships only one of them, on purpose:
//
//   PART 2, SHIPPED HERE. Both modules returned `{ ok: false }` from the MODULE routes when a
//   COMPLETED job carried no artifact key. `ok:false` is safe at the DOOR layer and fatal at the
//   MODULE layer: vivijure-core failOrRetry classifies it deterministic and FAILS THE FILM on a
//   render that ran to completion and was billed. It also never reaches applyFinishOutput, so the
//   class was uncountable by construction rather than merely uncounted. finish-lipsync,
//   finish-upscale and speech-upscale pass the input clip through first; these two did not.
//
//   PART 1, REFUSED. cf#604 also asked for the cf#578 read, `finishedKey(out)` =
//   `clip_key ?? output_key`. NEITHER DOOR CAN EMIT THAT SHAPE, re-measured 2026-08-15 at the same
//   shas the cf#578 census recorded, on byte-identical trees:
//     vivijure-blender  4fa33fe  handler.py:389 `result_key = output_key or "presigned"`, :397
//                                `"clip_key": result_key`. `output_key` is never a response field.
//     vivijure-backend  f9dc930  harness/handler.py:471-476 is the ONE completed finish_clip return
//                                and hardcodes `clip_key`. docs/contract.md:249-268 argues the
//                                exclusion of presigned transport deliberately.
//   Widening the read would be changing code on a hypothesis, which is exactly what the EXEMPT
//   census in presigned-finish-output-key-cf578.test.ts says it declined to do. The cf#578 census is
//   therefore left untouched and still passes: this change adds no `output_key` parse anywhere.
//
// WHY THIS FILE IMPORTS NOTHING FROM THE FIX. Every assertion drives a SHIPPED worker over its real
// POST /invoke and POST /poll and reads the response body, so the file COMPILES AND RUNS UNCHANGED
// AT origin/main. That is what makes the fail-first evidence mean something: measured at 8638f5c
// before the fix, 4 of 12 cases RED (finish-rife and finish-blender, the two behaviour cases each),
// 8 GREEN, and the finish-upscale control GREEN in all 4 of its own.
//
// ASSERT THE DELTA, NOT THE ABSENCE. "no longer returns ok:false" is one-sided and passes when the
// output was eaten along with everything else. Every case below asserts the artifact reference the
// chain actually reads downstream, and the exact tag the degrade counter counts.
//
// POSITIVE CONTROL. finish-upscale is the in-tree reference cf#578 already fixed, and its door CAN
// emit the presigned shape. It is included unchanged and must be GREEN in every case BOTH before and
// after. A run where the reference also reddens is measuring the harness, not the modules.
import { describe, it, expect, vi, afterEach } from "vitest";

import finishRifeWorker from "../modules/finish-rife/src/index";
import finishBlenderWorker from "../modules/finish-blender/src/index";
import finishUpscaleWorker from "../modules/finish-upscale/src/index";

type Worker = { fetch(request: Request, env: never): Promise<Response> };

const STUB_JOB_ID = "cf604-0000-4bbb-8ccc-9aa8b7c6d5e4";
const ENV = { RUNPOD_API_KEY: "rpa_cf604_probe", RUNPOD_ENDPOINT_ID: "nbfj3iatp62ek9" };

const CLIP_IN = "renders/p_test/clips/shot_01.mp4";

/** NOT derivable from CLIP_IN by any rule in this repo: not <stem>_bl.mp4, not <stem>_up.mp4, not
 *  the input itself. On a derivable key, "honoured the door output" and "reconstructed it locally"
 *  are byte-identical; on this one they are not. */
const WRITTEN = "renders/p_test/clips/cf604_written_by_the_satellite.mp4";

/** The degrade tag summarizeFinish counts (vivijure-core src/film-model.ts:421-423). Identical
 *  across all five finish-class doors on purpose: one grep has to find the whole class. */
const DEGRADE_TAG = ["passthrough:no-output-key"];

interface Case {
  name: string;
  worker: Worker;
  input: Record<string, unknown>;
  /** Can this door actually return the artifact key in `output_key` with no `clip_key`?
   *  MEASURED per door, cited in the header. This is a fact about ANOTHER REPO AT A SHA, which is
   *  why it is a per-case datum here rather than a universal assertion. */
  presignedShape: "reachable" | "unreachable";
  /** The key the door says it WROTE. */
  written: string;
  /** The key the module was HANDED, i.e. what an honest degrade must pass through. */
  passedThrough: string;
  /** The credentialed (R2-mode) COMPLETED payload. */
  r2: Record<string, unknown>;
  /** The presigned-shaped COMPLETED payload: output_key only, no clip_key. */
  presigned: Record<string, unknown>;
}

const CASES: Case[] = [
  {
    name: "finish-rife",
    worker: finishRifeWorker as unknown as Worker,
    input: { shot_id: "shot_01", clip_key: CLIP_IN, src_fps: 16, frames: 80 },
    presignedShape: "unreachable",
    written: WRITTEN,
    passedThrough: CLIP_IN,
    r2: { ok: true, shot_id: "shot_01", clip_key: WRITTEN, out_fps: 32, frames: 160, applied: ["rife:2x"] },
    presigned: { ok: true, shot_id: "shot_01", output_key: WRITTEN, out_fps: 32, frames: 160, applied: ["rife:2x"] },
  },
  {
    name: "finish-blender",
    worker: finishBlenderWorker as unknown as Worker,
    input: { shot_id: "shot_01", clip_key: CLIP_IN, src_fps: 24, frames: 48 },
    presignedShape: "unreachable",
    written: WRITTEN,
    passedThrough: CLIP_IN,
    r2: { ok: true, shot_id: "shot_01", clip_key: WRITTEN, out_fps: 24, frames: 48, applied: ["blender:grade"] },
    presigned: { ok: true, shot_id: "shot_01", output_key: WRITTEN, out_fps: 24, frames: 48, applied: ["blender:grade"] },
  },
  {
    // THE IN-TREE REFERENCE, and the one door that CAN emit the presigned shape. Green before and
    // after; see POSITIVE CONTROL above.
    name: "finish-upscale",
    worker: finishUpscaleWorker as unknown as Worker,
    input: { shot_id: "shot_01", clip_key: CLIP_IN, src_fps: 16, frames: 80 },
    presignedShape: "reachable",
    written: WRITTEN,
    passedThrough: CLIP_IN,
    r2: { ok: true, shot_id: "shot_01", clip_key: WRITTEN, out_fps: 16, frames: 80, scale: 2, applied: ["upscale:2x"] },
    presigned: { ok: true, shot_id: "shot_01", output_key: WRITTEN, out_fps: 16, frames: 80, scale: 2, applied: ["upscale:2x"] },
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
    hook: "finish",
    input: c.input,
    config: {},
    context: { project: "p_test", job_id: "film_job_cf604" },
  });
  return { submitted, poll: async () => post(c.worker, "/poll", { poll: submitted.poll }), seen };
}

function outputOf(body: Record<string, unknown>): Record<string, unknown> {
  return (body.output ?? {}) as Record<string, unknown>;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(CASES)("$name: a COMPLETED job with no artifact key (cf#604)", (c) => {
  it("PRECONDITION: the submit yields a real poll token and the poll actually reaches /status", async () => {
    // Not decoration. If the submit refuses, every assertion below is about a module that never
    // polled, and a module returning ok:false unconditionally would pass a degrade case for the
    // wrong reason.
    const { submitted, poll, seen } = await submitThenPoll(c, c.r2);
    expect(submitted.error ?? "", c.name + " refused the submit").toBe("");
    expect(submitted.pending, c.name + " did not submit a job").toBe(true);
    expect(typeof submitted.poll).toBe("string");
    await poll();
    expect(seen.some((u) => u.endsWith("/run")), c.name + " never called /run; saw " + JSON.stringify(seen)).toBe(true);
    expect(seen.some((u) => u.includes("/status/")), c.name + " never polled; saw " + JSON.stringify(seen)).toBe(true);
  });

  it("CONTROL: the credentialed return shape completes and surfaces the written key, unchanged", async () => {
    // The happy path this change must not touch. It passes at origin/main; if it ever does not, the
    // claims below are being compared against a broken reference. This is also the assertion that
    // stops the fix from being "absorb everything": a door that DID produce an artifact must still
    // report a success, not a degrade.
    const { poll } = await submitThenPoll(c, c.r2);
    const body = await poll();
    expect(body.ok, c.name + " failed the credentialed shape").toBe(true);
    expect(body.pending).toBeUndefined();
    const out = outputOf(body);
    expect(out.clip_key, c.name + " lost the artifact the door wrote").toBe(c.written);
    expect(out.degraded, c.name + " reported a successful finish as degraded").toBeUndefined();
    expect(out.applied, c.name + " lost its provenance tag").toEqual((c.r2 as { applied: string[] }).applied);
  });

  it("DEGRADE: a COMPLETED job with an EMPTY output degrades honestly, it does not fail the chain", async () => {
    // THE CASE THAT WENT RED AT origin/main for finish-rife and finish-blender.
    //
    // `ok:false` here routes to the chain failure path and never touches the degrade counter, so the
    // whole class was invisible in telemetry while the film died. A polish step must never fail the
    // chain (#77/#249): pass the input through, carry the countable tag, set `degraded`.
    const { poll } = await submitThenPoll(c, { ok: true });
    const body = await poll();
    expect(body.ok, c.name + " hard-failed the chain on an empty polish result").toBe(true);
    expect(body.pending).toBeUndefined();
    const out = outputOf(body);
    expect(out.clip_key, c.name + " did not pass the input through").toBe(c.passedThrough);
    expect(out.degraded, c.name + " degraded silently, with no reason recorded (#77/#249)").toBeTruthy();
    // THE COUNTER. summarizeFinish (vivijure-core src/film-model.ts:421-423) counts a degraded shot
    // by its passthrough:-prefixed tag, and applyFinishOutput (:468-480) never reads output.degraded
    // at all -- so for the finish hook the TAG is the only degrade channel there is. An ok:false
    // never reaches applyFinishOutput, so before this fix the class was uncountable by construction,
    // not merely uncounted. Asserting the exact tag asserts the increment.
    expect(out.applied, c.name + " did not record a countable degrade").toEqual(DEGRADE_TAG);
  });

  it("PRESIGNED SHAPE (" + c.presignedShape + "): the film survives whichever field carries the key", async () => {
    // The two answers are DIFFERENT and both are asserted, because a single universal assertion here
    // would be a claim about another repo that this file cannot make.
    //
    // reachable (finish-upscale): the door really does return `output_key` and no `clip_key`, so the
    // module must resolve it and produce the SAME downstream artifact reference as the credentialed
    // path. Equality against the control, never "did not fail".
    //
    // unreachable (finish-rife, finish-blender): the door cannot emit this today, measured at the
    // shas in the header, so the module is NOT taught to read `output_key`. What IS asserted is the
    // consequence of part 2: if that ever changes -- a door version skew, a self-hosted door under
    // AGPL, a new transport -- the film DEGRADES ONE SHOT instead of dying. Before this change the
    // same input returned module ok:false and failOrRetry killed the render. That is the whole value
    // of the fix stated as a falsifiable property rather than as a promise in a PR body.
    const controlBody = await (await submitThenPoll(c, c.r2)).poll();
    vi.unstubAllGlobals();
    const presignedBody = await (await submitThenPoll(c, c.presigned)).poll();
    const presignedOut = outputOf(presignedBody);
    const controlOut = outputOf(controlBody);

    // Common to both answers, and the only thing cf#604 is really about: the render is not failed.
    expect(presignedBody.ok, c.name + " failed the film on a COMPLETED, billed render").toBe(true);
    expect(presignedBody.pending).toBeUndefined();

    if (c.presignedShape === "reachable") {
      expect(presignedOut.clip_key, c.name + " lost the artifact the door wrote").toBe(c.written);
      expect(presignedOut.clip_key, c.name + " presigned and credentialed disagree on the artifact").toBe(controlOut.clip_key);
      expect(presignedOut.degraded, c.name + " recorded a successful presigned finish as degraded").toBeUndefined();
      expect(presignedOut.clip_key, c.name + " silently passed the input through").not.toBe(c.passedThrough);
      expect(presignedOut.applied, c.name + " lost its provenance tag on the presigned branch").toEqual(controlOut.applied);
    } else {
      // An honest degrade, NOT a silent success: the grade or the interpolation really was lost, and
      // the tag is what makes that countable. Fabricating the written key from `output_key` here is
      // precisely the code-on-a-hypothesis this change refused to write.
      expect(presignedOut.clip_key, c.name + " did not pass the input through").toBe(c.passedThrough);
      expect(presignedOut.degraded, c.name + " degraded silently (#77/#249)").toBeTruthy();
      expect(presignedOut.applied, c.name + " did not record a countable degrade").toEqual(DEGRADE_TAG);
      expect(presignedOut.clip_key, c.name + " invented an artifact reference the door never wrote").not.toBe(c.written);
    }
  });
});


// ------------------------------------------------------------------------------------------------
// THE DENOMINATOR, DERIVED FROM SOURCE AND CLASSIFIED COMMENT-VERSUS-CODE (cf#604)
//
// The population is the finish-class doors, derived by the same predicate the cf#578 census uses so
// the two cannot drift into two different populations. 3 of 5 passed an artifact-less COMPLETED job
// through before this change; 5 of 5 after.
//
// A raw grep CANNOT produce that number. Both modules changed here now carry the string
// `no-output-key` inside their new rationale COMMENTS as well as in the code, so a naive matcher
// scores them regardless of what the code does -- the same false positive that made a repo with good
// historical comments read as unusually broken. The comment/code split is asserted below rather than
// assumed, and the raw-versus-stripped delta is itself the control that the stripper is working.
describe("the artifact-less COMPLETED contract is 5 of 5 (cf#604 denominator)", () => {
  it("every finish-class door passes the source clip through before it fails", async () => {
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

    /** Strip block and line comments. Deliberately simple and deliberately NOT regex-clever: it is
     *  checked below by requiring it to actually REMOVE something on the two modules whose comments
     *  are known to mention the token. A stripper that silently stopped stripping would leave every
     *  count identical, which is what a broken one produces. */
    const codeOnly = (s: string): string =>
      s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1 ");

    // Same finish-class predicate as the cf#578 census: parses a COMPLETED envelope for a terminal
    // artifact key AND reaches RunPod (directly or through the shared route helper).
    const finishClass = candidates.filter(
      (n) => src(n).includes("parseBackendOutput(s.output)") &&
        (src(n).includes("api.runpod.ai") || src(n).includes("_shared/runpod-route")),
    );
    // The behaviour under test, anchored on the CALL, not on a mention of the reason string.
    const PASSTHROUGH_CALL = 'pollPassthrough(st, "no-output-key")';
    const passesThrough = finishClass.filter((n) => codeOnly(src(n)).includes(PASSTHROUGH_CALL));

    console.log(JSON.stringify({
      modulesScanned: candidates.length,
      finishClass: finishClass.length,
      passesThrough: passesThrough.length,
      finishClassNames: finishClass.slice().sort(),
    }));

    // POSITIVE CONTROL: the scan reads real files. Without it a path regression empties every set and
    // every claim below passes vacuously on empty arrays.
    expect(candidates.length, "the module scan read nothing").toBeGreaterThanOrEqual(26);
    expect(finishClass.length, "the finish-class matcher found nothing").toBeGreaterThanOrEqual(5);

    // THE CLAIM: all of them, with the five named so a SIXTH door joining the class reddens this
    // rather than quietly moving the denominator.
    expect(finishClass.slice().sort()).toEqual(
      ["finish-blender", "finish-lipsync", "finish-rife", "finish-upscale", "speech-upscale"],
    );
    for (const n of finishClass) {
      expect(passesThrough, n + " fails the film on a COMPLETED job that produced no artifact").toContain(n);
    }

    // NEGATIVE CONTROL: a module outside the class must NOT match, or the matcher is not
    // discriminating and the 5 of 5 above is an artifact of matching everything.
    expect(finishClass, "the finish-class predicate matched a non-finish module").not.toContain("keyframe");
    expect(codeOnly(src("keyframe")).includes(PASSTHROUGH_CALL), "keyframe matched the finish behaviour").toBe(false);

    // COMMENT-VERSUS-CODE CONTROL. finish-rife and finish-blender mention `no-output-key` in their
    // cf#604 rationale comments as well as calling it, so the raw text must contain strictly MORE
    // occurrences than the code does. If these two ever came out equal, the stripper stopped working
    // and every count above is a count of prose.
    const occurrences = (s: string): number => s.split("no-output-key").length - 1;
    for (const n of ["finish-rife", "finish-blender"]) {
      const raw = occurrences(src(n));
      const code = occurrences(codeOnly(src(n)));
      expect(raw, n + ": expected the rationale comment to mention the reason string").toBeGreaterThan(code);
      expect(code, n + ": expected exactly one live passthrough call site").toBe(1);
    }
  });
});
