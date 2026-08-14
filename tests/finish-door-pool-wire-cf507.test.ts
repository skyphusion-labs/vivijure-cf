/// <reference types="node" />
// cf#507 at the WIRE, not at the helper. The unit suite (finish-door-pool-cf507.test.ts) proves
// the selector; this one drives the shipped module through /invoke and /poll with TWO door
// bindings and proves the job actually leaves on one box and the poll returns to THAT box.
//
// It exists because a mutation exposed the gap: re-hardcoding `name: DOOR_ROUTE_NAME` in
// doorTransport (the exact cf#480 line this change replaces) left the whole unit suite GREEN,
// because the unit suite never mints a token through the module. A guard that cannot see the
// regression it was written for is not a guard.
//
// Recorder discipline is cf#480's, reused rather than reinvented: the load-bearing assertions are
// ZEROS (this box was not called), so a sibling case proves each recorder DOES capture.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import finishUpscale from "../modules/finish-upscale/src/index";
import speechUpscale from "../modules/speech-upscale/src/index";
import { DOOR_ROUTE_NAME, doorName } from "../modules/_shared/finish-door";

const TOKEN_LEGACY = "lft_cf507w_legacy_probe_a41c";
const TOKEN_PROP = "lft_cf507w_propagandhi_probe_d92f";
const RUNPOD_KEY = "rpa_cf507w_runpod_probe";
const ENDPOINT = "cf507wendpoint01";
const PROPAGANDHI = doorName("propagandhi");

function recorder(respond: (path: string, method: string) => Response) {
  const calls: { path: string; method: string; auth: string }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    const auth = Object.keys(h).reduce((a, k) => (k.toLowerCase() === "authorization" ? h[k] : a), "");
    calls.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET", auth });
    return respond(new URL(String(input)).pathname, init?.method ?? "GET");
  });
  return { binding: { fetch: fn as unknown as typeof fetch }, calls };
}

const runOk = (id: string) => new Response(JSON.stringify({ id }), { status: 200, headers: { "content-type": "application/json" } });
const done = (o: unknown) => new Response(JSON.stringify({ status: "COMPLETED", output: o }), { status: 200, headers: { "content-type": "application/json" } });
const notFound = () => new Response(JSON.stringify({ status: 404, title: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });

type Worker = { fetch(r: Request, e: never): Promise<Response> };
const FINISH = finishUpscale as unknown as Worker;
const SPEECH = speechUpscale as unknown as Worker;
const post = (w: Worker, p: string, env: unknown, b: unknown) =>
  w.fetch(new Request("https://module.internal" + p, { method: "POST", body: JSON.stringify(b) }), env as never);
const body = async (r: Response) => (await r.json()) as Record<string, never>;
const FINISH_INPUT = { shot_id: "shot_01", clip_key: "p/shot_01.mp4", src_fps: 24, frames: 96 };
const label = (poll: string) => (JSON.parse(atob(poll)) as { door?: string }).door;

let realFetch: typeof fetch;
beforeEach(() => { realFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = realFetch; });

describe("cf507 wire: two bound doors both carry jobs, and each poll goes home", () => {
  function bothDoors(legacyRespond = (p: string) => (p === "/run" ? runOk("job-legacy") : done({ shot_id: "shot_01", clip_key: "p/a.mp4" })),
                     propRespond = (p: string) => (p === "/run" ? runOk("job-prop") : done({ shot_id: "shot_01", clip_key: "p/b.mp4" }))) {
    const legacy = recorder(legacyRespond);
    const prop = recorder(propRespond);
    const env = {
      RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT,
      FINISH_UPSCALE_VPC: legacy.binding, FINISH_DOOR_TOKEN: TOKEN_LEGACY,
      FINISH_UPSCALE_VPC_PROPAGANDHI: prop.binding, FINISH_DOOR_TOKEN_PROPAGANDHI: TOKEN_PROP,
    };
    return { legacy, prop, env };
  }

  it("consecutive submits land on DIFFERENT boxes -- the second box is actually used", async () => {
    const rp = recorder(() => runOk("runpod"));
    globalThis.fetch = rp.binding.fetch as unknown as typeof fetch;
    const { legacy, prop, env } = bothDoors();

    const a = await body(await post(FINISH, "/invoke", env, { hook: "finish", input: FINISH_INPUT, config: {}, context: { project: "cf507" } }));
    const b = await body(await post(FINISH, "/invoke", env, { hook: "finish", input: FINISH_INPUT, config: {}, context: { project: "cf507" } }));

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    // THE cf#507 assertion: one job each. Idle iron is the whole defect being fixed.
    expect(legacy.calls.filter((c) => c.path === "/run").length).toBe(1);
    expect(prop.calls.filter((c) => c.path === "/run").length).toBe(1);
    expect(rp.calls.length).toBe(0);   // never RunPod while a door is bound
  });

  it("each submit records ITS OWN door in the poll token, not a shared constant", async () => {
    globalThis.fetch = recorder(() => runOk("runpod")).binding.fetch as unknown as typeof fetch;
    const { env } = bothDoors();

    const a = await body(await post(FINISH, "/invoke", env, { hook: "finish", input: FINISH_INPUT, config: {}, context: { project: "cf507" } }));
    const b = await body(await post(FINISH, "/invoke", env, { hook: "finish", input: FINISH_INPUT, config: {}, context: { project: "cf507" } }));

    // This is the assertion the `name: DOOR_ROUTE_NAME` mutation breaks: with a constant, BOTH
    // tokens read "vpc" and every poll goes to the legacy box regardless of who holds the job.
    const labels = [label(a.poll as unknown as string), label(b.poll as unknown as string)].sort();
    expect(labels).toEqual([DOOR_ROUTE_NAME, PROPAGANDHI].sort());
  });

  it("a propagandhi-minted token polls PROPAGANDHI and the legacy box is never touched", async () => {
    const rp = recorder(() => notFound());
    globalThis.fetch = rp.binding.fetch as unknown as typeof fetch;
    const { legacy, prop, env } = bothDoors();

    const res = await body(await post(FINISH, "/poll", env, {
      poll: btoa(JSON.stringify({ jobId: "job-prop", shotId: "shot_01", srcFps: 24, frames: 96, submittedAt: Date.now(), door: PROPAGANDHI })),
    }));

    expect(res.ok).toBe(true);
    expect(prop.calls.map((c) => c.path)).toContain("/status/job-prop");
    // The zero that matters: the legacy box does not hold this id and would 404, which
    // runpodJobGone reads as a GC'd job -- destroyed work wearing a legitimate verdict.
    expect(legacy.calls.length).toBe(0);
    expect(rp.calls.length).toBe(0);
    // and it presented THAT door's bearer, not the other one's
    expect(prop.calls[0].auth).toBe("Bearer " + TOKEN_PROP);
  });

  it("CONTROL: the legacy recorder DOES capture, so the zero above is a finding not a dead spy", async () => {
    globalThis.fetch = recorder(() => notFound()).binding.fetch as unknown as typeof fetch;
    const { legacy, prop, env } = bothDoors();

    const res = await body(await post(FINISH, "/poll", env, {
      poll: btoa(JSON.stringify({ jobId: "job-legacy", shotId: "shot_01", srcFps: 24, frames: 96, submittedAt: Date.now(), door: DOOR_ROUTE_NAME })),
    }));

    expect(res.ok).toBe(true);
    expect(legacy.calls.map((c) => c.path)).toContain("/status/job-legacy");
    expect(prop.calls.length).toBe(0);
  });

  it("BACK-COMPAT at the wire: an in-flight bare-'vpc' token still reaches the legacy box", async () => {
    globalThis.fetch = recorder(() => notFound()).binding.fetch as unknown as typeof fetch;
    const { legacy, prop, env } = bothDoors();

    const res = await body(await post(FINISH, "/poll", env, {
      poll: btoa(JSON.stringify({ jobId: "old-job", shotId: "shot_01", srcFps: 24, frames: 96, submittedAt: Date.now(), door: "vpc" })),
    }));

    expect(res.ok).toBe(true);
    expect(legacy.calls.map((c) => c.path)).toContain("/status/old-job");
    expect(prop.calls.length).toBe(0);
  });

  it("speech-upscale does the same across its two doors", async () => {
    const rp = recorder(() => runOk("runpod"));
    globalThis.fetch = rp.binding.fetch as unknown as typeof fetch;
    const legacy = recorder((p) => (p === "/run" ? runOk("s-legacy") : done({ shot_id: "shot_01", audio_key: "p/a.wav" })));
    const prop = recorder((p) => (p === "/run" ? runOk("s-prop") : done({ shot_id: "shot_01", audio_key: "p/b.wav" })));
    const env = {
      RUNPOD_API_KEY: RUNPOD_KEY, RUNPOD_ENDPOINT_ID: ENDPOINT,
      SPEECH_UPSCALE_VPC: legacy.binding, SPEECH_DOOR_TOKEN: TOKEN_LEGACY,
      SPEECH_UPSCALE_VPC_PROPAGANDHI: prop.binding, SPEECH_DOOR_TOKEN_PROPAGANDHI: TOKEN_PROP,
    };
    const inv = { hook: "speech", input: { shot_id: "shot_01", audio_key: "p/shot_01.wav" }, config: { enable: true }, context: { project: "cf507" } };

    const a = await body(await post(SPEECH, "/invoke", env, inv));
    const b = await body(await post(SPEECH, "/invoke", env, inv));

    expect(legacy.calls.filter((c) => c.path === "/run").length).toBe(1);
    expect(prop.calls.filter((c) => c.path === "/run").length).toBe(1);
    expect([label(a.poll as unknown as string), label(b.poll as unknown as string)].sort()).toEqual([DOOR_ROUTE_NAME, PROPAGANDHI].sort());
    expect(rp.calls.length).toBe(0);
  });
});
