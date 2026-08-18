// cf-wan-27: a motion.backend module worker (vivijure-module/2).
// Cloudflare AI Gateway / Unified Billing model `alibaba/wan-2.7-i2v` (i2v).
//
// ASYNC vs RunPod: RunPod POST /run returns a job id immediately and /status polls a remote
// queue. CF env.AI.run is SYNCHRONOUS-only (no job handle) and video gens run minutes -- far
// longer than a Worker request or waitUntil (~30s cancel, #155). So the gen runs inside a
// Cloudflare WORKFLOW step (unlimited wall, retried, survives recycle). R2 state is
// authoritative for completion (clip_key present = done), same discipline as music-gen.
//   GET  /module.json -> manifest
//   POST /invoke      -> validate MotionBackendInput, start workflow, return poll token
//   POST /poll        -> R2 state authoritative until done -> MotionBackendOutput
//
// Failures are DATA (ok:false), never thrown across the wire.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type MotionBackendInput,
  type MotionBackendOutput,
} from "./contract";
import {
  MODEL,
  OUT_FPS,
  buildParams,
  parseVideoUrl,
  clampDuration,
  encodePoll,
  decodePoll,
  stateKey,
  clipKey,
  normalizeConfig,
  type RunState,
  type ModuleConfig,
} from "./params";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";

interface R2Bucket {
  put(key: string, value: ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string>; arrayBuffer(): Promise<ArrayBuffer> } | null>;
}

interface AiRun {
  run(model: string, params: unknown, opts?: { gateway?: { id: string } }): Promise<unknown>;
}

interface WorkflowInstance {
  id: string;
  status(): Promise<{ status: string }>;
}
interface WorkflowBinding {
  create(options?: { id?: string; params?: WorkflowParams }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
}

interface Env {
  AI: AiRun;
  GATEWAY_ID: SecretsStoreSecret;
  R2_RENDERS: R2Bucket;
  I2V_WORKFLOW: WorkflowBinding;
}

export interface WorkflowParams {
  job_id: string;
  project: string;
  shot_id: string;
  seconds: number;
  input: MotionBackendInput;
  config: ModuleConfig;
}

const MANIFEST: ModuleManifest = {
  name: "cf-wan-27",
  version: "0.1.3",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-cloud", label: "Talking (Wan 2.7)" }],
  config_schema: {
    resolution: { type: "enum", values: ["720P", "1080P"], default: "720P", label: "resolution" },
    ratio: { type: "enum", values: ["16:9", "9:16", "3:4", "4:3", "1:1", "21:9", "9:21", "5:4", "4:5"], default: "16:9", label: "aspect ratio" },
    seed: { type: "int", default: -1, min: -1, label: "seed (-1 = random)" },
    watermark: { type: "bool", default: false, label: "watermark" },
  },
  ui: {
    section: "motion",
    order: 60,
    locality: "cloud",
    cost: "Pay per render",
    blurb: "Wan 2.7 stills-to-clip. Alibaba lip-sync via driving_audio when a Cast sample exists. Invents speech if not.",
    limits: [
      "2-15 second clips",
      "Talks. Sends Alibaba media[] (first_frame, last_frame, driving_audio).",
      "Without driving_audio it invents speech. With a Cast sample it lip-syncs if CF forwards the field.",
      "One film, no scatter",
    ],
  },
  usage: {
    native_audio: true,
    voice: "prompt_lock",
    scatter_native_audio: false,
    min_seconds: 2,
    max_seconds: 15,
    first_last: true,
    seed: true,
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function secretValue(s: SecretsStoreSecret | string | undefined): Promise<string> {
  if (typeof s === "string") return s;
  if (!s) return "";
  try {
    return await s.get();
  } catch (e) {
    console.warn("secrets-store get failed: " + (e as Error).message);
    return "";
  }
}

async function writeState(env: Env, jobId: string, state: RunState): Promise<void> {
  await env.R2_RENDERS.put(stateKey(jobId), JSON.stringify(state), {
    httpMetadata: { contentType: "application/json" },
  });
}

async function readState(env: Env, jobId: string): Promise<RunState | null> {
  const obj = await env.R2_RENDERS.get(stateKey(jobId));
  if (!obj) return null;
  try {
    return JSON.parse(await obj.text()) as RunState;
  } catch {
    return null;
  }
}

/** Blocking env.AI.run -> download video -> R2 clip + done state. Runs inside a Workflow step. */
async function runGeneration(env: Env, params: WorkflowParams): Promise<void> {
  const gatewayId = await secretValue(env.GATEWAY_ID);
  if (!gatewayId) throw new Error("GATEWAY_ID not configured");
  const modelParams = buildParams(params.input, params.config);
  const media = Array.isArray(modelParams.media) ? modelParams.media as { type: string }[] : [];
  console.warn("cf-wan-27 alibaba media types: " + (media.map((m) => m.type).join(",") || "none"));
  const result = await env.AI.run(MODEL, modelParams, { gateway: { id: gatewayId } });
  const url = parseVideoUrl(result);
  if (!url) throw new Error("model completed but returned no video URL");
  const vresp = await fetch(url);
  if (!vresp.ok) throw new Error("video fetch " + vresp.status);
  const bytes = await vresp.arrayBuffer();
  const key = clipKey(params.project, params.shot_id);
  await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: "video/mp4" } });
  await writeState(env, params.job_id, {
    status: "done",
    project: params.project,
    shot_id: params.shot_id,
    seconds: params.seconds,
    clip_key: key,
  });
}

const GENERATE_STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "25 minutes",
};

export class CfWan27Workflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<void> {
    const p = event.payload;
    try {
      await step.do("generate", GENERATE_STEP_CONFIG, async () => {
        await runGeneration(this.env, p);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await writeState(this.env, p.job_id, {
        status: "failed",
        error: msg.slice(0, 500),
      });
    }
  }
}

async function submit(
  env: Env,
  req: InvokeRequest<MotionBackendInput>,
): Promise<InvokeResponse<MotionBackendOutput>> {
  const input = req.input;
  if (!input || !input.keyframe_url || !input.prompt || !input.shot_id) {
    return { ok: false, error: "motion.backend: input needs shot_id, keyframe_url, and prompt" };
  }
  const gatewayId = await secretValue(env.GATEWAY_ID);
  if (!gatewayId) return { ok: false, error: "cf-wan-27: GATEWAY_ID not configured" };

  const config = normalizeConfig(req.config ?? {});
  const seconds = clampDuration(input.seconds);
  const project = req.context?.project || "project";
  const jobId = (req.context?.job_id || crypto.randomUUID()) + "-" + input.shot_id;

  let workflowId: string | undefined;
  try {
    const instance = await env.I2V_WORKFLOW.create({
      params: {
        job_id: jobId,
        project,
        shot_id: input.shot_id,
        seconds,
        input: { ...input, seconds },
        config,
      },
    });
    workflowId = instance.id;
  } catch (e) {
    return { ok: false, error: "cf-wan-27: could not start generation workflow: " + (e as Error).message };
  }

  try {
    await writeState(env, jobId, {
      status: "running",
      started_at: Math.floor(Date.now() / 1000),
      project,
      shot_id: input.shot_id,
      seconds,
      workflow_id: workflowId,
    });
  } catch (e) {
    return { ok: false, error: "cf-wan-27: could not persist run state: " + (e as Error).message };
  }

  return {
    ok: true,
    pending: true,
    poll: encodePoll({ job_id: jobId }),
    jobId,
  };
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<MotionBackendOutput>> {
  const token = decodePoll(body.poll);
  if (!token) return { ok: false, error: "cf-wan-27: bad poll token" };
  const state = await readState(env, token.job_id);
  if (!state) return { ok: false, error: "cf-wan-27: run state not found (expired or bad token)" };
  if (state.status === "done") {
    return {
      ok: true,
      output: {
        shot_id: state.shot_id,
        clip_key: state.clip_key,
        fps: OUT_FPS,
        frames: state.seconds * OUT_FPS,
      },
    };
  }
  if (state.status === "failed") return { ok: false, error: state.error || "generation failed" };

  if (state.workflow_id) {
    try {
      const instance = await env.I2V_WORKFLOW.get(state.workflow_id);
      const ws = (await instance.status()).status;
      if (ws === "errored" || ws === "terminated") {
        return { ok: false, error: "generation workflow " + ws };
      }
    } catch { /* keep polling */ }
  }
  return { ok: true, pending: true };
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);

    if (request.method === "GET" && url.pathname === "/ready") {
      const gatewayId = await secretValue(env.GATEWAY_ID);
      return json({
        ok: Boolean(gatewayId),
        module: MANIFEST.name,
        credentials: { gateway_id: Boolean(gatewayId) },
      });
    }

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<MotionBackendInput>;
      try {
        req = (await request.json()) as InvokeRequest<MotionBackendInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as InvokeResponse);
      }
      if (req.hook !== "motion.backend") {
        return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
      }
      return json(await submit(env, req));
    }

    if (request.method === "POST" && url.pathname === "/poll") {
      let body: PollRequest;
      try {
        body = (await request.json()) as PollRequest;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as PollResponse);
      }
      if (!body || typeof body.poll !== "string") {
        return json({ ok: false, error: "poll token required" } as PollResponse);
      }
      return json(await poll(env, body));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
