/// <reference types="node" />
// The "job not found" failure must name the transport that ACTUALLY ran the job.
//
// THE DEFECT. Both door-capable finish modules fail a gone job with:
//
//   "<module> job not found on RunPod (GC'd or never ran); failing shot <id> (#141)"
//
// That string is asserted unconditionally, and since cf#480 these modules can run on our own iron
// over a VPC binding. So a container restart in Falkenstein produces an error telling an operator to
// go look at a RunPod dashboard -- for a job RunPod never saw. Cheap misdirection at exactly the
// moment someone is debugging, and it costs more than a wrong message usually does because the
// suggested place to look is a different company's console.
//
// SCOPE, MEASURED. 14 modules carry this string; only 2 can run on a non-RunPod transport
// (`tokenTookDoor` present AND the string present): finish-upscale and finish-blender. For the other
// 12 the string is ACCURATE and is deliberately left alone -- own-gpu included, whose name means "your
// own RunPod endpoint" and which genuinely calls runpodEndpointUrl. speech-upscale has a door but no
// such string: its token carries audio_key so it soft-degrades instead of failing.
//
// BEHAVIOUR IS UNCHANGED. Still ok:false, still records outcome "gone". This is a message fix.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import finishUpscale from "../modules/finish-upscale/src/index";
import finishBlender from "../modules/finish-blender/src/index";
import { DOOR_ROUTE_NAME, doorName } from "../modules/_shared/finish-door";

const DOOR_TOKEN = "lft_gone_probe_7c31";
const RUNPOD_KEY = "rpa_gone_probe_9d02";
const ENDPOINT = "goneendpoint01";
const JOB = "b7c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5";
/** Well past RUNPOD_NOTFOUND_GRACE_MS and the cold cap, so the branch under test is reached. */
const LONG_AGO = () => Date.now() - 60 * 60 * 1000;

const notFound = () => new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
/** A door whose /health answers, so the cold-start tolerance does not swallow the case. */
function doorStub() {
  const calls: string[] = [];
  return {
    calls,
    binding: {
      fetch: vi.fn(async (u: RequestInfo) => {
        const p = new URL(String(u)).pathname;
        calls.push(p);
        if (p === "/health") return new Response(JSON.stringify({ ok: true, workers: { ready: 1 } }), { status: 200, headers: { "content-type": "application/json" } });
        return notFound();
      }) as unknown as typeof fetch,
    },
  };
}

type Worker = { fetch(r: Request, e: never): Promise<Response> };
const post = (w: Worker, p: string, env: unknown, b: unknown) =>
  w.fetch(new Request("https://m.internal" + p, { method: "POST", body: JSON.stringify(b) }), env as never);
const body = async (r: Response) => (await r.json()) as Record<string, never>;
const token = (o: unknown) => btoa(JSON.stringify(o));

let realFetch: typeof fetch;
beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

describe("a gone job names the transport that actually ran it", () => {
  it("finish-upscale: a DOOR job does not send the operator to RunPod", async () => {
    const rp = vi.fn(async () => notFound());
    globalThis.fetch = rp as unknown as typeof fetch;
    const door = doorStub();

    const res = await body(await post(finishUpscale as unknown as Worker, "/poll", {
      RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT,
      FINISH_UPSCALE_VPC: door.binding, FINISH_DOOR_TOKEN: DOOR_TOKEN,
    }, { poll: token({ jobId: JOB, shotId: "shot_01", srcFps: 24, frames: 96, submittedAt: LONG_AGO(), door: DOOR_ROUTE_NAME }) }));

    expect(res.ok).toBe(false);                       // behaviour unchanged
    const err = String(res.error);
    // THE assertion. Naming RunPod for a job that ran on our iron is the defect.
    expect(err).not.toContain("RunPod");
    expect(err).toContain("door");
    expect(err).toContain("shot_01");
    expect(rp.mock.calls.every((c) => !String(c[0]).includes("runpod"))).toBe(true);
  });

  it("finish-upscale: the message names WHICH door, so a two-door deploy is diagnosable", async () => {
    // With a pool, "a door" is not enough -- an operator needs to know which box to look at.
    const door = doorStub();
    globalThis.fetch = vi.fn(async () => notFound()) as unknown as typeof fetch;
    const PROP = doorName("propagandhi");

    const res = await body(await post(finishUpscale as unknown as Worker, "/poll", {
      RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT,
      FINISH_UPSCALE_VPC_PROPAGANDHI: door.binding, FINISH_DOOR_TOKEN_PROPAGANDHI: DOOR_TOKEN,
    }, { poll: token({ jobId: JOB, shotId: "shot_02", srcFps: 24, frames: 96, submittedAt: LONG_AGO(), door: PROP }) }));

    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain(PROP);
  });

  it("CONTROL, finish-upscale: a RUNPOD job still says RunPod", async () => {
    // Without this the fix could have deleted the word everywhere and still passed the case above.
    globalThis.fetch = vi.fn(async () => notFound()) as unknown as typeof fetch;

    const res = await body(await post(finishUpscale as unknown as Worker, "/poll", {
      RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT,
    }, { poll: token({ jobId: JOB, shotId: "shot_03", srcFps: 24, frames: 96, submittedAt: LONG_AGO() }) }));

    expect(res.ok).toBe(false);
    expect(String(res.error)).toContain("RunPod");
  });

  it("finish-blender: same defect, same fix", async () => {
    const door = doorStub();
    globalThis.fetch = vi.fn(async () => notFound()) as unknown as typeof fetch;

    const res = await body(await post(finishBlender as unknown as Worker, "/poll", {
      RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT,
      FINISH_BLENDER_VPC: door.binding, BLENDER_DOOR_TOKEN: DOOR_TOKEN,
    }, { poll: token({ jobId: JOB, shotId: "shot_04", srcFps: 24, frames: 96, submittedAt: LONG_AGO(), door: DOOR_ROUTE_NAME }) }));

    expect(res.ok).toBe(false);
    expect(String(res.error)).not.toContain("RunPod");
    expect(String(res.error)).toContain("door");
  });

  it("CONTROL, finish-blender: a RunPod job still says RunPod", async () => {
    globalThis.fetch = vi.fn(async () => notFound()) as unknown as typeof fetch;
    const res = await body(await post(finishBlender as unknown as Worker, "/poll", {
      RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT,
    }, { poll: token({ jobId: JOB, shotId: "shot_05", srcFps: 24, frames: 96, submittedAt: LONG_AGO() }) }));
    expect(String(res.error)).toContain("RunPod");
  });
});
