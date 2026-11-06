// vivijure-cf#1164. A queued /runsync job is a job, not a failure. It is polled by its id, never submitted
// again, and a give-up cancels it and says the status it was stuck in. Reply shapes are the RunPod docs'
// own (serverless/endpoints/operation-reference, /runsync and /status): `{ id, status }` while queued or
// running, `{ id, status: "COMPLETED", output }` when done, `{ id, status: "FAILED", error }` with HTTP 400.
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatterboxWorkflow } from "../modules/chatterbox/src/index";
import { LINE_MAX_POLLS, readJobReply } from "../modules/chatterbox/src/chatterbox";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
type Ctor = new (ctx: never, env: never) => { run(event: never, step: never): Promise<void> };

const ID = "sync-79164ff4-d212-44bc-9fe3-389e199a5c15";
const DONE = { delayTime: 824, executionTime: 3391, id: ID, output: { audio_url: "https://cdn.example/a.wav" }, status: "COMPLETED" };
const QUEUED = { id: ID, status: "IN_QUEUE" };
const RUNNING = { id: ID, status: "IN_PROGRESS" };
const FAILED = { id: ID, status: "FAILED", error: "Invalid prompt" };

/** A step fake that honours retries.limit and records each step and sleep, like the cf#1105 fake. */
function makeStep() {
  const s = {
    names: [] as string[],
    sleeps: 0,
    do: async (name: string, a: unknown, b?: unknown) => {
      const fn = (typeof a === "function" ? a : b) as () => Promise<unknown>;
      const config = (typeof a === "function" ? {} : a) as { retries?: { limit: number } };
      s.names.push(name);
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
    sleep: async (name: string) => {
      s.names.push(name);
      s.sleeps += 1;
    },
  };
  return s;
}

interface Script {
  runsync: () => Response;
  status?: () => Response;
}

async function run(script: Script, lines = [{ shot_id: "shot_01", text: "one", voice: "angus" }]) {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const store = new Map<string, unknown>();
  const bucket = { put: async (k: string, v: unknown) => void store.set(k, v), get: async () => null };
  const calls = { runsync: 0, status: [] as string[], cancel: [] as string[], audio: 0 };
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const u = String(input);
    if (u.endsWith("/runsync")) {
      calls.runsync += 1;
      return script.runsync();
    }
    if (u.includes("/status/")) {
      calls.status.push(u.slice(u.indexOf("/status/") + 8));
      return script.status ? script.status() : Response.json(RUNNING);
    }
    if (u.includes("/cancel/")) {
      calls.cancel.push(u.slice(u.indexOf("/cancel/") + 8));
      return Response.json({ id: ID, status: "CANCELLED" });
    }
    calls.audio += 1;
    return new Response("wavbytes", { status: 200 });
  }));
  const step = makeStep();
  const wf = new (ChatterboxWorkflow as unknown as Ctor)({} as never, { RUNPOD_API_KEY: "k", R2_RENDERS: bucket } as never);
  await wf.run({ payload: { job_id: "j", project: "p", lines } } as never, step as never);
  const raw = store.get("chatterbox/j.state.json") as string | undefined;
  const state = raw ? (JSON.parse(raw) as { status: string; error?: string; audio?: unknown[] }) : null;
  return { calls, state, step };
}

const seq = (...bodies: Array<[unknown, number?]>) => {
  const left = [...bodies];
  return () => {
    const [b, s] = left.length > 1 ? left.shift()! : left[0];
    return Response.json(b, { status: s ?? 200 });
  };
};

describe("a queued /runsync line (cf#1164)", () => {
  it("is polled by its id until it completes, and is bought once", async () => {
    const { calls, state } = await run({ runsync: seq([QUEUED]), status: seq([QUEUED], [RUNNING], [DONE]) });
    expect(calls.runsync).toBe(1);
    expect(calls.status).toEqual([ID, ID, ID]);
    expect(calls.cancel).toEqual([]);
    expect(state?.status).toBe("done");
    expect(state?.audio).toHaveLength(1);
  });

  it("is never submitted again, however long it queues; a give-up cancels it and names the status", async () => {
    const { calls, state, step } = await run({ runsync: seq([QUEUED]), status: seq([QUEUED]) });
    expect(calls.runsync).toBe(1);
    expect(calls.status).toHaveLength(LINE_MAX_POLLS);
    expect(step.sleeps).toBe(LINE_MAX_POLLS);
    expect(calls.cancel).toEqual([ID]);
    expect(state?.status).toBe("failed");
    expect(state?.error).toContain(ID);
    expect(state?.error).toContain("IN_QUEUE");
    expect(state?.error).toContain("cancelled");
    expect(state?.error).not.toContain("no audio_url");
  });

  it("a status read that blips is one more poll, not a resubmit", async () => {
    const { calls, state } = await run({ runsync: seq([RUNNING]), status: seq([{}, 502], [DONE]) });
    expect(calls.runsync).toBe(1);
    expect(calls.status).toHaveLength(2);
    expect(state?.status).toBe("done");
  });

  it("a status read that keeps failing still ends in a cancel, not an abandoned job", async () => {
    const { calls, state } = await run({ runsync: seq([RUNNING]), status: seq([{}, 502]) });
    expect(calls.runsync).toBe(1);
    expect(calls.status).toHaveLength(LINE_MAX_POLLS);
    expect(calls.cancel).toEqual([ID]);
    expect(state?.error).toContain("IN_PROGRESS");
    expect(state?.error).toContain("HTTP 502");
  });

  it("a job that fails while queued fails the line with the provider status and error", async () => {
    const { calls, state } = await run({ runsync: seq([QUEUED]), status: seq([FAILED]) });
    expect(calls.runsync).toBe(1);
    expect(calls.cancel).toEqual([]);
    expect(state?.status).toBe("failed");
    expect(state?.error).toContain("FAILED");
    expect(state?.error).toContain("Invalid prompt");
  });

  it("a FAILED /runsync on HTTP 400 keeps the provider error and does not resubmit", async () => {
    const { calls, state } = await run({ runsync: seq([FAILED, 400]) });
    expect(calls.runsync).toBe(1);
    expect(state?.status).toBe("failed");
    expect(state?.error).toContain("Invalid prompt");
    expect(state?.error).toContain("HTTP 400");
  });

  it("a request that reached no job may retry, since nothing was queued", async () => {
    const { calls, state } = await run({ runsync: seq([{}, 503], [DONE]) });
    expect(calls.runsync).toBe(2);
    expect(state?.status).toBe("done");
  });

  it("each poll has its own step name, so no poll reads another's checkpoint", async () => {
    const { step } = await run({ runsync: seq([QUEUED]), status: seq([QUEUED], [DONE]) });
    expect(step.names).toEqual([
      "synth:shot_01", "wait:shot_01:1", "status:shot_01:1", "wait:shot_01:2", "status:shot_01:2", "store:shot_01",
    ]);
  });
});

describe("readJobReply", () => {
  it("reads the documented shapes", () => {
    expect(readJobReply(200, DONE)).toEqual({ kind: "done", url: "https://cdn.example/a.wav" });
    expect(readJobReply(200, QUEUED)).toEqual({ kind: "pending", id: ID, status: "IN_QUEUE" });
    expect(readJobReply(200, RUNNING)).toEqual({ kind: "pending", id: ID, status: "IN_PROGRESS" });
    expect(readJobReply(400, FAILED)).toMatchObject({ kind: "failed" });
    for (const s of ["CANCELLED", "TIMED_OUT"]) expect(readJobReply(200, { id: ID, status: s })).toMatchObject({ kind: "failed" });
  });
  it("a finished job with no audio is a failure that names the job, never a pending one", () => {
    const r = readJobReply(200, { id: ID, status: "COMPLETED", output: {} });
    expect(r).toMatchObject({ kind: "failed" });
    expect(r && r.kind === "failed" ? r.error : "").toContain(ID);
  });
  it("a queued reply with no id cannot be polled, so it fails rather than buy a second job", () => {
    expect(readJobReply(200, { status: "IN_QUEUE" })).toMatchObject({ kind: "failed" });
  });
  it("a reply with no job status is null, so the caller knows no job was reached", () => {
    expect(readJobReply(503, null)).toBeNull();
    expect(readJobReply(503, { error: "upstream" })).toBeNull();
  });
});
