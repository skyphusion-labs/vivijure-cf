// EVERY motion.backend MODULE HANDS THE CALLER THE PROVIDER JOB ID (cf#296, cf#289).
//
// THE DEFECT. `render-orchestrator` does `shot.runpod_job_id = r.jobId` on the pending branch, added
// by #536 to retain the backend job id for cancel and accounting. No motion.backend module populated
// it, so the field read as present-and-populated in the source and was `undefined` in every clip job
// ever submitted. RunPod cannot enumerate jobs -- the whole surface is /run, /status, /stream,
// /cancel, /retry, /purge-queue, /health, and /status is by id only -- so an id the caller is not
// handed at submit is unreachable PERMANENTLY. A cost-door clip was therefore unattributable to a
// provider job from the moment of submit, with no way for the caller to compensate.
//
// WHY THIS TEST IS BEHAVIOURAL AND NOT A GREP. cf#289 enumerated this class with a line-anchored
// grep, got the wrong set because two modules inline the field at the end of the return line, and
// said so in the issue: "anyone acting on this table should re-derive it behaviourally rather than
// trusting a grep, mine included." So this drives each shipped worker's real POST /invoke through
// its real submit path with RunPod stubbed at the fetch boundary, and reads the field off the actual
// response body. The stub is the vendor HTTP call; the routing, the guards and the envelope
// construction are all shipped code.
//
// MEASURED CORRECTION TO cf#296. The issue treats these as third-party providers and raises the
// question of whether `runpod_job_id` would be an honest column name for them. It is: every module
// below submits to https://api.runpod.ai/v2/<public-endpoint-slug>, so the id IS a RunPod job id.
// The one module where it would NOT be is local-gpu (its door is not RunPod at all), and local-gpu
// already returned the field before this change, contrary to the issue's table.
import { describe, it, expect, vi, afterEach } from "vitest";

import seedanceWorker from "../modules/seedance/src/index";
import klingWorker from "../modules/kling/src/index";
import viduWorker from "../modules/vidu-q3/src/index";
import veoWorker from "../modules/google-veo/src/index";
import hailuoWorker from "../modules/minimax-hailuo/src/index";
import wanWorker from "../modules/alibaba-wan/src/index";
import wanLoraWorker from "../modules/alibaba-wan-lora/src/index";
import ownGpuWorker from "../modules/own-gpu/src/index";
import localGpuWorker from "../modules/local-gpu/src/index";

type Worker = { fetch(request: Request, env: never): Promise<Response> };

const STUB_JOB_ID = "b7c1f0e2-0000-4aaa-9bbb-5cd0e1f23456";
// local-gpu's door mints uuid4.HEX and its guard is /^[A-Za-z0-9]{1,64}$/, so a RunPod-shaped
// dashed id is correctly REFUSED there. Each module gets the id shape its own provider emits.
const STUB_JOB_ID_ALNUM = "b7c1f0e200004aaa9bbb5cd0e1f23456";

/** Every module below is a motion.backend. keyframe_url is ignored by the two that do not need it. */
const INPUT = { shot_id: "shot_01", prompt: "a slow push in", keyframe_url: "https://example.invalid/kf.png", seconds: 5 };

const MODULES: { name: string; worker: Worker; env: Record<string, unknown>; jobId?: string }[] = [
  { name: "seedance", worker: seedanceWorker as unknown as Worker, env: { RUNPOD_API_KEY: "rpa_stub" } },
  { name: "kling", worker: klingWorker as unknown as Worker, env: { RUNPOD_API_KEY: "rpa_stub" } },
  { name: "vidu-q3", worker: viduWorker as unknown as Worker, env: { RUNPOD_API_KEY: "rpa_stub" } },
  { name: "google-veo", worker: veoWorker as unknown as Worker, env: { RUNPOD_API_KEY: "rpa_stub" } },
  { name: "minimax-hailuo", worker: hailuoWorker as unknown as Worker, env: { RUNPOD_API_KEY: "rpa_stub" } },
  { name: "alibaba-wan", worker: wanWorker as unknown as Worker, env: { RUNPOD_API_KEY: "rpa_stub" } },
  { name: "alibaba-wan-lora", worker: wanLoraWorker as unknown as Worker, env: { RUNPOD_API_KEY: "rpa_stub" } },
  // own-gpu drives OUR backend endpoint; it needs the endpoint id too. RUNPOD_WORKERS_MAX is left
  // unset on purpose so the submit does not detour through the endpoint reconcile.
  { name: "own-gpu", worker: ownGpuWorker as unknown as Worker, env: { RUNPOD_API_KEY: "rpa_stub", RUNPOD_ENDPOINT_ID: "nbfj3iatp62ek9" } },
  // local-gpu is included because cf#296's table listed it as MISSING the field and it was not.
  // Pinning it here means the correction cannot quietly regress into agreeing with the issue.
  { name: "local-gpu", worker: localGpuWorker as unknown as Worker, env: { LOCAL_BACKEND_URL: "https://door.invalid" }, jobId: STUB_JOB_ID_ALNUM },
];

/** Answers the vendor /run with a job id and everything else with something harmless. Records the
 *  URLs it was asked for, so a test can prove the module really reached the submit call. */
function stubRunpod(runBody: unknown = { id: STUB_JOB_ID }, runStatus = 200) {
  const seen: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const u = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    seen.push(u);
    if (u.endsWith("/run")) return new Response(JSON.stringify(runBody), { status: runStatus, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({}), { status: 200, headers: { "content-type": "application/json" } });
  });
  return seen;
}

const invoke = async (worker: Worker, env: Record<string, unknown>, input: unknown = INPUT) => {
  const res = await worker.fetch(
    new Request("https://m.internal/invoke", {
      method: "POST",
      body: JSON.stringify({ hook: "motion.backend", input, config: {}, context: { project: "p_test" } }),
    }),
    env as never,
  );
  return (await res.json()) as Record<string, unknown>;
};

afterEach(() => { vi.unstubAllGlobals(); });

describe.each(MODULES)("$name: POST /invoke submit envelope", ({ name, worker, env, jobId }) => {
  const id = jobId ?? STUB_JOB_ID;
  it("returns the provider job id the vendor handed it, at the top level", async () => {
    const seen = stubRunpod({ id });
    const body = await invoke(worker, env);
    // CONTROL: the module actually reached the vendor submit. Without this, a module that
    // short-circuited on a guard would fail the assertion below for the wrong reason and a module
    // that returned a hardcoded id would pass it for the wrong reason.
    expect(seen.some((u) => u.endsWith("/run")), name + " never called /run; saw " + JSON.stringify(seen)).toBe(true);
    expect(body.ok).toBe(true);
    expect(body.pending).toBe(true);
    expect(typeof body.poll).toBe("string");
    expect(body.jobId).toBe(id);
  });

  it("carries the id the STUB chose, not a value baked into the module", async () => {
    // Same assertion with a different id. A module that hardcoded STUB_JOB_ID, or that echoed the
    // shot id, passes the test above and fails this one.
    const other = jobId ? "9f9f9f9f11114ccc8ddd0a2c3e4f5a6b" : "9f9f9f9f-1111-4ccc-8ddd-0a2c3e4f5a6b";
    stubRunpod({ id: other });
    const body = await invoke(worker, env);
    expect(body.jobId).toBe(other);
  });

  it("DISCRIMINATES: a refused submit carries no jobId at all", async () => {
    // Without this, `jobId` could be set unconditionally (to undefined, to a placeholder) and every
    // assertion above would still pass. A caller must be able to tell "here is the id" from "there
    // is no job".
    stubRunpod();
    const body = await invoke(worker, env, { shot_id: "", prompt: "", keyframe_url: "" });
    expect(body.ok).toBe(false);
    expect(body.jobId).toBeUndefined();
  });

  it("DISCRIMINATES: a vendor /run that returns no id is a refusal, not an envelope with a blank id", async () => {
    stubRunpod({});
    const body = await invoke(worker, env);
    expect(body.ok).toBe(false);
    expect(body.jobId).toBeUndefined();
  });
});

describe("the population under test is the whole one (cf#296)", () => {
  it("covers every motion.backend module in the tree, so a new one cannot join silently", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = join(import.meta.dirname, "..", "modules");
    const motion = readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== "_shared")
      .filter((e) => {
        // Match the hook INSIDE the array, not the exact single-hook line: keying on
        // `hooks: ["motion.backend"]` matched eight modules and silently dropped local-gpu, which
        // is dual-hook. A name filter that agrees with your expectation is the one nobody rechecks.
        try {
          const src = readFileSync(join(dir, e.name, "src", "index.ts"), "utf8");
          return /hooks:\s*\[[^\]]*"motion\.backend"/.test(src);
        } catch { return false; }
      })
      .map((e) => e.name);
    // CONTROL: the scan found real modules. A path or parse regression would otherwise turn this
    // assertion into a pass generator that agrees with any coverage list at all.
    expect(motion.length).toBeGreaterThanOrEqual(9);
    expect(motion).toContain("seedance");
    expect(motion).toContain("own-gpu");
    // The module the exact-string matcher missed. Pinned by name so the widened pattern cannot
    // narrow back without this failing.
    expect(motion).toContain("local-gpu");
    // CONTROL: the pattern must NOT sweep in modules that are not motion backends, or the
    // "nothing uncovered" assertion below becomes trivially satisfiable by covering everything.
    expect(motion).not.toContain("keyframe");
    expect(motion).not.toContain("finish-upscale");
    expect(motion).not.toContain("narration-gen");
    const covered = MODULES.map((m) => m.name);
    expect(motion.filter((m) => !covered.includes(m)), "motion.backend modules not exercised above").toEqual([]);
  });
});
