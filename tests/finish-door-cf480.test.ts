/// <reference types="node" />
// cf#480: hosted finish work on our OWN always-on GPU iron instead of a rented RunPod worker.
//
// THE EVIDENCE STANDARD THIS FILE IS BUILT TO, and it is the repo's own (see
// tests/runpod-proxy-base-cf394.test.ts, whose recorder mechanics are reused rather than
// reinvented):
//
//   1. THE LOAD-BEARING ASSERTION IS A ZERO, SO IT NEEDS A CONTROL. "the door served it" and "it
//      failed over to RunPod" must not be the same observation, so every door case asserts the
//      global `fetch` recorded ZERO calls -- and a sibling case proves that same recorder DOES
//      capture calls on the RunPod arm, or the zero would be a broken spy rather than a finding.
//   2. THE UNTOUCHED PATH IS ASSERTED BYTE FOR BYTE. This change re-expressed both modules' RunPod
//      calls through a Transport indirection. That is exactly the shape that silently drops a
//      header, so the unbound arm is pinned on URL, method, authorization AND content-type.
//   3. AFFINITY IS TESTED AS A CROSS-ROUTE REFUSAL, not as a preference. Polling the wrong service
//      does not error -- it 404s, which `runpodJobGone` correctly reads as a GC'd job, and past the
//      grace window that FAILS THE SHOT. So the failure mode of losing affinity is destroyed work
//      that looks like a legitimate backend verdict, and the test drives the real poll path.
//   4. NON-DEFAULT PROBE VALUES throughout: a door token that appears nowhere in the tree, so
//      "the door bearer went on the wire" is distinguishable from "some bearer went on the wire".
//
// MUTATION-PROVEN. Every assertion here was watched go RED against a deliberately reintroduced
// defect before this file was committed; the mutations and their named victims are listed in
// docs/cf480-door-mutations.md.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import finishUpscale from "../modules/finish-upscale/src/index";
import speechUpscale from "../modules/speech-upscale/src/index";
import { DOOR_ROUTE_NAME, doorRoute, doorBound, doorProblem, tokenTookDoor } from "../modules/_shared/finish-door";

/** Values that appear nowhere else in this repo, so a match cannot be a coincidence. */
const DOOR_TOKEN = "lft_cf480_door_probe_9f2c";
const RUNPOD_KEY = "rpa_cf480_runpod_probe";
const ENDPOINT = "cf480endpoint01";
const DOOR_JOB = "a1b2c3d4e5f60718293a4b5c6d7e8f90";
const RUNPOD_JOB = "runpod-job-cf480";

interface Recorded { url: string; method: string; headers: Record<string, string>; body?: string }

function recorder(respond: (url: string, method: string) => Response) {
  const calls: Recorded[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {};
    const h = (init?.headers ?? {}) as Record<string, string>;
    for (const k of Object.keys(h)) headers[k.toLowerCase()] = h[k];
    const method = init?.method ?? "GET";
    calls.push({ url: String(input), method, headers, body: init?.body as string | undefined });
    return respond(String(input), method);
  });
  return { fn, calls };
}

/** A stub VPC service binding. Structurally what wrangler hands a Worker: a Fetcher, nothing more. */
function doorStub(respond: (path: string, method: string) => Response) {
  const { fn, calls } = recorder((url, method) => respond(new URL(url).pathname, method));
  return { binding: { fetch: fn as unknown as typeof fetch }, calls };
}

const runOk = (id: string) => new Response(JSON.stringify({ id }), { status: 200, headers: { "content-type": "application/json" } });
const completed = (output: unknown) => new Response(JSON.stringify({ status: "COMPLETED", output }), { status: 200, headers: { "content-type": "application/json" } });
const notFound = () => new Response(JSON.stringify({ status: 404, title: "Not Found", detail: "job not found" }), { status: 404, headers: { "content-type": "application/json" } });

const FINISH_INPUT = { shot_id: "shot_01", clip_key: "p/shot_01.mp4", src_fps: 24, frames: 96 };
const SPEECH_INPUT = { shot_id: "shot_01", audio_key: "p/shot_01.wav" };

type Worker = { fetch(r: Request, e: never): Promise<Response> };
const FINISH = finishUpscale as unknown as Worker;
const SPEECH = speechUpscale as unknown as Worker;

function post(worker: Worker, path: string, env: unknown, body: unknown) {
  return worker.fetch(new Request("https://module.internal" + path, { method: "POST", body: JSON.stringify(body) }), env as never);
}
const invokeFinish = (env: unknown) => post(FINISH, "/invoke", env, { hook: "finish", input: FINISH_INPUT, config: {}, context: { project: "cf480" } });
const invokeSpeech = (env: unknown) => post(SPEECH, "/invoke", env, { hook: "speech", input: SPEECH_INPUT, config: { enable: true }, context: { project: "cf480" } });
const pollWith = (worker: Worker, env: unknown, token: string) => post(worker, "/poll", env, { poll: token });
const body = async (r: Response) => (await r.json()) as Record<string, never>;

/** Mint a poll token the way the shipped code does, so affinity is tested against the real encoding
 *  rather than against a hand-written string this file invented. */
const token = (o: unknown) => btoa(JSON.stringify(o));

let realFetch: typeof fetch;
beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

// ------------------------------------------------------------------------------------------- 1.
describe("finish-door: the branch is BOUND-ness, never failover", () => {
  it("unbound -> no door, and that is not a fault", () => {
    const r = doorRoute(null, "");
    expect(doorBound(r)).toBe(false);
    expect(doorProblem(r)).toBeNull();      // unbound is the RunPod path, not a misconfiguration
    expect(r.name).toBe("");
  });

  it("bound with a token -> usable, and labelled", () => {
    const r = doorRoute({ fetch: async () => new Response("") }, DOOR_TOKEN);
    expect(doorBound(r)).toBe(true);
    expect(doorProblem(r)).toBeNull();
    expect(r.name).toBe(DOOR_ROUTE_NAME);
  });

  it("bound WITHOUT a token is propagation, not 'no door' -- and it stays BOUND", () => {
    const r = doorRoute({ fetch: async () => new Response("") }, "");
    // The load-bearing pair. If a tokenless door ever fell back to unbound, a bound module would
    // silently start renting RunPod again -- the exact regression this design exists to prevent.
    expect(doorBound(r)).toBe(true);
    expect(doorProblem(r)).toBe("door-token-not-yet-visible");
  });

  it("only the door's own route label counts as a door token", () => {
    expect(tokenTookDoor(DOOR_ROUTE_NAME)).toBe(true);
    expect(tokenTookDoor(undefined)).toBe(false);   // every pre-cf480 token
    expect(tokenTookDoor("")).toBe(false);
    expect(tokenTookDoor("runpod")).toBe(false);
  });
});

// ------------------------------------------------------------------------------------------- 2.
describe("bound door: RunPod is not called AT ALL", () => {
  it("finish-upscale submits to the door and reaches RunPod ZERO times", async () => {
    const rp = recorder(() => runOk(RUNPOD_JOB));
    globalThis.fetch = rp.fn as unknown as typeof fetch;
    const door = doorStub(() => runOk(DOOR_JOB));

    const res = await body(await invokeFinish({
      RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT,
      FINISH_UPSCALE_VPC: door.binding, FINISH_DOOR_TOKEN: DOOR_TOKEN,
    }));

    expect(res.ok).toBe(true);
    expect(res.pending).toBe(true);
    expect(res.jobId).toBe(DOOR_JOB);
    // THE assertion. Not "RunPod was slower" -- RunPod was never asked.
    expect(rp.calls.length).toBe(0);
    expect(door.calls.length).toBe(1);
    expect(new URL(door.calls[0].url).pathname).toBe("/run");
    expect(door.calls[0].method).toBe("POST");
    expect(door.calls[0].headers.authorization).toBe("Bearer " + DOOR_TOKEN);
    // The RunPod credential must never be presented to our own door.
    expect(door.calls[0].headers.authorization).not.toContain(RUNPOD_KEY);
  });

  it("speech-upscale does the same", async () => {
    const rp = recorder(() => runOk(RUNPOD_JOB));
    globalThis.fetch = rp.fn as unknown as typeof fetch;
    const door = doorStub(() => runOk(DOOR_JOB));

    const res = await body(await invokeSpeech({
      RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT,
      SPEECH_UPSCALE_VPC: door.binding, SPEECH_DOOR_TOKEN: DOOR_TOKEN,
    }));

    expect(res.ok).toBe(true);
    expect(res.jobId).toBe(DOOR_JOB);
    expect(rp.calls.length).toBe(0);
    expect(door.calls[0].headers.authorization).toBe("Bearer " + DOOR_TOKEN);
  });

  it("CONTROL: the same recorder DOES capture the RunPod arm, so the zeros above are real", async () => {
    const rp = recorder(() => runOk(RUNPOD_JOB));
    globalThis.fetch = rp.fn as unknown as typeof fetch;

    const res = await body(await invokeFinish({ RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT }));

    expect(res.jobId).toBe(RUNPOD_JOB);
    expect(rp.calls.length).toBe(1);   // without this the zeros above could be a dead spy
  });

  it("a door FAILURE degrades honestly and STILL does not touch RunPod", async () => {
    const rp = recorder(() => runOk(RUNPOD_JOB));
    globalThis.fetch = rp.fn as unknown as typeof fetch;
    const door = doorStub(() => new Response("boom", { status: 500 }));

    const res = await body(await invokeFinish({
      RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT,
      FINISH_UPSCALE_VPC: door.binding, FINISH_DOOR_TOKEN: DOOR_TOKEN,
    }));

    // Polish step: soft degrade, never a chain failure (#249/#77).
    expect(res.ok).toBe(true);
    const out = res.output as unknown as { degraded?: string; applied?: unknown[]; clip_key?: string };
    // Names the DOOR, not "runpod-run-failed", and carries the detail: an operator reading this
    // must not be sent to the RunPod dashboard for a job RunPod never saw.
    expect(out.degraded).toBe("door-run-failed: HTTP 500");
    // `applied` records the degrade rather than being empty -- that is passthroughOutput's shipped
    // contract (`passthrough:<reason>`), and it is the honest half of #77: the no-op is RECORDED.
    // What must never appear is a tag claiming the work happened, so that is what is asserted.
    expect(out.applied).toEqual(["passthrough:door-run-failed"]);
    expect(JSON.stringify(out.applied)).not.toContain("upscale");
    expect(out.clip_key).toBe(FINISH_INPUT.clip_key); // passthrough
    // A failover here would re-rent the GPU this change exists to stop renting.
    expect(rp.calls.length).toBe(0);
  });

  it("bound but tokenless degrades as PROPAGATION, never as 'no runpod secrets'", async () => {
    const rp = recorder(() => runOk(RUNPOD_JOB));
    globalThis.fetch = rp.fn as unknown as typeof fetch;
    const door = doorStub(() => runOk(DOOR_JOB));

    const res = await body(await invokeFinish({
      RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT,
      FINISH_UPSCALE_VPC: door.binding,       // bound, but no FINISH_DOOR_TOKEN
    }));

    const out = res.output as unknown as { degraded?: string };
    expect(out.degraded).toBe("door-token-not-yet-visible");
    expect(rp.calls.length).toBe(0);
    expect(door.calls.length).toBe(0);        // refused before the wire, not after a 401
  });
});

// ------------------------------------------------------------------------------------------- 3.
describe("the UNBOUND arm is byte-identical to what shipped before cf#480", () => {
  it("finish-upscale still builds RunPod's own URL, method and headers", async () => {
    const rp = recorder(() => runOk(RUNPOD_JOB));
    globalThis.fetch = rp.fn as unknown as typeof fetch;

    await invokeFinish({ RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT });

    expect(rp.calls.length).toBe(1);
    expect(rp.calls[0].url).toBe("https://api.runpod.ai/v2/" + ENDPOINT + "/run");
    expect(rp.calls[0].method).toBe("POST");
    expect(rp.calls[0].headers.authorization).toBe("Bearer " + RUNPOD_KEY);
    // The Transport indirection merges two header objects. That is exactly how a content-type gets
    // dropped, and a dropped content-type on /run is the kind of thing a status check never sees.
    expect(rp.calls[0].headers["content-type"]).toBe("application/json");
  });

  it("speech-upscale likewise", async () => {
    const rp = recorder(() => runOk(RUNPOD_JOB));
    globalThis.fetch = rp.fn as unknown as typeof fetch;

    await invokeSpeech({ RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT });

    expect(rp.calls[0].url).toBe("https://api.runpod.ai/v2/" + ENDPOINT + "/run");
    expect(rp.calls[0].headers.authorization).toBe("Bearer " + RUNPOD_KEY);
    expect(rp.calls[0].headers["content-type"]).toBe("application/json");
  });

  it("mints a poll token with NO route label, exactly like every pre-cf480 token", async () => {
    const rp = recorder(() => runOk(RUNPOD_JOB));
    globalThis.fetch = rp.fn as unknown as typeof fetch;
    const res = await body(await invokeFinish({ RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT }));
    const decoded = JSON.parse(atob(res.poll as unknown as string)) as { door?: string };
    expect(decoded.door).toBeUndefined();
  });
});

// ------------------------------------------------------------------------------------------- 4.
describe("AFFINITY: a poll is served by the route that minted the job, never the other one", () => {
  it("a door-minted token polls the DOOR even though RunPod credentials are present", async () => {
    const rp = recorder(() => completed({ clip_key: "p/shot_01_up.mp4" }));
    globalThis.fetch = rp.fn as unknown as typeof fetch;
    const door = doorStub(() => completed({ shot_id: "shot_01", clip_key: "p/shot_01_up.mp4", out_fps: 24, frames: 96 }));

    const res = await body(await pollWith(FINISH, {
      RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT,
      FINISH_UPSCALE_VPC: door.binding, FINISH_DOOR_TOKEN: DOOR_TOKEN,
    }, token({ jobId: DOOR_JOB, shotId: "shot_01", srcFps: 24, frames: 96, submittedAt: Date.now(), door: DOOR_ROUTE_NAME })));

    expect(res.ok).toBe(true);
    expect(rp.calls.length).toBe(0);
    expect(new URL(door.calls[0].url).pathname).toBe("/status/" + DOOR_JOB);
  });

  it("a RunPod-minted token polls RUNPOD even though a door is bound", async () => {
    const rp = recorder(() => completed({ shot_id: "shot_01", clip_key: "p/shot_01_up.mp4", out_fps: 24, frames: 96 }));
    globalThis.fetch = rp.fn as unknown as typeof fetch;
    const door = doorStub(() => notFound());

    const res = await body(await pollWith(FINISH, {
      RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT,
      FINISH_UPSCALE_VPC: door.binding, FINISH_DOOR_TOKEN: DOOR_TOKEN,
    }, token({ jobId: RUNPOD_JOB, shotId: "shot_01", srcFps: 24, frames: 96, submittedAt: Date.now() })));

    expect(res.ok).toBe(true);
    // The direction that destroys work: the door 404s an unknown id, runpodJobGone reads that as a
    // GC'd job, and past the grace window the shot FAILS. So this zero is the whole point.
    expect(door.calls.length).toBe(0);
    expect(rp.calls[0].url).toBe("https://api.runpod.ai/v2/" + ENDPOINT + "/status/" + RUNPOD_JOB);
  });

  it("submit -> poll round trip keeps the label, so affinity holds without anyone re-deriving it", async () => {
    const rp = recorder(() => runOk(RUNPOD_JOB));
    globalThis.fetch = rp.fn as unknown as typeof fetch;
    const door = doorStub((path) => (path === "/run" ? runOk(DOOR_JOB) : completed({ shot_id: "shot_01", clip_key: "p/shot_01_up.mp4" })));
    const env = { RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT, FINISH_UPSCALE_VPC: door.binding, FINISH_DOOR_TOKEN: DOOR_TOKEN };

    const submitted = await body(await invokeFinish(env));
    const decoded = JSON.parse(atob(submitted.poll as unknown as string)) as { door?: string };
    expect(decoded.door).toBe(DOOR_ROUTE_NAME);

    const polled = await body(await pollWith(FINISH, env, submitted.poll as unknown as string));
    expect(polled.ok).toBe(true);
    expect(rp.calls.length).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------- 5.
describe("the binding removed while a job is in flight", () => {
  it("finish-upscale refuses HONESTLY rather than polling the wrong service", async () => {
    const rp = recorder(() => notFound());
    globalThis.fetch = rp.fn as unknown as typeof fetch;

    const res = await body(await pollWith(FINISH, { RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT },
      token({ jobId: DOOR_JOB, shotId: "shot_01", srcFps: 24, frames: 96, submittedAt: Date.now(), door: DOOR_ROUTE_NAME })));

    expect(res.ok).toBe(false);
    // cf#507 reworded this to name WHICH door is unbound, since there is now more than one. The
    // assertion tracks the substance (an honest refusal naming the door), not the old phrasing.
    expect(String(res.error)).toContain("door vpc is not bound");
    // Falling through to RunPod would 404 and, past the grace window, fail the shot with
    // "GC'd or never ran" -- a true-sounding verdict about a job RunPod never had.
    expect(rp.calls.length).toBe(0);
  });

  it("speech-upscale soft-degrades instead, because ITS token carries the input audio_key", async () => {
    const rp = recorder(() => notFound());
    globalThis.fetch = rp.fn as unknown as typeof fetch;

    const res = await body(await pollWith(SPEECH, { RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT },
      token({ jobId: DOOR_JOB, shotId: "shot_01", audioKey: SPEECH_INPUT.audio_key, submittedAt: Date.now(), door: DOOR_ROUTE_NAME })));

    expect(res.ok).toBe(true);
    const out = res.output as unknown as { degraded?: string; audio_key?: string; applied?: unknown[] };
    expect(out.degraded).toBe("door-unbound-mid-job");
    expect(out.audio_key).toBe(SPEECH_INPUT.audio_key);
    // Same rule: the degrade is recorded, and no tag claims the enhance ran.
    expect(JSON.stringify(out.applied)).not.toContain("speech-upscale:");
    expect(rp.calls.length).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------- 6.
describe("GET /ready", () => {
  const ready = async (worker: Worker, env: unknown) =>
    (await (await worker.fetch(new Request("https://m.internal/ready"), env as never)).json()) as Record<string, unknown>;

  it("UNBOUND: no `door` key at all, so the module-agnostic shape contract is untouched", async () => {
    const b = await ready(FINISH, { RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT });
    expect("door" in b).toBe(false);
    expect(b.ok).toBe(true);
  });

  it("BOUND: reports the door, and ok stops depending on RunPod credentials", async () => {
    const door = doorStub(() => runOk(DOOR_JOB));
    const b = await ready(FINISH, { FINISH_UPSCALE_VPC: door.binding, FINISH_DOOR_TOKEN: DOOR_TOKEN });
    // No RunPod credential at all here. Requiring one would make a correctly-configured on-iron
    // module report NOT READY -- a readiness probe reporting the opposite of the truth.
    expect(b.ok).toBe(true);
    // cf#507: `route` still reports the legacy label, so a one-door deploy reads exactly as it did
    // before the pool landed. `routes` is the new per-door detail, and with one door bound it has
    // exactly one row -- two bound doors reported as one is the failure this key exists to prevent.
    expect(b.door).toEqual({
      bound: true, token: true, route: DOOR_ROUTE_NAME,
      routes: [{ name: DOOR_ROUTE_NAME, token: true }],
    });
  });

  it("BOUND but tokenless is NOT ready, and says which half is missing", async () => {
    const door = doorStub(() => runOk(DOOR_JOB));
    const b = await ready(FINISH, { RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT, FINISH_UPSCALE_VPC: door.binding });
    expect(b.ok).toBe(false);
    expect(b.door).toEqual({
      bound: true, token: false, route: DOOR_ROUTE_NAME,
      routes: [{ name: DOOR_ROUTE_NAME, token: false }],
    });
  });

  it("never leaks the door token in any form", async () => {
    const door = doorStub(() => runOk(DOOR_JOB));
    for (const worker of [FINISH, SPEECH]) {
      const res = await worker.fetch(new Request("https://m.internal/ready"), {
        FINISH_UPSCALE_VPC: door.binding, FINISH_DOOR_TOKEN: DOOR_TOKEN,
        SPEECH_UPSCALE_VPC: door.binding, SPEECH_DOOR_TOKEN: DOOR_TOKEN,
      } as never);
      expect(await res.text()).not.toContain(DOOR_TOKEN);
    }
  });
});
