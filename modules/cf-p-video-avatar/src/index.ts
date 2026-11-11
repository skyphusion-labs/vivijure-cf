// cf-p-video-avatar: a motion.backend module worker (vivijure-module/2).
// Cloudflare AI Gateway model `pruna/p-video-avatar`. Portrait plus Cast audio.
//
// ASYNC: env.AI.run is synchronous-only and a clip outlives a Worker request
// (#155). The gen runs in a Workflow step. R2 state is authoritative.
//   GET  /module.json
//   POST /invoke
//   POST /poll
//
// Failures are DATA (ok:false), never thrown across the wire.
//
// This door is installable. It is not a default: ui.order is after the
// existing motion doors, and spoken fallback still names infinitetalk.

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
  parseVideoUrl,
  clipTiming,
  encodePoll,
  decodePoll,
  stateKey,
  clipKey,
  normalizeConfig,
  type RunState,
} from "./params";
import { requireVideoUrl, runPaidGeneration } from "../../_shared/paid-generation";
import { failOnRefusal } from "../../_shared/gateway-log";
import { type Env, type WorkflowParams, generateClip, secretValue } from "./generate";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";

const MANIFEST: ModuleManifest = {
  name: "cf-p-video-avatar",
  version: "0.1.4",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-cloud", label: "Talking from our voice (higher resolution)" }],
  config_schema: {
    resolution: { type: "enum", values: ["720p", "1080p"], default: "720p", label: "resolution" },
  },
  ui: {
    section: "motion",
    order: 92,
    locality: "cloud",
    // cf#1246: provider cost, no markup. Source and date: docs/motion-door-prices.md.
    cost: "$0.025/s at 720p, $0.045/s at 1080p",
    cost_as_of: "2026-11-05",
    cost_usd_per_second: [0.025, 0.045],
    blurb: "Portrait plus Cast audio, at 720p or 1080p. The speaker is ours, not invented.",
    limits: [
      "Mouth follows the storyboard line in the Cast voice. A shot with no line is refused.",
      "720p or 1080p.",
      "15 seconds is this door's own cap, not the provider's, until a real long-line test.",
      "The line's trailing silence is cut to 200 ms before this door sees it (cf#957, core#464).",
      "The provider refuses a line under 1 second, so a shorter line is padded with silence to 1 second. A shot shorter than its plan is held on its last frame in assembly, which is not billed (cf#1338).",
      "Whether the picture follows the portrait's shape is unknown until a real render.",
      "A named voice is sent because the provider requires one. Whether it changes an audio-driven clip is unknown until a real render.",
    ],
  },
  usage: {
    face_hold: "hold",
    native_audio: false,
    voice: "cast_tts",
    scatter_native_audio: false,
    driving_audio: true,
    // cf#1338: the provider's own floor. pruna/p-video-avatar answered a 0.43 s line with 400 "Audio is too
    // short (0.43s). Minimum duration is 1.0s." (gateway log 01a1b266-f930-7303-baa4-1551fe9be19c, cost 0).
    // The core pads a line to this for a shot on this door only (core#464).
    driving_audio_min_seconds: 1,
    // OUR door cap, matching infinitetalk (#931). The provider page lists no duration.
    min_seconds: 1,
    max_seconds: 15,
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
  const timing = clipTiming(new Uint8Array(bytes));
  if (!timing) throw new Error("clip timing could not be read from the file");
  const key = clipKey(params.project, params.shot_id);
  await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: media.contentType } });
  await writeState(env, params.job_id, {
    status: "done",
    project: params.project,
    shot_id: params.shot_id,
    clip_key: key,
    fps: timing.fps,
    frames: timing.frames,
  });
}

const GENERATE_STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "25 minutes",
};

export class CfPVideoAvatarWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
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
  const audio = input.audio_url || "";
  if (!audio) {
    return { ok: false, error: "cf-p-video-avatar: needs Cast audio (audio_url) so the speaker stays ours", reason: "bad-input" };
  }
  const gatewayId = await secretValue(env.GATEWAY_ID);
  if (!gatewayId) return { ok: false, error: "cf-p-video-avatar: GATEWAY_ID not configured", reason: "not-configured" };

  const config = normalizeConfig(req.config ?? {});
  const project = req.context?.project || "project";
  const jobId = (req.context?.job_id || crypto.randomUUID()) + "-" + input.shot_id;

  let workflowId: string | undefined;
  try {
    const instance = await env.I2V_WORKFLOW.create({
      params: {
        job_id: jobId,
        project,
        shot_id: input.shot_id,
        input: { ...input, audio_url: audio },
        config,
      },
    });
    workflowId = instance.id;
  } catch (e) {
    return { ok: false, error: "cf-p-video-avatar: could not start generation workflow: " + (e as Error).message };
  }

  try {
    await writeState(env, jobId, {
      status: "running",
      started_at: Math.floor(Date.now() / 1000),
      project,
      shot_id: input.shot_id,
      workflow_id: workflowId,
    });
  } catch (e) {
    return { ok: false, error: "cf-p-video-avatar: could not persist run state: " + (e as Error).message };
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
  if (!token) return { ok: false, error: "cf-p-video-avatar: bad poll token" };
  const state = await readState(env, token.job_id);
  if (!state) return { ok: false, error: "cf-p-video-avatar: run state not found (expired or bad token)" };
  if (state.status === "done") {
    return {
      ok: true,
      output: {
        shot_id: state.shot_id,
        clip_key: state.clip_key,
        fps: state.fps,
        frames: state.frames,
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
