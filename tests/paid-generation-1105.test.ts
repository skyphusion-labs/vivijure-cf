import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyTransientFailure } from "@skyphusion-labs/vivijure-core/render-orchestrator";
import { NOT_STORED_ERROR, NO_VIDEO_URL_ERROR } from "../modules/_shared/paid-generation";
import { CfFlux3VideoWorkflow } from "../modules/cf-flux-3-video/src/index";
import { CfGrokVideoWorkflow } from "../modules/cf-grok-video/src/index";
import { CfHailuoWorkflow } from "../modules/cf-hailuo/src/index";
import { CfHh1R2vWorkflow } from "../modules/cf-hh1-r2v/src/index";
import { CfKlingV4Workflow } from "../modules/cf-kling-v4/src/index";
import { CfMinimaxH3Workflow } from "../modules/cf-minimax-h3/src/index";
import { CfPVideoAvatarWorkflow } from "../modules/cf-p-video-avatar/src/index";
import { CfSeedanceWorkflow } from "../modules/cf-seedance/src/index";
import { CfVeoWorkflow } from "../modules/cf-veo/src/index";
import { CfViduQ3TurboWorkflow } from "../modules/cf-vidu-q3-turbo/src/index";
import { fx, FX_25FPS_B64 } from "./fixtures/mp4-timing-fixtures";

// cf#1105. A failure after the provider succeeds must not buy the run again. Each door's real workflow
// class runs over a step fake that honours `retries.limit`, the way a workflow does.

type Ctor = new (ctx: never, env: never) => { run(event: never, step: never): Promise<void> };
const DOORS: [string, Ctor][] = [
  ["cf-flux-3-video", CfFlux3VideoWorkflow as unknown as Ctor],
  ["cf-grok-video", CfGrokVideoWorkflow as unknown as Ctor],
  ["cf-hailuo", CfHailuoWorkflow as unknown as Ctor],
  ["cf-hh1-r2v", CfHh1R2vWorkflow as unknown as Ctor],
  ["cf-kling-v4", CfKlingV4Workflow as unknown as Ctor],
  ["cf-minimax-h3", CfMinimaxH3Workflow as unknown as Ctor],
  ["cf-p-video-avatar", CfPVideoAvatarWorkflow as unknown as Ctor],
  ["cf-seedance", CfSeedanceWorkflow as unknown as Ctor],
  ["cf-veo", CfVeoWorkflow as unknown as Ctor],
  ["cf-vidu-q3-turbo", CfViduQ3TurboWorkflow as unknown as Ctor],
];

const GOOD = {
  state: "Completed",
  video: "https://cdn.example/x.mp4",
  url: "https://cdn.example/x.mp4",
  task: { status: "succeeded", content: { url: "https://cdn.example/x.mp4" } },
  result: { video: "https://cdn.example/x.mp4", url: "https://cdn.example/x.mp4" },
};

const step = {
  do: async (_name: string, config: { retries?: { limit: number } }, fn: () => Promise<unknown>) => {
    const tries = (config.retries?.limit ?? 0) + 1;
    let last: unknown;
    for (let i = 0; i < tries; i++) {
      try {
        return await fn();
      } catch (e) {
        last = e;
      }
    }
    throw last;
  },
};

function harness(aiRun: () => Promise<unknown>) {
  const store = new Map<string, unknown>();
  const ai = vi.fn(aiRun);
  const env = {
    GATEWAY_ID: "gw",
    AI: { run: ai },
    R2_RENDERS: {
      put: async (k: string, v: unknown) => { store.set(k, v); },
      get: async () => null,
    },
    // cf-grok-video mints an upload URL before the call.
    R2_S3_ACCESS_KEY_ID: "k",
    R2_S3_SECRET_ACCESS_KEY: "s",
    R2_S3_ENDPOINT: "https://r2.example",
    R2_S3_BUCKET: "b",
  };
  const states = () =>
    [...store.entries()].filter(([k]) => k.endsWith(".state.json")).map(([, v]) => JSON.parse(v as string) as { status: string; error?: string });
  return { env, ai, states };
}

const payload = {
  job_id: "job-1",
  project: "p",
  shot_id: "shot_01",
  seconds: 5,
  input: { shot_id: "shot_01", keyframe_url: "https://r2.example/k.png", prompt: "p", seconds: 5, audio_url: "https://r2.example/a.wav" },
  config: { model: "bytedance/seedance-2.5", resolution: "720p", aspect_ratio: "16:9", generate_audio: true, camera_fixed: false, seed: -1 },
};

function stubFetch(video: () => Response) {
  vi.stubGlobal("fetch", vi.fn(async (u: string) =>
    String(u).includes("cdn.example") ? video() : new Response(new Uint8Array([1, 2, 3]))));
}
const clip = () => new Response(fx(FX_25FPS_B64));

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe.each(DOORS)("%s", (_name, Workflow) => {
  const run = (env: unknown) => new Workflow({} as never, env as never).run({ payload } as never, step as never);

  it("control: a good response is one provider call and a done clip", async () => {
    stubFetch(clip);
    const h = harness(async () => GOOD);
    await run(h.env);
    expect(h.ai).toHaveBeenCalledTimes(1);
    expect(h.states().at(-1)?.status).toBe("done");
  });

  it("a parse failure after a provider success is one call, and it reports the failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    stubFetch(clip);
    const h = harness(async () => ({ state: "Completed", result: { nothing: true } }));
    await run(h.env);
    expect(h.ai).toHaveBeenCalledTimes(1);
    const last = h.states().at(-1);
    expect(last?.status).toBe("failed");
    // cf-grok-video checks R2 for its own upload first, so its miss is reported from the store step.
    expect(last?.error).toMatch(/no video URL|not stored/);
  });

  it("a download that never works is one provider call, and the store did retry", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const download = vi.fn(() => new Response("", { status: 503 }));
    stubFetch(download);
    const h = harness(async () => GOOD);
    await run(h.env);
    expect(h.ai).toHaveBeenCalledTimes(1);
    expect(download).toHaveBeenCalledTimes(3);
    const last = h.states().at(-1);
    expect(last?.status).toBe("failed");
    expect(last?.error).toBe(NOT_STORED_ERROR);
  });

  it("a provider call that throws still retries", async () => {
    stubFetch(clip);
    let n = 0;
    const h = harness(async () => {
      n += 1;
      if (n < 3) throw new Error("AiGatewayError: 2002: Error");
      return GOOD;
    });
    await run(h.env);
    expect(h.ai).toHaveBeenCalledTimes(3);
    expect(h.states().at(-1)?.status).toBe("done");
  });
});

describe("the words core reads", () => {
  it("do not read as transient, so core does not resubmit and re-buy", () => {
    expect(classifyTransientFailure(NOT_STORED_ERROR)).toBe("deterministic");
    expect(classifyTransientFailure(NO_VIDEO_URL_ERROR)).toBe("deterministic");
  });

  it("control: the classifier can say transient", () => {
    expect(classifyTransientFailure("fetch failed: timeout")).toBe("transient");
  });
});
