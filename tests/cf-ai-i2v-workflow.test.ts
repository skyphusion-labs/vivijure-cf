// Regression for #155 on the CF AI i2v motion backends: gen runs in a Workflow, never waitUntil
// or request-path env.AI.run. One suite covers all four modules (same shell).
import { describe, it, expect } from "vitest";

import hh1 from "../modules/cf-hh1-r2v/src/index";
import seedance from "../modules/cf-seedance/src/index";
import grok from "../modules/cf-grok-video/src/index";
import flux from "../modules/cf-flux-3-video/src/index";

type Worker = {
  fetch(request: Request, env: never, ctx: never): Promise<Response>;
};

const WORKERS: { name: string; worker: Worker; statePrefix: string }[] = [
  { name: "cf-hh1-r2v", worker: hh1 as unknown as Worker, statePrefix: "cf-hh1-r2v" },
  { name: "cf-seedance", worker: seedance as unknown as Worker, statePrefix: "cf-seedance" },
  { name: "cf-grok-video", worker: grok as unknown as Worker, statePrefix: "cf-grok-video" },
  { name: "cf-flux-3-video", worker: flux as unknown as Worker, statePrefix: "cf-flux-3-video" },
];

function fakeEnv(opts: { workflowStatus?: string; createThrows?: boolean } = {}) {
  const store = new Map<string, string | ArrayBuffer>();
  const created: Array<{ params?: unknown }> = [];
  const env = {
    GATEWAY_ID: "gw",
    AI: { async run() { throw new Error("AI.run must NOT be called from the request path"); } },
    R2_RENDERS: {
      async put(key: string, value: string | ArrayBuffer) { store.set(key, value); },
      async get(key: string) {
        const o = store.get(key);
        if (o === undefined) return null;
        return {
          async text() { return typeof o === "string" ? o : ""; },
          async arrayBuffer() { return typeof o === "string" ? new TextEncoder().encode(o).buffer : o; },
        };
      },
    },
    I2V_WORKFLOW: {
      async create(options?: { params?: unknown }) {
        if (opts.createThrows) throw new Error("workflow create failed");
        created.push(options ?? {});
        return { id: "wf-1", async status() { return { status: opts.workflowStatus ?? "running" }; } };
      },
      async get(_id: string) {
        return { id: "wf-1", async status() { return { status: opts.workflowStatus ?? "running" }; } };
      },
    },
  };
  return { env, store, created };
}

function invokeBody() {
  return {
    hook: "motion.backend",
    input: {
      shot_id: "shot_01",
      keyframe_url: "https://r2.example/k.png",
      prompt: "gentle motion",
      seconds: 5,
    },
    config: {},
    context: { project: "demo", job_id: "job-1" },
  };
}

function req(path: string, body: unknown): Request {
  return new Request("https://module" + path, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

const ctx = {
  waitUntil() { throw new Error("waitUntil must NOT be used (#155)"); },
  passThroughOnException() {},
};

describe.each(WORKERS)("$name: Workflow async shell (#155)", ({ name, worker, statePrefix }) => {
  it("invoke starts the workflow and returns a poll token (no waitUntil, no AI.run)", async () => {
    const { env, created } = fakeEnv();
    const resp = await worker.fetch(req("/invoke", invokeBody()), env as never, ctx as never);
    const j = await resp.json() as { ok: boolean; pending?: boolean; poll?: string; jobId?: string };
    expect(j.ok).toBe(true);
    expect(j.pending).toBe(true);
    expect(typeof j.poll).toBe("string");
    expect(typeof j.jobId).toBe("string");
    expect(created.length).toBe(1);
    const params = created[0].params as { input: { shot_id: string }; project: string };
    expect(params.input.shot_id).toBe("shot_01");
    expect(params.project).toBe("demo");
  });

  it("poll returns pending while the workflow runs", async () => {
    const { env } = fakeEnv({ workflowStatus: "running" });
    const inv = await worker.fetch(req("/invoke", invokeBody()), env as never, ctx as never);
    const poll = (await inv.json() as { poll: string }).poll;
    const out = await worker.fetch(req("/poll", { poll }), env as never, ctx as never);
    const j = await out.json() as { ok: boolean; pending?: boolean };
    expect(j.ok).toBe(true);
    expect(j.pending).toBe(true);
  });

  it("poll returns MotionBackendOutput once R2 done state is written", async () => {
    const { env } = fakeEnv();
    const inv = await worker.fetch(req("/invoke", invokeBody()), env as never, ctx as never);
    const poll = (await inv.json() as { poll: string }).poll;
    const jobId = JSON.parse(atob(poll)).job_id as string;
    await env.R2_RENDERS.put(`${statePrefix}/${jobId}.state.json`, JSON.stringify({
      status: "done",
      project: "demo",
      shot_id: "shot_01",
      seconds: 5,
      clip_key: `renders/demo/clips/shot_01_${name}.mp4`,
    }));
    const out = await worker.fetch(req("/poll", { poll }), env as never, ctx as never);
    const j = await out.json() as { ok: boolean; output?: { shot_id: string; clip_key: string; fps: number; frames: number } };
    expect(j.ok).toBe(true);
    expect(j.output).toMatchObject({ shot_id: "shot_01", fps: 24, frames: 120 });
    expect(j.output?.clip_key).toContain("shot_01");
  });

  it("poll surfaces an errored workflow as ok:false", async () => {
    const { env } = fakeEnv({ workflowStatus: "errored" });
    const inv = await worker.fetch(req("/invoke", invokeBody()), env as never, ctx as never);
    const poll = (await inv.json() as { poll: string }).poll;
    const out = await worker.fetch(req("/poll", { poll }), env as never, ctx as never);
    const j = await out.json() as { ok: boolean; error?: string };
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/errored/);
  });

  it("invoke surfaces workflow-create failure as ok:false", async () => {
    const { env } = fakeEnv({ createThrows: true });
    const resp = await worker.fetch(req("/invoke", invokeBody()), env as never, ctx as never);
    const j = await resp.json() as { ok: boolean; error?: string };
    expect(j.ok).toBe(false);
    expect(j.error).toMatch(/workflow/i);
  });

  it("GET /module.json names the module and motion.backend hook", async () => {
    const res = await worker.fetch(
      new Request("https://module/module.json"),
      { GATEWAY_ID: "gw" } as never,
      ctx as never,
    );
    const m = await res.json() as { name: string; hooks: string[]; provides: { id: string }[] };
    expect(m.name).toBe(name);
    expect(m.hooks).toEqual(["motion.backend"]);
    expect(m.provides[0].id).toBe("i2v-cloud");
  });
});
