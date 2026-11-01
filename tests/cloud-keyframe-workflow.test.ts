// cloud-keyframe draws in a Workflow: progress does not depend on a poll, and a poll draws nothing.
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../modules/cloud-keyframe/src/image-gen", async (orig) => {
  const real = await orig<typeof import("../modules/cloud-keyframe/src/image-gen")>();
  return { ...real, generateImage: vi.fn() };
});

import worker, { CloudKeyframeWorkflow } from "../modules/cloud-keyframe/src/index";
import { generateImage } from "../modules/cloud-keyframe/src/image-gen";
import { decodePoll, stateKey, encodePoll } from "../modules/cloud-keyframe/src/keyframe";

const tiny = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1]).buffer as ArrayBuffer, mime: "image/png" };

function state(shots: string[]) {
  return {
    project: "neon", job_id: "j", model: "google/nano-banana-2", width: 64, height: 64,
    slot_refs: {}, done: [], total: shots.length, film_ref: { mode: "none" },
    shots: shots.map((id) => ({ shot_id: id, prompt: "a wide street", slots: [] })),
  };
}

function fakeR2() {
  const m = new Map<string, ArrayBuffer | string>();
  return {
    map: m,
    async get(key: string) {
      if (!m.has(key)) return null;
      const v = m.get(key)!;
      return {
        async arrayBuffer() { return v as ArrayBuffer; },
        async text() { return String(v); },
        async blob() { return new Blob([v]); },
      };
    },
    async put(key: string, value: ArrayBuffer | string) { m.set(key, value); },
  };
}

function makeEnv(shots: string[], status = "running") {
  const R2 = fakeR2();
  R2.map.set(stateKey("neon", "j"), JSON.stringify(state(shots)));
  const instance = { id: "wf-1", status: vi.fn(async () => ({ status })), terminate: vi.fn(async () => undefined) };
  const KEYFRAME_WORKFLOW = { create: vi.fn(async () => instance), get: vi.fn(async () => instance) };
  return { R2, instance, KEYFRAME_WORKFLOW, env: { AI: {}, GATEWAY_ID: "gw", R2_RENDERS: R2, KEYFRAME_WORKFLOW } };
}

function fakeStep() {
  const names: string[] = [];
  const sleeps: string[] = [];
  return {
    names, sleeps,
    step: {
      async do(name: string, a: unknown, b?: unknown) {
        names.push(name);
        return await ((b ?? a) as () => Promise<unknown>)();
      },
      async sleep(name: string) { sleeps.push(name); },
    },
  };
}

async function runWorkflow(env: unknown, s: ReturnType<typeof fakeStep>) {
  const wf = new CloudKeyframeWorkflow({} as never, env as never);
  await wf.run({ payload: { project: "neon", job_id: "j" } } as never, s.step as never);
}

const token = encodePoll({ project: "neon", job_id: "j", workflow_id: "wf-1" });
async function post(env: unknown, path: string, poll: string) {
  const res = await worker.fetch(new Request("http://m" + path, { method: "POST", body: JSON.stringify({ poll }) }), env as never);
  return (await res.json()) as { ok: boolean; pending?: boolean; error?: string; output?: { keyframes: { shot_id: string }[] } };
}

beforeEach(() => {
  vi.mocked(generateImage).mockReset();
  vi.mocked(generateImage).mockImplementation(async () => tiny);
});

describe("cloud-keyframe workflow", () => {
  it("draws every shot with no poll at all", async () => {
    const { env, R2 } = makeEnv(["shot_01", "shot_02", "shot_03"]);
    const s = fakeStep();
    await runWorkflow(env, s);
    expect(generateImage).toHaveBeenCalledTimes(3);
    expect(s.names.filter((n) => n.startsWith("draw"))).toHaveLength(3);
    const after = JSON.parse(String(R2.map.get(stateKey("neon", "j"))));
    expect(after.shots).toHaveLength(0);
    expect(after.done).toHaveLength(3);
  });

  it("a poll on a workflow run draws nothing and reports pending", async () => {
    const { env } = makeEnv(["shot_01"]);
    const r = await post(env, "/poll", token);
    expect(r).toEqual({ ok: true, pending: true });
    expect(generateImage).not.toHaveBeenCalled();
  });

  it("a poll after the workflow finishes returns every keyframe", async () => {
    const { env } = makeEnv(["shot_01", "shot_02"]);
    await runWorkflow(env, fakeStep());
    const r = await post(env, "/poll", token);
    expect(r.ok).toBe(true);
    expect(r.output?.keyframes.map((k) => k.shot_id)).toEqual(["shot_01", "shot_02"]);
  });

  it("a hard failure stops drawing, and the poll reports the reason", async () => {
    vi.mocked(generateImage).mockImplementation(async () => { throw new Error("provider down"); });
    const { env } = makeEnv(["shot_01", "shot_02"]);
    await runWorkflow(env, fakeStep());
    expect(generateImage).toHaveBeenCalledTimes(1);
    const r = await post(env, "/poll", token);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("provider down");
  });

  it("a rate limit holds and redraws the same shot, then finishes", async () => {
    let n = 0;
    vi.mocked(generateImage).mockImplementation(async () => {
      n += 1;
      if (n === 1) throw new Error("gateway -> 429");
      return tiny;
    });
    const { env } = makeEnv(["shot_01"]);
    const s = fakeStep();
    await runWorkflow(env, s);
    expect(s.sleeps).toHaveLength(1);
    const r = await post(env, "/poll", token);
    expect(r.output?.keyframes).toHaveLength(1);
  });

  it("a rate limit that never clears ends as a failure, not an endless run", async () => {
    vi.mocked(generateImage).mockImplementation(async () => { throw new Error("gateway -> 429"); });
    const { env } = makeEnv(["shot_01"]);
    const s = fakeStep();
    await runWorkflow(env, s);
    const r = await post(env, "/poll", token);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("rate");
  });

  it.each(["errored", "terminated"])("a poll fails when the workflow is %s with shots left", async (st) => {
    const { env } = makeEnv(["shot_01"], st);
    const r = await post(env, "/poll", token);
    expect(r.ok).toBe(false);
    expect(r.error).toContain(st);
  });

  it("a failed status read stays pending", async () => {
    const { env, KEYFRAME_WORKFLOW } = makeEnv(["shot_01"]);
    KEYFRAME_WORKFLOW.get.mockRejectedValueOnce(new Error("blip"));
    expect(await post(env, "/poll", token)).toEqual({ ok: true, pending: true });
  });

  it("cancel terminates the workflow", async () => {
    const { env, instance } = makeEnv(["shot_01"]);
    expect((await post(env, "/cancel", token)).ok).toBe(true);
    expect(instance.terminate).toHaveBeenCalledTimes(1);
  });

  it("a token from before the workflow still draws one shot per poll", async () => {
    const { env } = makeEnv(["shot_01", "shot_02"]);
    const r = await post(env, "/poll", encodePoll({ project: "neon", job_id: "j" }));
    expect(r).toEqual({ ok: true, pending: true });
    expect(generateImage).toHaveBeenCalledTimes(1);
  });

  it("the poll token keeps the workflow id", () => {
    expect(decodePoll(token)?.workflow_id).toBe("wf-1");
    expect(decodePoll(encodePoll({ project: "p", job_id: "j" }))?.workflow_id).toBeUndefined();
  });
});
