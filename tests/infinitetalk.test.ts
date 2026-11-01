import { describe, it, expect, vi, afterEach } from "vitest";
import { buildKlingBody, clampDuration, clipKey, encodePoll, extractVideoUrl } from "../modules/infinitetalk/src/kling";
import worker from "../modules/infinitetalk/src/index";

const INPUT = { shot_id: "shot_01", keyframe_url: "https://r2/kf.png", prompt: "a portrait", seconds: 3 };

describe("infinitetalk: the size knob is gone and must stay gone (cf#935)", () => {
  // These are the guards for cf#935. The provider ignores `size` -- 480p and 720p both deliver
  // 832x464, measured three ways including a direct submit that bypassed this worker (RunPod job
  // d159bf34-3f84-41fa-a472-1d3875178638-u1). RunPod's own docs still describe the parameter as
  // required with both values valid and price 720p at double, so the pressure to re-add the enum
  // from those docs is real and ongoing. Each assertion below FAILS if someone does.

  it("sends size 480p even when a caller asks for 720p", () => {
    const body = buildKlingBody(INPUT, { size: "720p" });
    expect(body.input.size).toBe("480p");
  });

  it("sends size 480p for every value a re-added enum could produce", () => {
    for (const size of ["720p", "1080p", "480p", "", undefined, null, 720]) {
      expect(buildKlingBody(INPUT, { size }).input.size).toBe("480p");
    }
  });

  it("does not advertise a size field in config_schema", async () => {
    const res = await worker.fetch(new Request("https://m/module.json"), {} as never);
    const manifest = (await res.json()) as { version: string; config_schema?: Record<string, unknown> };
    expect(manifest.config_schema).toBeDefined();
    expect(Object.keys(manifest.config_schema!)).not.toContain("size");
  });

  it("states the real output resolution in ui.limits, so the removed knob is not a silent loss", async () => {
    const res = await worker.fetch(new Request("https://m/module.json"), {} as never);
    const manifest = (await res.json()) as { ui?: { limits?: string[] } };
    const limits = manifest.ui?.limits ?? [];
    expect(limits.some((l) => l.includes("480p"))).toBe(true);
  });

  it("carries the breaking version bump that removing a published config field requires", async () => {
    const res = await worker.fetch(new Request("https://m/module.json"), {} as never);
    const manifest = (await res.json()) as { version: string };
    expect(manifest.version).toBe("0.2.1");
  });

  it("still honours the rest of the config surface, so this is a targeted removal", () => {
    expect(buildKlingBody(INPUT, {}).input.enable_safety_checker).toBe(true);
  });
});

describe("infinitetalk: unchanged behaviour guarded alongside the cf#935 edit", () => {
  it("requires Cast audio and passes it through", () => {
    expect(buildKlingBody({ ...INPUT, audio_url: "https://r2/line.wav" }, {}).input.audio).toBe("https://r2/line.wav");
    expect(buildKlingBody(INPUT, { audio_url: "https://r2/cfg.wav" }).input.audio).toBe("https://r2/cfg.wav");
    expect(buildKlingBody(INPUT, {}).input.audio).toBe("");
  });

  it("clampDuration holds the declared 2-15s window", () => {
    expect(clampDuration(1)).toBe(2);
    expect(clampDuration(3)).toBe(3);
    expect(clampDuration(99)).toBe(15);
  });

  it("clipKey and extractVideoUrl are untouched", () => {
    expect(clipKey("p", "shot_01")).toBe("renders/p/clips/shot_01_infinitetalk.mp4");
    expect(extractVideoUrl({ output: { video_url: "https://cdn/x.mp4" } })).toBe("https://cdn/x.mp4");
  });
});

describe("infinitetalk: a stopped film can stop a clip job (cf#1221)", () => {
  afterEach(() => vi.unstubAllGlobals());
  const env = { RUNPOD_API_KEY: "k" } as never;
  const token = encodePoll({ jobId: "job-1", project: "p", shotId: "s", seconds: 4, submittedAt: 1 } as never);
  const post = (body: unknown) => new Request("https://m/cancel", { method: "POST", body: JSON.stringify(body) });
  function stub(status: number) {
    const f = vi.fn(async () => new Response("{}", { status }));
    vi.stubGlobal("fetch", f);
    return f;
  }

  it("declares it", async () => {
    const res = await worker.fetch(new Request("https://m/module.json"), {} as never);
    expect(((await res.json()) as { cancelable?: boolean }).cancelable).toBe(true);
  });

  it("posts to the public endpoint's cancel with the key", async () => {
    const f = stub(200);
    const res = await worker.fetch(post({ poll: token }), env);
    expect(await res.json()).toEqual({ ok: true });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.runpod.ai/v2/infinitetalk/cancel/job-1");
    expect(init.method).toBe("POST");
    expect(JSON.stringify(init.headers)).toContain("k");
  });

  it("a job already gone is what was asked for", async () => {
    stub(404);
    expect(await (await worker.fetch(post({ poll: token }), env)).json()).toEqual({ ok: true });
  });

  it("any other answer is a failure, by name", async () => {
    stub(500);
    expect(await (await worker.fetch(post({ poll: token }), env)).json()).toEqual({ ok: false, error: "infinitetalk /cancel -> 500" });
  });

  it("a throw is a failure, not a crash", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("down"); }));
    expect(await (await worker.fetch(post({ poll: token }), env)).json()).toEqual({ ok: false, error: "infinitetalk cancel failed: down" });
  });

  it("refuses a bad token, no token and no key, without calling out", async () => {
    const f = stub(200);
    expect(((await (await worker.fetch(post({ poll: "@@@" }), env)).json()) as { ok: boolean }).ok).toBe(false);
    expect(((await (await worker.fetch(post({}), env)).json()) as { ok: boolean }).ok).toBe(false);
    expect(((await (await worker.fetch(new Request("https://m/cancel", { method: "POST", body: "{" }), env)).json()) as { ok: boolean }).ok).toBe(false);
    expect(((await (await worker.fetch(post({ poll: token }), {} as never)).json()) as { ok: boolean }).ok).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});

