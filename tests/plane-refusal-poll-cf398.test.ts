// A PLANE REFUSAL ON THE POLL PATH MUST NOT READ AS "STILL RUNNING" (cf#398, the cf-side half of
// cp#288). Fourteen modules, one stub, three configurations, opposite outcomes.
//
// ------------------------------------------------------------------------------------------------
// THE DEFECT. Every RunPod-reaching module's poll returns `{ ok: true, pending: true }` when it
// cannot read the upstream. Correct while the upstream was RunPod. Once the upstream is the plane
// proxy, a plane that is degraded, mid-deploy, or refusing this tenant produces a render that never
// completes and never errors: no error anywhere, nothing logged as a failure, a panel showing work
// in progress, and a job that stays pending forever. Nothing goes red when this is missing, which is
// why it needs a probe that can.
//
// WHY THIS FILE IMPORTS NOTHING FROM THE FIX. Every behavioural assertion below drives a shipped
// worker over its real POST /invoke and POST /poll and reads the response body. The file therefore
// COMPILES AND RUNS UNCHANGED AT origin/main, which is what makes the fail-first evidence mean
// something: the same file, the same stub, run against the unfixed tree, must go red on REFUSED and
// green on the two controls. A probe that only exists after the fix cannot demonstrate that.
//
// THE DISCRIMINATING PAIRS, one axis each (a fixture that varies two things at once proves neither):
//
//   REFUSED vs BLIND   identical 503, identical body. ONLY the header differs.
//                      -> refusal is terminal and named; no header keeps today's pending.
//   REFUSED vs DIRECT  identical 503, identical body, identical header. ONLY the route differs.
//                      -> the self-host door is untouched, because there is no plane on it.
//
// No wrong implementation satisfies all three. A module that ignores the header fails REFUSED. One
// that treats every poll failure as a refusal fails BLIND, which would make a RunPod blip look like
// our outage: a different wrong answer, not a fix. One that reads the header without checking the
// route fails DIRECT, changing a self-hoster's render outcome on a header a vendor sent.
//
// NON-DEFAULT REASON. The header value is echoed verbatim into the assertion, and the value used is
// not a reason the plane can emit and appears in neither repo. On one of the plane's real reasons,
// "the module reported what it was told" and "the module printed a canned string" are
// indistinguishable; on this one they are not.
//
// MEASURED PLANE CONTRACT, vivijure-control-plane@53152477242c94fbd0f67120a53bc2640ca3d59c:
// refusals are non-2xx with `x-vivijure-plane-refusal: <reason>` and a JSON body; a transport
// failure REACHING RunPod is deliberately 502 with NO header. So a refusal body PARSES, and the
// module's `catch` is not the branch a refusal takes -- it falls through the not-COMPLETED branch
// instead. The BLIND control below reproduces exactly that, which is why it is a 503 with a valid
// body rather than a thrown fetch.
import { describe, it, expect, vi, afterEach } from "vitest";

import keyframeWorker from "../modules/keyframe/src/index";
import finishUpscaleWorker from "../modules/finish-upscale/src/index";
import finishRifeWorker from "../modules/finish-rife/src/index";
import finishLipsyncWorker from "../modules/finish-lipsync/src/index";
import speechUpscaleWorker from "../modules/speech-upscale/src/index";
import narrationGenWorker from "../modules/narration-gen/src/index";
import seedanceWorker from "../modules/seedance/src/index";
import klingWorker from "../modules/kling/src/index";
import viduWorker from "../modules/vidu-q3/src/index";
import veoWorker from "../modules/google-veo/src/index";
import hailuoWorker from "../modules/minimax-hailuo/src/index";
import wanWorker from "../modules/alibaba-wan/src/index";
import wanLoraWorker from "../modules/alibaba-wan-lora/src/index";
import ownGpuWorker from "../modules/own-gpu/src/index";

type Worker = { fetch(request: Request, env: never): Promise<Response> };

const PLANE_REFUSAL_HEADER = "x-vivijure-plane-refusal";
/** Nowhere in either repo, and not a reason the plane can emit. See NON-DEFAULT REASON above. */
const PROBE_REASON = "cf398-probe-refusal-not-a-real-plane-reason";
/** A base that resolves nowhere, so a URL built from it cannot be a coincidence. */
const PROXY_BASE = "https://proxy-probe.cf398.invalid/api/runpod/v2";
const PROXY_TOKEN = "vjp1.ten_cf398probe.deadbeefcafe";
const DIRECT_KEY = "rpa_direct_key_cf398";
const STUB_JOB_ID = "c4d3e2f1-0000-4bbb-8ccc-9aa8b7c6d5e4";

/** The RunPod key is present in EVERY env below, deliberately: a proxied module must refuse rather
 *  than find another way to RunPod, and a config without the key cannot tell those apart. */
const DIRECT_ENV = { RUNPOD_API_KEY: DIRECT_KEY };
const PROXIED_ENV = { RUNPOD_API_KEY: DIRECT_KEY, RUNPOD_PROXY_BASE: PROXY_BASE, RUNPOD_PROXY_TOKEN: PROXY_TOKEN };
/** RUNPOD_WORKERS_MAX stays unset everywhere: set, the submit detours through the endpoint
 *  reconcile, which targets the RunPod management API and is not the path under test. */
const ENDPOINT = { RUNPOD_ENDPOINT_ID: "nbfj3iatp62ek9" };
/** Harmless on modules that do not declare it; required by the ones that write their clip on the
 *  submit path. An unused binding cannot change a branch. */
const R2 = { R2_RENDERS: { put: async () => undefined } };

interface Case {
  name: string;
  worker: Worker;
  hook: string;
  /** Bindings this module needs BEYOND the credential/route pair the three configurations supply. */
  extraEnv: Record<string, unknown>;
  input: Record<string, unknown>;
  config: Record<string, unknown>;
}

/** Every module that reaches RunPod. Fixtures are the ones already proven by
 *  runpod-submitter-jobid-289 and motion-backend-submit-jobid-296; those two files derive this same
 *  population from source, and the census at the bottom of THIS file re-derives it independently
 *  rather than trusting the list above it. */
const MOTION_INPUT = { shot_id: "shot_01", prompt: "a slow push in", keyframe_url: "https://example.invalid/kf.png", seconds: 5 };

const CASES: Case[] = [
  { name: "keyframe", worker: keyframeWorker as unknown as Worker, hook: "keyframe", extraEnv: ENDPOINT, input: { project: "p_test", bundle_key: "renders/p_test/bundle.json" }, config: {} },
  { name: "finish-upscale", worker: finishUpscaleWorker as unknown as Worker, hook: "finish", extraEnv: ENDPOINT, input: { shot_id: "shot_01", clip_key: "renders/p_test/clips/shot_01.mp4" }, config: {} },
  // finish-rife no-ops deliberately when nothing is enabled, so the config must turn something on or
  // this exercises the no-op path instead of the poll path.
  { name: "finish-rife", worker: finishRifeWorker as unknown as Worker, hook: "finish", extraEnv: ENDPOINT, input: { shot_id: "shot_01", clip_key: "renders/p_test/clips/shot_01.mp4" }, config: { interpolate: true } },
  // finish-lipsync no-ops without dialogue audio for the shot, same reasoning.
  { name: "finish-lipsync", worker: finishLipsyncWorker as unknown as Worker, hook: "finish", extraEnv: ENDPOINT, input: { shot_id: "shot_01", clip_key: "renders/p_test/clips/shot_01.mp4", audio_key: "renders/p_test/dialogue/shot_01.wav" }, config: {} },
  // speech-upscale is opt-in; `enable` off is a clean no-op, not a submit.
  { name: "speech-upscale", worker: speechUpscaleWorker as unknown as Worker, hook: "speech", extraEnv: ENDPOINT, input: { shot_id: "shot_01", audio_key: "renders/p_test/dialogue/shot_01.wav" }, config: { enable: true } },
  // narration-gen rides a fixed hosted slug, so it needs no endpoint id. config.text is REQUIRED for
  // a real submit: with neither text nor storyboard scenes it refuses before it reaches /run.
  { name: "narration-gen", worker: narrationGenWorker as unknown as Worker, hook: "score", extraEnv: {}, input: { film_key: "renders/p_test/film.mp4", seconds: 30 }, config: { text: "The city exhales, and the neon holds its breath." } },
  { name: "seedance", worker: seedanceWorker as unknown as Worker, hook: "motion.backend", extraEnv: R2, input: MOTION_INPUT, config: {} },
  { name: "kling", worker: klingWorker as unknown as Worker, hook: "motion.backend", extraEnv: R2, input: MOTION_INPUT, config: {} },
  { name: "vidu-q3", worker: viduWorker as unknown as Worker, hook: "motion.backend", extraEnv: R2, input: MOTION_INPUT, config: {} },
  { name: "google-veo", worker: veoWorker as unknown as Worker, hook: "motion.backend", extraEnv: R2, input: MOTION_INPUT, config: {} },
  { name: "minimax-hailuo", worker: hailuoWorker as unknown as Worker, hook: "motion.backend", extraEnv: R2, input: MOTION_INPUT, config: {} },
  { name: "alibaba-wan", worker: wanWorker as unknown as Worker, hook: "motion.backend", extraEnv: R2, input: MOTION_INPUT, config: {} },
  { name: "alibaba-wan-lora", worker: wanLoraWorker as unknown as Worker, hook: "motion.backend", extraEnv: R2, input: MOTION_INPUT, config: {} },
  // own-gpu drives OUR backend endpoint, so it needs the endpoint id as well.
  { name: "own-gpu", worker: ownGpuWorker as unknown as Worker, hook: "motion.backend", extraEnv: { ...ENDPOINT, ...R2 }, input: MOTION_INPUT, config: {} },
];

/**
 * ONE stub. `/run` always succeeds so every case reaches a real poll token; `/status/` answers with
 * whatever the case configures. Records the URLs it was asked for, so "the module never polled" and
 * "the module polled and answered wrongly" cannot be confused (they produce the same body).
 */
function stub(statusResponse: () => Response) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    seen.push(u);
    if (u.endsWith("/run")) {
      return new Response(JSON.stringify({ id: STUB_JOB_ID }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (u.includes("/status/")) return statusResponse();
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  });
  return seen;
}

/** Byte-identical body and status in both; only the header differs. That is the whole experiment. */
const REFUSAL_BODY = JSON.stringify({ error: "plane refusal: " + PROBE_REASON, detail: "probe" });
const refusedResponse = () =>
  new Response(REFUSAL_BODY, { status: 503, headers: { "content-type": "application/json", [PLANE_REFUSAL_HEADER]: PROBE_REASON } });
const blindResponse = () =>
  new Response(REFUSAL_BODY, { status: 503, headers: { "content-type": "application/json" } });

async function post(worker: Worker, env: Record<string, unknown>, path: string, body: unknown) {
  const res = await worker.fetch(
    new Request("https://m.internal" + path, { method: "POST", body: JSON.stringify(body) }),
    env as never,
  );
  return (await res.json()) as Record<string, unknown>;
}

/** Submit for real, take the module's own poll token, then poll for real. Nothing about the token
 *  format is known here, which is what keeps this a test of shipped behaviour. */
async function submitThenPoll(c: Case, env: Record<string, unknown>, statusResponse: () => Response) {
  const seen = stub(statusResponse);
  const submitted = await post(c.worker, env, "/invoke", {
    hook: c.hook,
    input: c.input,
    config: c.config,
    context: { project: "p_test", job_id: "film_job_0001" },
  });
  return { submitted, poll: async () => post(c.worker, env, "/poll", { poll: submitted.poll }), seen };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe.each(CASES)("$name: a plane refusal on the poll path", (c) => {
  const proxied = { ...PROXIED_ENV, ...c.extraEnv };
  const direct = { ...DIRECT_ENV, ...c.extraEnv };

  it("PRECONDITION: the proxied submit yields a real poll token", async () => {
    // Not decoration. If the submit refuses, every assertion below is about a module that never
    // polled, and the REFUSED case would go green for the wrong reason on an implementation that
    // returns ok:false unconditionally.
    const { submitted, seen } = await submitThenPoll(c, proxied, refusedResponse);
    expect(submitted.error ?? "", c.name + " refused the submit").toBe("");
    expect(submitted.ok).toBe(true);
    expect(submitted.pending).toBe(true);
    expect(typeof submitted.poll).toBe("string");
    expect(seen.some((u) => u.endsWith("/run")), c.name + " never called /run; saw " + JSON.stringify(seen)).toBe(true);
  });

  it("REFUSED: header present on the proxied route -> terminal error naming the plane, NOT pending", async () => {
    const { poll, seen } = await submitThenPoll(c, proxied, refusedResponse);
    const body = await poll();

    // CONTROL first, per N81: a poll that never happened produces the same body as a poll that was
    // handled wrongly, and running the claim first is how an invalid control becomes a line in
    // output you have already written.
    expect(seen.some((u) => u.includes("/status/")), c.name + " never polled; saw " + JSON.stringify(seen)).toBe(true);

    // THE CLAIM. This is the assertion that goes red at origin/main.
    expect(body.pending, c.name + " reported a plane refusal as still running").not.toBe(true);
    expect(body.ok).toBe(false);
    // Echoed VERBATIM: proves the reason came off the header rather than out of a canned string.
    expect(String(body.error)).toContain(PROBE_REASON);
    // Names the plane. The single most expensive misreading here is "RunPod is down".
    expect(String(body.error).toLowerCase()).toContain("plane");
    expect(String(body.error)).toContain(c.name);
  });

  it("BLIND: the SAME 503 and body with NO header stays pending (a RunPod blip is not our outage)", async () => {
    const { poll, seen } = await submitThenPoll(c, proxied, blindResponse);
    const body = await poll();
    expect(seen.some((u) => u.includes("/status/")), c.name + " never polled").toBe(true);
    // One axis only: identical response, header removed. If this ever fails, every poll failure has
    // become a refusal, which turns a vendor hiccup into a reported plane outage.
    expect(body.ok, c.name + " turned a headerless upstream failure into an error").toBe(true);
    expect(body.pending).toBe(true);
    expect(body.error).toBeUndefined();
  });

  it("DIRECT: the SAME refusal response on the UNBOUND route stays pending (the self-host door)", async () => {
    const { poll, seen } = await submitThenPoll(c, direct, refusedResponse);
    const body = await poll();
    expect(seen.some((u) => u.includes("/status/")), c.name + " never polled").toBe(true);
    expect(seen.some((u) => u.includes("api.runpod.ai")), c.name + " did not take the direct route").toBe(true);
    // There is no plane on this route, so the header is a vendor header and must change nothing. A
    // self-hoster's render outcome cannot depend on a string api.runpod.ai chose to send.
    expect(body.ok, c.name + " let a vendor header fail a self-host render").toBe(true);
    expect(body.pending).toBe(true);
  });
});

describe("the population is derived, not asserted (cf#398 denominator)", () => {
  it("every RunPod-reaching module checks the refusal header at its poll site", async () => {
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

    // Same predicate the cf#289 and cf#394 censuses use, so the three cannot drift into three
    // different populations: a module reaches RunPod iff it names the RunPod API host or imports the
    // shared route helper.
    const runpod = candidates.filter((n) => read(n).includes("api.runpod.ai") || read(n).includes("_shared/runpod-route"));
    const guarded = runpod.filter((n) => read(n).includes("planeRefusalReason("));

    // DENOMINATOR beside the result: a matcher returning almost everything has failed as completely
    // as one returning nothing, and only the denominator shows either.
    console.log(JSON.stringify({ modulesScanned: candidates.length, runpodReaching: runpod.length, guarded: guarded.length }));

    // POSITIVE CONTROL: the scan reads real files. Without it a path regression empties every set and
    // "nothing unguarded" passes vacuously.
    expect(candidates.length).toBeGreaterThanOrEqual(26);
    expect(runpod).toContain("narration-gen");
    expect(runpod).toContain("seedance");
    // NEGATIVE CONTROL: the predicate must REJECT the near-misses, or "all guarded" is satisfiable by
    // a matcher that selects nothing. local-gpu is the sharp one: it is a motion backend that polls
    // `<LOCAL_BACKEND_URL>/status/<id>`, so it looks identical to a RunPod poller and is not one.
    expect(runpod).not.toContain("local-gpu");
    expect(runpod).not.toContain("subtitle");
    expect(runpod).not.toContain("film-titles");
    expect(runpod).not.toContain("cast-image");

    // FLOOR, not equality: a new non-RunPod module is normal and must not turn this red, while a
    // matcher that has stopped matching must.
    expect(runpod.length).toBeGreaterThanOrEqual(14);
    // Every module driven above is in the derived set, so the behavioural half cannot silently cover
    // a smaller population than the census claims.
    expect(runpod.filter((n) => !CASES.some((c) => c.name === n)), "reach RunPod but are not driven above").toEqual([]);
    expect(runpod.filter((n) => !guarded.includes(n)), "reach RunPod with no plane-refusal check").toEqual([]);
  });
});
