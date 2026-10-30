// cf#1109: a film cancel must be able to stop a running GPU finish step. Each module's real /cancel is
// driven here, with only the network stubbed.
import { afterEach, describe, expect, it, vi } from "vitest";
import rife, { MANIFEST as RIFE } from "../modules/finish-rife/src/index";
import upscale, { MANIFEST as UPSCALE } from "../modules/finish-upscale/src/index";
import blender, { MANIFEST as BLENDER } from "../modules/finish-blender/src/index";
import { encodePoll as rifePoll } from "../modules/finish-rife/src/finish";
import { encodePoll as upscalePoll } from "../modules/finish-upscale/src/finish";
import { encodePoll as blenderPoll } from "../modules/finish-blender/src/finish";
import { DOOR_ROUTE_NAME } from "../modules/_shared/finish-door";

const secret = (v: string) => ({ get: async () => v });
const ENV = { RUNPOD_API_KEY: secret("k"), RUNPOD_ENDPOINT_ID: secret("ep1") } as never;
const STATE = { jobId: "job-1-u1", shotId: "s1", clipKey: "c.mp4", srcFps: 24, frames: 10, submittedAt: 1 } as never;

const MODULES = [
  { name: "finish-rife", worker: rife, manifest: RIFE, poll: () => rifePoll(STATE) },
  { name: "finish-upscale", worker: upscale, manifest: UPSCALE, poll: () => upscalePoll(STATE) },
  { name: "finish-blender", worker: blender, manifest: BLENDER, poll: () => blenderPoll(STATE) },
];

const cancel = (w: { fetch: (r: Request, e: never) => Promise<Response> }, poll: unknown) =>
  w.fetch(new Request("https://module/cancel", { method: "POST", body: JSON.stringify({ poll }) }), ENV)
    .then((r) => r.json() as Promise<{ ok: boolean; error?: string }>);

describe.each(MODULES)("$name /cancel", ({ name, worker, manifest, poll }) => {
  afterEach(() => vi.unstubAllGlobals());

  const upstream = (status: number) => {
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | Request, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method });
      return new Response("{}", { status });
    }));
    return calls;
  };

  it("advertises it, so the core will call it", () => {
    expect(manifest.cancelable).toBe(true);
  });

  it("posts the job the token names to RunPod", async () => {
    const calls = upstream(200);
    expect(await cancel(worker as never, poll())).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/ep1\/cancel\/job-1-u1$/);
    expect(calls[0].method).toBe("POST");
  });

  it("reads a 404 as not running, which is what the core needs to know", async () => {
    upstream(404);
    expect(await cancel(worker as never, poll())).toEqual({ ok: true });
  });

  it("reports any other status, so the core logs an orphan", async () => {
    upstream(500);
    const r = await cancel(worker as never, poll());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("500");
  });

  it("refuses a bad token without calling anything", async () => {
    const calls = upstream(200);
    const r = await cancel(worker as never, "not-a-token");
    expect(r).toEqual({ ok: false, error: `${name}: bad poll token` });
    expect(calls).toHaveLength(0);
  });

  it("refuses a missing token", async () => {
    const calls = upstream(200);
    expect((await cancel(worker as never, undefined)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("reports a network failure as data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("reset"); }));
    const r = await cancel(worker as never, poll());
    expect(r.ok).toBe(false);
    expect(r.error).toContain("reset");
  });
});

describe.each(MODULES)("$name /cancel through the plane", ({ worker, poll }) => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not read a plane-authored 404 as a stopped job", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 404, headers: { "x-vivijure-plane-refusal": "probe" } })));
    const env = { RUNPOD_API_KEY: secret("k"), RUNPOD_ENDPOINT_ID: secret("ep1"), RUNPOD_PROXY_BASE: "https://proxy.invalid/api/runpod/v2", RUNPOD_PROXY_TOKEN: "t" } as never;
    const r = await (worker as never as { fetch: (a: Request, e: never) => Promise<Response> })
      .fetch(new Request("https://module/cancel", { method: "POST", body: JSON.stringify({ poll: poll() }) }), env)
      .then((x) => x.json() as Promise<{ ok: boolean; error?: string }>);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("probe");
  });
});

describe("finish-upscale /cancel on a door job", () => {
  afterEach(() => vi.unstubAllGlobals());
  const doorPoll = () => upscalePoll({ ...(STATE as object), door: DOOR_ROUTE_NAME } as never);
  const send = (env: unknown) =>
    (upscale as never as { fetch: (a: Request, e: never) => Promise<Response> })
      .fetch(new Request("https://module/cancel", { method: "POST", body: JSON.stringify({ poll: doorPoll() }) }), env as never)
      .then((x) => x.json() as Promise<{ ok: boolean; error?: string }>);

  it("cancels on the door that holds the job, and never on RunPod", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (u: string) => { urls.push(String(u)); return new Response("{}", { status: 200 }); }));
    const r = await send({ RUNPOD_API_KEY: secret("k"), RUNPOD_ENDPOINT_ID: secret("ep1"), FINISH_DOOR_TOKEN: "t", FINISH_UPSCALE_DOORS: "https://door.test" });
    expect(r).toEqual({ ok: true });
    expect(urls).toEqual(["https://door.test/cancel/job-1-u1"]);
  });

  it("reports an unbound door, because the job may still be running there", async () => {
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r = await send({ RUNPOD_API_KEY: secret("k"), RUNPOD_ENDPOINT_ID: secret("ep1") });
    expect(r.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
