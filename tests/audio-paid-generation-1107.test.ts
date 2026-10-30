import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyTransientFailure } from "@skyphusion-labs/vivijure-core/render-orchestrator";
import { NOT_STORED_AUDIO_ERROR } from "../modules/_shared/paid-generation";
import { MusicGenWorkflow } from "../modules/music-gen/src/index";
import { ChatterboxWorkflow } from "../modules/chatterbox/src/index";

// cf#1107. The real workflow classes over a step fake that honours `retries.limit`, as in cf#1105.

afterEach(() => vi.restoreAllMocks());
type Ctor = new (ctx: never, env: never) => { run(event: never, step: never): Promise<void> };

const step = {
  names: [] as string[],
  do: async (name: string, config: { retries?: { limit: number } }, fn: () => Promise<unknown>) => {
    step.names.push(name);
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

/** R2 where an audio write can fail. State JSON always writes, so a terminal state can be read back. */
function r2(failAudioPuts: number) {
  const store = new Map<string, unknown>();
  let left = failAudioPuts;
  return {
    store,
    bucket: {
      put: async (k: string, v: unknown) => {
        if (typeof v !== "string" && left-- > 0) throw new Error("R2 write failed: network connection lost");
        store.set(k, v);
      },
      get: async () => null,
    },
  };
}
const lastState = (store: Map<string, unknown>) => {
  const v = [...store.entries()].filter(([, x]) => typeof x === "string").at(-1)?.[1];
  return v ? (JSON.parse(v as string) as { status: string; error?: string; audio?: unknown[] }) : null;
};
const quiet = () => { vi.spyOn(console, "error").mockImplementation(() => {}); vi.spyOn(console, "warn").mockImplementation(() => {}); };

describe("music-gen", () => {
  const run = async (opts: { result?: unknown; audioStatuses?: number[]; failPuts?: number; ai?: () => Promise<unknown> }) => {
    quiet();
    step.names = [];
    const { store, bucket } = r2(opts.failPuts ?? 0);
    const ai = vi.fn(opts.ai ?? (async () => opts.result ?? { audio: "https://cdn.example/a.mp3" }));
    const statuses = [...(opts.audioStatuses ?? [])];
    const fetcher = vi.fn(async () => new Response("mp3bytes", { status: statuses.shift() ?? 200, headers: { "content-type": "audio/mpeg" } }));
    vi.stubGlobal("fetch", fetcher);
    const wf = new (MusicGenWorkflow as unknown as Ctor)({} as never, { GATEWAY_ID: "gw", AI: { run: ai }, R2_RENDERS: bucket } as never);
    await wf.run({ payload: { job_id: "j", input: { film_key: "f", prompt: "x" }, config: { prompt: "a tune" } } } as never, step as never);
    return { ai, fetcher, state: lastState(store), store };
  };

  it("an R2 write that keeps failing buys the track once", async () => {
    const { ai, state } = await run({ failPuts: 99 });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ status: "failed", error: NOT_STORED_AUDIO_ERROR });
  });
  it("an audio download that keeps failing buys the track once", async () => {
    const { ai, state } = await run({ audioStatuses: [503, 503, 503, 503] });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(state?.status).toBe("failed");
  });
  it("a blip on the write recovers with no second purchase", async () => {
    const { ai, state, fetcher } = await run({ failPuts: 1 });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(state?.status).toBe("done");
  });
  it("an answer with no URL buys once and fails", async () => {
    const { ai, state } = await run({ result: { nope: true } });
    expect(ai).toHaveBeenCalledTimes(1);
    expect(state).toMatchObject({ status: "failed" });
    expect(state?.error).toMatch(/no audio URL/);
  });
  it("a provider call that throws still retries, since nothing was bought", async () => {
    let n = 0;
    const { ai, state } = await run({ ai: async () => { if (n++ === 0) throw new Error("gateway blip"); return { audio: "https://cdn.example/a.mp3" }; } });
    expect(ai).toHaveBeenCalledTimes(2);
    expect(state?.status).toBe("done");
  });
  it("the healthy path stores and finishes", async () => {
    const { ai, state, store } = await run({});
    expect(ai).toHaveBeenCalledTimes(1);
    expect(state?.status).toBe("done");
    expect([...store.keys()].some((k) => k.includes("j"))).toBe(true);
  });
});

describe("chatterbox", () => {
  const LINES = [{ shot_id: "s1", text: "one", voice: "v" }, { shot_id: "s2", text: "two", voice: "v" }];
  const run = async (opts: { runsync?: () => unknown; audioStatuses?: number[]; failPuts?: number }) => {
    quiet();
    step.names = [];
    const { store, bucket } = r2(opts.failPuts ?? 0);
    const statuses = [...(opts.audioStatuses ?? [])];
    const calls = { runsync: 0, audio: 0 };
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (String(url).endsWith("/runsync")) {
        calls.runsync += 1;
        return Response.json(opts.runsync ? opts.runsync() : { status: "COMPLETED", output: { audio_url: "https://cdn.example/a.wav" } });
      }
      calls.audio += 1;
      return new Response("wavbytes", { status: statuses.shift() ?? 200 });
    }));
    const wf = new (ChatterboxWorkflow as unknown as Ctor)({} as never, { RUNPOD_API_KEY: "k", R2_RENDERS: bucket } as never);
    await wf.run({ payload: { job_id: "j", project: "p", lines: LINES } } as never, step as never);
    return { calls, state: lastState(store) };
  };

  it("an R2 write that keeps failing buys the first line once, and stops", async () => {
    const { calls, state } = await run({ failPuts: 99 });
    expect(calls.runsync).toBe(1);
    expect(state).toMatchObject({ status: "failed", error: NOT_STORED_AUDIO_ERROR });
  });
  it("a download that keeps failing buys once", async () => {
    const { calls } = await run({ audioStatuses: [503, 503, 503, 503, 503] });
    expect(calls.runsync).toBe(1);
  });
  it("a blip on a write recovers with no second purchase, across lines", async () => {
    const { calls, state } = await run({ failPuts: 1 });
    expect(calls.runsync).toBe(2);
    expect(state?.status).toBe("done");
    expect(state?.audio).toHaveLength(2);
  });
  it("each line has its own step names, so a line cannot read another's checkpoint", async () => {
    await run({});
    expect(new Set(step.names).size).toBe(step.names.length);
    expect(step.names).toEqual(["synth:s1", "store:s1", "synth:s2", "store:s2"]);
  });
  it("runsync with no audio yet is not a purchase we kept, so it may retry", async () => {
    let n = 0;
    const { calls, state } = await run({ runsync: () => (n++ === 0 ? { status: "IN_PROGRESS" } : { status: "COMPLETED", output: { audio_url: "https://cdn.example/a.wav" } }) });
    expect(calls.runsync).toBe(3);
    expect(state?.status).toBe("done");
  });
});

describe("the failure text", () => {
  it("cannot read as transient, so core does not resubmit a paid job", () => {
    expect(classifyTransientFailure(NOT_STORED_AUDIO_ERROR)).toBe("deterministic");
    expect(classifyTransientFailure("model completed but returned no audio URL")).toBe("deterministic");
  });
});
