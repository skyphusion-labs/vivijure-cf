/// <reference types="node" />
// fleet-chezmoi#2084 (W4-4): the four modules that restore RunPod workersMax before a submit
// (keyframe, own-gpu, finish-blender, finish-upscale) do it through core's
// reconcileRunpodEndpointWorkersMax. RunPod REST v1 (rest.runpod.io/v1) retires 2026-11-15; core
// moved the reconcile to v2 (vivijure-core#529). This drives each module's REAL invoke path on the
// DIRECT route with RUNPOD_WORKERS_MAX set, against an endpoint the stub reports as idle-scaled to
// workers.max 0, and asserts the exact v2 calls: GET then PATCH
// https://api.runpod.io/v2/serverless/{id} with the nested workers body, before the /run.
//
// Before this file nothing in cf exercised the direct reconcile at all: the suite was all green on
// core 1.43.0 (v1) AND on the v2 core build alike, and the cf394 "never reaches rest.runpod.io"
// asserts would have stayed green however the host moved. This file is RED on core 1.43.0.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import keyframe from "../modules/keyframe/src/index";
import ownGpu from "../modules/own-gpu/src/index";
import finishBlender from "../modules/finish-blender/src/index";
import finishUpscale from "../modules/finish-upscale/src/index";

const EP = "ep2084probe";
/** A literal, never built from core's constant: a constant-derived URL follows any wrong value. */
const V2_URL = "https://api.runpod.io/v2/serverless/" + EP;
const KEY = "rpa_direct_key_2084";

interface Recorded {
  url: string;
  method: string;
  body?: string;
}

/** Answers the v2 endpoint read as idle-scaled (workers.max 0), the PATCH and any /run. */
function recorder() {
  const calls: Recorded[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ url, method, body: typeof init?.body === "string" ? init.body : undefined });
    if (url === V2_URL && method === "GET") {
      return Response.json({ id: EP, name: "probe", workers: { min: 0, max: 0 } });
    }
    if (url === V2_URL && method === "PATCH") {
      return Response.json({ id: EP, name: "probe", workers: { min: 0, max: 3 } });
    }
    return Response.json({ id: "job-2084", status: "IN_QUEUE" });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const hostOf = (u: string): string => {
  try {
    return new URL(u).hostname;
  } catch {
    return "";
  }
};

type Worker = { fetch(r: Request, e: never, c?: never): Promise<Response> };

function invoke(worker: Worker, body: unknown) {
  return worker.fetch(
    new Request("https://module.example/invoke", { method: "POST", body: JSON.stringify(body) }),
    { RUNPOD_API_KEY: KEY, RUNPOD_ENDPOINT_ID: EP, RUNPOD_WORKERS_MAX: "3" } as never,
    {} as never,
  );
}

const FINISH_INPUT = { shot_id: "shot_01", clip_key: "renders/p/clips/shot_01.mp4", src_fps: 24, frames: 48 };

const CASES: Array<{ name: string; worker: Worker; body: unknown }> = [
  {
    name: "keyframe",
    worker: keyframe as unknown as Worker,
    body: { hook: "keyframe", input: { project: "p", bundle_key: "bundles/p-1.tar.gz" }, config: {}, context: { project: "p", job_id: "j" } },
  },
  {
    name: "own-gpu",
    worker: ownGpu as unknown as Worker,
    body: {
      hook: "motion.backend",
      input: { shot_id: "shot_01", prompt: "a probe", keyframe_url: "https://example.invalid/kf.png" },
      config: {},
      context: { project: "p2084" },
    },
  },
  {
    name: "finish-blender",
    worker: finishBlender as unknown as Worker,
    body: { hook: "finish", input: FINISH_INPUT, config: {}, context: { project: "p", job_id: "j" } },
  },
  {
    name: "finish-upscale",
    worker: finishUpscale as unknown as Worker,
    body: { hook: "finish", input: FINISH_INPUT, config: {}, context: { project: "p", job_id: "j" } },
  },
];

let realFetch: typeof fetch;
beforeEach(() => {
  realFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("fleet-chezmoi#2084: module workersMax reconcile goes to RunPod REST v2", () => {
  for (const c of CASES) {
    it(`${c.name}: GET then PATCH ${V2_URL} with the nested workers body, then /run`, async () => {
      const { fn, calls } = recorder();
      globalThis.fetch = fn;
      await invoke(c.worker, c.body);

      const mgmt = calls.filter((x) => hostOf(x.url) === "api.runpod.io");
      expect(mgmt.map((x) => [x.method, x.url]), `${c.name} management calls`).toEqual([
        ["GET", V2_URL],
        ["PATCH", V2_URL],
      ]);
      expect(JSON.parse(mgmt[1].body ?? "null")).toEqual({ workers: { max: 3, min: 0 } });
      // The retired host is never reached, and the submit still goes to the serverless invoke API.
      expect(calls.some((x) => hostOf(x.url) === "rest.runpod.io")).toBe(false);
      const run = calls.findIndex((x) => x.url.endsWith("/run"));
      expect(run, `${c.name} issued no /run`).toBeGreaterThan(-1);
      expect(hostOf(calls[run].url)).toBe("api.runpod.ai");
      // Order: the restore happens BEFORE the submit, or a cold endpoint takes the job with no workers.
      expect(calls.findIndex((x) => x.method === "PATCH")).toBeLessThan(run);
    });
  }
});
