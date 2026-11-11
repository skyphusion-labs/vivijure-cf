// cf-veo: a motion.backend module worker (vivijure-module/2).
// Cloudflare AI Gateway / Unified Billing model `google/veo-3.1-fast` (i2v).
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

import { withRetryingR2 } from "../../_shared/r2-retry";
import { PROVIDER_VIDEO_MAX_BYTES, readProviderMedia, toArrayBuffer } from "../../_shared/provider-media";
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
  OUT_FPS,
  parseVideoUrl,
  clampDuration,
  encodePoll,
  decodePoll,
  stateKey,
  clipKey,
  normalizeConfig,
  type RunState, resolutionDurationError } from "./params";
import { requireVideoUrl, runPaidGeneration } from "../../_shared/paid-generation";
import { failOnRefusal } from "../../_shared/gateway-log";
import { type Env, type WorkflowParams, generateClip, secretValue } from "./generate";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";

const MANIFEST: ModuleManifest = {
  name: "cf-veo",
  version: "0.1.4",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-cloud", label: "Talking clips (Veo 3.1)" }],
  config_schema: {
    generate_audio: { type: "bool", default: true, label: "keep the model's talking audio (off: silent clip)" },
    aspect_ratio: { type: "enum", values: ["16:9", "9:16", "1:1"], default: "16:9", label: "aspect ratio" },
    // cf#932: the label is the one place the schema can say it; resolutionDurationError enforces it.
    resolution: { type: "enum", values: ["720p", "1080p"], default: "720p", label: "resolution (1080p: 8 second shots only)" },
  },
  ui: {
    section: "motion",
    order: 55,
    locality: "cloud",
    // cf#1246: provider cost, no markup. Source and date: docs/motion-door-prices.md.
    cost: "$0.10/s at 720p, $0.12/s at 1080p with its audio (silent: $0.08/s and $0.10/s)",
    cost_as_of: "2026-11-05",
    cost_usd_per_second: [0.10, 0.12],
    blurb: "Photoreal talking on Cloudflare. Only 4, 6, or 8 seconds.",
    limits: [
      "4, 6, or 8 second clips",
      "Same voice lock on every shot",
      "Cannot lock the Cast voice sample. Same description, not the same take.",
    ],
  },
  usage: {
    face_hold: "one",
    native_audio: true,
    voice: "prompt_lock",
    scatter_native_audio: false,
    min_seconds: 4,
    max_seconds: 8,
    duration_steps: [4, 6, 8],
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
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

/** Download and write. Retries on its own step, and never reaches the provider. */
async function storeClip(env: Env, params: WorkflowParams, url: string): Promise<void> {
  const vresp = await fetch(url);
  if (!vresp.ok) throw new Error("video fetch " + vresp.status);
  const media = await readProviderMedia(vresp, { maxBytes: PROVIDER_VIDEO_MAX_BYTES, fallbackType: "video/mp4" });
  const bytes = toArrayBuffer(media.bytes);
  const key = clipKey(params.project, params.shot_id);
  await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: media.contentType } });
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

export class CfVeoWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<void> {
    withRetryingR2(this.env);
    const p = event.payload;
    try {
      await runPaidGeneration(step, GENERATE_STEP_CONFIG, {
        generate: () => generateClip(this.env, p),
        parse: (raw) => {
          failOnRefusal(raw);
          return requireVideoUrl(parseVideoUrl(raw));
        },
        store: (url) => storeClip(this.env, p, url),
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
    return { ok: false, error: "motion.backend: input needs shot_id, keyframe_url, and prompt", reason: "bad-input" };
  }
  const gatewayId = await secretValue(env.GATEWAY_ID);
  if (!gatewayId) return { ok: false, error: "cf-veo: GATEWAY_ID not configured", reason: "not-configured" };

  const config = normalizeConfig(req.config ?? {});
  const seconds = clampDuration(input.seconds);
  // cf#932: refuse 1080p on a shot that is not 8 seconds, before any provider call.
  const comboError = resolutionDurationError(config, seconds);
  if (comboError) return { ok: false, error: comboError, reason: "bad-input" };
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
    return { ok: false, error: "cf-veo: could not start generation workflow: " + (e as Error).message };
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
    return { ok: false, error: "cf-veo: could not persist run state: " + (e as Error).message };
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
  if (!token) return { ok: false, error: "cf-veo: bad poll token" };
  const state = await readState(env, token.job_id);
  if (!state) return { ok: false, error: "cf-veo: run state not found (expired or bad token)" };
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
    withRetryingR2(env);
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
        return json({ ok: false, error: "invalid JSON body", reason: "bad-input" } as InvokeResponse);
      }
      if (req.hook !== "motion.backend") {
        return json({ ok: false, error: "unsupported hook " + String(req.hook), reason: "unsupported" } as InvokeResponse);
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
