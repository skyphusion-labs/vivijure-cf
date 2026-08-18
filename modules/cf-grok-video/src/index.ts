// cf-grok-video: a motion.backend module worker (vivijure-module/2).
// Cloudflare AI Gateway / Unified Billing model `xai/grok-imagine-video` (i2v).
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
import { presignR2Put } from "./r2-put";

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
  R2_S3_ACCESS_KEY_ID?: SecretsStoreSecret | string;
  R2_S3_SECRET_ACCESS_KEY?: SecretsStoreSecret | string;
  R2_S3_ENDPOINT?: string;
  R2_S3_BUCKET?: string;
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
  name: "cf-grok-video",
  version: "0.1.2",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-cloud", label: "Talking drafts (Grok)" }],
  config_schema: {
    model: {
      type: "enum",
      values: ["xai/grok-imagine-video-1.5-preview", "xai/grok-imagine-video"],
      default: "xai/grok-imagine-video-1.5-preview",
      label: "Grok video model",
    },
    resolution: { type: "enum", values: ["480p", "720p"], default: "720p", label: "resolution" },
    aspect_ratio: { type: "enum", values: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], default: "16:9", label: "aspect ratio" },
  },
  ui: {
    section: "motion",
    order: 80,
    locality: "cloud",
    cost: "Pay per render",
    blurb: "Quick talking drafts from a still. 1-15 seconds.",
    limits: [
      "1-15 second clips",
      "Same voice lock on every shot",
      "One film, no scatter",
      "Cannot lock the Cast voice sample. Same description, not the same take.",
    ],
  },
  usage: {
    native_audio: true,
    voice: "prompt_lock",
    scatter_native_audio: false,
    min_seconds: 1,
    max_seconds: 15,
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

const UPLOAD_TTL_SECONDS = 40 * 60; // workflow step timeout is 25m; leave headroom for the PUT

async function mintUploadUrl(env: Env, key: string): Promise<string> {
  const accessKeyId = await secretValue(env.R2_S3_ACCESS_KEY_ID);
  const secretAccessKey = await secretValue(env.R2_S3_SECRET_ACCESS_KEY);
  const endpoint = env.R2_S3_ENDPOINT || "";
  const bucket = env.R2_S3_BUCKET || "";
  if (!accessKeyId || !secretAccessKey || !endpoint || !bucket) {
    throw new Error("cf-grok-video: ZDR upload needs R2_S3_ACCESS_KEY_ID, R2_S3_SECRET_ACCESS_KEY, R2_S3_ENDPOINT, R2_S3_BUCKET");
  }
  if (endpoint.includes("${") || bucket.includes("${") || endpoint.startsWith("REPLACE_WITH_")) {
    throw new Error("cf-grok-video: R2_S3_ENDPOINT/BUCKET look unfilled (deploy did not substitute the identifiers)");
  }
  try {
    const u = new URL(endpoint);
    if (u.protocol !== "https:") throw new Error("not https");
  } catch {
    throw new Error("cf-grok-video: R2_S3_ENDPOINT is not a valid https URL");
  }
  return presignR2Put({ accessKeyId, secretAccessKey, endpoint, bucket, key, expiresSeconds: UPLOAD_TTL_SECONDS });
}

/** Blocking env.AI.run. ZDR teams get no xAI-hosted URL; they PUT to output.upload_url. */
async function runGeneration(env: Env, params: WorkflowParams): Promise<void> {
  const gatewayId = await secretValue(env.GATEWAY_ID);
  if (!gatewayId) throw new Error("GATEWAY_ID not configured");
  const key = clipKey(params.project, params.shot_id);
  const uploadUrl = await mintUploadUrl(env, key);
  const modelParams = buildParams(params.input, params.config, uploadUrl);
  const result = await env.AI.run(params.config.model || MODEL, modelParams, { gateway: { id: gatewayId } });

  const existing = await env.R2_RENDERS.get(key);
  if (existing) {
    await writeState(env, params.job_id, {
      status: "done",
      project: params.project,
      shot_id: params.shot_id,
      seconds: params.seconds,
      clip_key: key,
      has_audio: true,
    });
    return;
  }

  // Non-ZDR fallback: xAI still hosted a URL.
  const url = parseVideoUrl(result);
  if (!url) throw new Error("model completed but wrote no object to upload_url and returned no video URL");
  const vresp = await fetch(url);
  if (!vresp.ok) throw new Error("video fetch " + vresp.status);
  const bytes = await vresp.arrayBuffer();
  await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: "video/mp4" } });
  await writeState(env, params.job_id, {
    status: "done",
    project: params.project,
    shot_id: params.shot_id,
    seconds: params.seconds,
    clip_key: key,
    has_audio: true,
  });
}

const GENERATE_STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "25 minutes",
};

export class CfGrokVideoWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
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
  if (!gatewayId) return { ok: false, error: "cf-grok-video: GATEWAY_ID not configured" };

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
    return { ok: false, error: "cf-grok-video: could not start generation workflow: " + (e as Error).message };
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
    return { ok: false, error: "cf-grok-video: could not persist run state: " + (e as Error).message };
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
  if (!token) return { ok: false, error: "cf-grok-video: bad poll token" };
  const state = await readState(env, token.job_id);
  if (!state) return { ok: false, error: "cf-grok-video: run state not found (expired or bad token)" };
  if (state.status === "done") {
    return {
      ok: true,
      output: {
        shot_id: state.shot_id,
        clip_key: state.clip_key,
        fps: OUT_FPS,
        frames: state.seconds * OUT_FPS,
        has_audio: true,
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
