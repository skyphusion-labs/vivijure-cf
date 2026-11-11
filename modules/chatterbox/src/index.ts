// chatterbox: a `dialogue` module worker (vivijure-module/2). Voices each speaking shot's line with
// the RunPod public `chatterbox-turbo` endpoint, in the cast member's assigned voice, and writes one WAV
// per shot to R2. The core attaches each audio_key to that shot's FinishInput; since cf#783 removed
// finish-lipsync no finish module consumes it, and it reaches the film through the
// mouth from it -- the "talking characters" pipeline's audio stage.
//
// ASYNC: a line is one `/runsync` job. A whole film's worth of lines far exceeds any request-path /
// waitUntil window (the runtime cancels waitUntil ~30s after the response, #155). So the batch runs
// inside a Cloudflare WORKFLOW: per shot, one submit step, then (only if the provider is still queueing)
// one status step per poll by job id, then one store step. Each is checkpointed, so a recycle or a retry
// never submits a line twice (cf#1164).
// R2 presence of the done state is authoritative for completion, like the render pipeline.
//   GET  /module.json -> manifest
//   POST /invoke      -> validate DialogueInput, persist `running`, START the workflow, return poll
//   POST /poll        -> R2 state authoritative: pending until the workflow writes done -> DialogueOutput
//
// Failures are DATA (ok:false), never thrown across the wire.

import { trimTrailingSilence } from "../../_shared/wav-pcm";
import { PROVIDER_AUDIO_MAX_BYTES, readProviderMedia, toArrayBuffer } from "../../_shared/provider-media";
import { withRetryingR2 } from "../../_shared/r2-retry";
import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type DialogueInput,
  type DialogueOutput,
  type DialogueShotAudio,
} from "./contract";
import {
  MODEL,
  AUDIO_MIME,
  buildTtsParams,
  encodePoll,
  decodePoll,
  stateKey,
  audioKey,
  readJobReply,
  LINE_POLL_DELAY,
  LINE_MAX_POLLS,
  type LineProgress,
  appliedTags,
  readOutput,
  normalizeInput,
  type RunState,
  type NormalizedLine,
} from "./chatterbox";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { NOT_STORED_AUDIO_ERROR, storePaidResult } from "../../_shared/paid-generation";
import { runpodRoute, runpodEndpointUrl, runpodHeaders, runpodCredentialName, planeRefusalReason, planeRefusalError } from "../../_shared/runpod-route";

interface R2Bucket {
  put(key: string, value: ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

// Minimal hand-authored shapes for the Workflow binding (mirrors the wrangler [[workflows]] entry).
interface WorkflowInstance {
  id: string;
  status(): Promise<{ status: string }>;
}
interface WorkflowBinding {
  create(options?: { id?: string; params?: WorkflowParams }): Promise<WorkflowInstance>;
  get(id: string): Promise<WorkflowInstance>;
}

interface Env {
  RUNPOD_API_KEY: SecretsStoreSecret;
  RUNPOD_PROXY_BASE?: string;
  RUNPOD_PROXY_TOKEN?: SecretsStoreSecret | string;
  R2_RENDERS: R2Bucket;
  CHATTERBOX_WORKFLOW: WorkflowBinding;
}

/** Params passed to the workflow instance: everything the synth steps need, no bindings. */
export interface WorkflowParams {
  job_id: string;
  project: string;
  lines: NormalizedLine[];
}

const MANIFEST: ModuleManifest = {
  name: "chatterbox",
  version: "0.1.3",
  api: MODULE_API,
  hooks: ["dialogue"],
  provides: [{ id: "chatterbox", label: "Cast voices (Chatterbox Turbo)" }],
  // No user-facing knobs: the voice is the speaking cast member's assigned voice_id (resolved by the
  // core), and the line is the shot's dialogue. Both are authored upstream, not module config.
  ui: { section: "dialogue", icon: "mic", order: 10 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Resolve a Secrets Store binding (production) or a plain string (tests / local dev) to its value.
 *  Returns "" if unset/unreadable so the existing "not configured" guards still fire. */
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

async function readBody(r: Response): Promise<unknown> {
  try {
    return await r.json();
  } catch {
    return null;
  }
}

/** Submit ONE line. A reply that names a job (done, queued, or failed) is RETURNED, so the step checkpoints
 *  it and a retry can never buy the line again. Only a request that reached no job throws, so the step may
 *  retry it: nothing was queued, so nothing is bought twice and nothing is left behind. */
async function submitLine(env: Env, line: NormalizedLine): Promise<LineProgress> {
  const route = await runpodRoute(env);
  if (!route.credential) throw new Error(runpodCredentialName(route) + " not configured");
  const r = await fetch(runpodEndpointUrl(route, MODEL) + "/runsync", {
    method: "POST",
    headers: { ...runpodHeaders(route, "chatterbox"), "content-type": "application/json" },
    body: JSON.stringify({ input: buildTtsParams(line.text, line.voice) }),
  });
  const refusal = planeRefusalReason(route, r);
  if (refusal) throw new Error(planeRefusalError(MANIFEST.name, refusal));
  const body = await readBody(r);
  const progress = readJobReply(r.status, body);
  if (progress) return progress;
  throw new Error("chatterbox /runsync -> " + r.status + " with no job status");
}

/** Read a queued line's job once. Never throws: a blip on the status read is one more pending poll, and
 *  the poll budget bounds it. A reply that names a terminal state ends the wait. */
async function pollLine(env: Env, id: string, last: string): Promise<LineProgress> {
  try {
    const route = await runpodRoute(env);
    const r = await fetch(runpodEndpointUrl(route, MODEL) + "/status/" + encodeURIComponent(id), {
      headers: runpodHeaders(route, "chatterbox"),
    });
    const refusal = planeRefusalReason(route, r);
    if (refusal) return { kind: "failed", error: planeRefusalError(MANIFEST.name, refusal) };
    const progress = readJobReply(r.status, await readBody(r));
    return progress ?? { kind: "pending", id, status: last + " (status read HTTP " + r.status + ")" };
  } catch (e) {
    return { kind: "pending", id, status: last + " (status read failed: " + (e as Error).message + ")" };
  }
}

/** Cancel a job we stop waiting for, so it does not run (and bill) after the film has given up on it. */
async function cancelLine(env: Env, id: string): Promise<string> {
  try {
    const route = await runpodRoute(env);
    const r = await fetch(runpodEndpointUrl(route, MODEL) + "/cancel/" + encodeURIComponent(id), {
      method: "POST",
      headers: runpodHeaders(route, "chatterbox"),
    });
    return r.ok ? "cancelled" : "cancel -> HTTP " + r.status;
  } catch (e) {
    return "cancel failed: " + (e as Error).message;
  }
}

/** Structural, so a test can drive the real class with a fake. Mirrors WorkflowStep's do + sleep. */
interface LineSteps {
  do<T>(name: string, config: WorkflowStepConfig, fn: () => Promise<T>): Promise<T>;
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
}

/** One line, to its audio URL: submit once, then poll the same job by id until it ends or the budget runs
 *  out. A give-up cancels the job and says what state it was stuck in, with the provider's own error. */
async function awaitLine(env: Env, steps: LineSteps, line: NormalizedLine): Promise<string> {
  let progress = await steps.do(`synth:${line.shot_id}`, SYNTH_STEP_CONFIG, () => submitLine(env, line));
  for (let i = 1; progress.kind === "pending"; i++) {
    if (i > LINE_MAX_POLLS) {
      const { id, status } = progress;
      const cancel = await steps.do(`cancel:${line.shot_id}`, CANCEL_STEP_CONFIG, () => cancelLine(env, id));
      throw new Error(`chatterbox job ${id} for ${line.shot_id} still ${status} after ${LINE_MAX_POLLS} polls (${cancel})`);
    }
    await steps.sleep(`wait:${line.shot_id}:${i}`, LINE_POLL_DELAY);
    const { id, status } = progress;
    progress = await steps.do(`status:${line.shot_id}:${i}`, POLL_STEP_CONFIG, () => pollLine(env, id, status));
  }
  if (progress.kind === "failed") throw new Error(progress.error);
  return progress.url;
}

/** Download the bought line and write it. Never reaches the provider (cf#1107). */
async function storeLine(env: Env, project: string, line: NormalizedLine, url: string): Promise<DialogueShotAudio> {
  const audio = await fetch(url);
  if (!audio.ok) throw new Error("fetch chatterbox audio -> " + audio.status);
  const media = await readProviderMedia(audio, { maxBytes: PROVIDER_AUDIO_MAX_BYTES, fallbackType: AUDIO_MIME });
  const bytes = toArrayBuffer(media.bytes);
  if (bytes.byteLength === 0) throw new Error(`empty audio for ${line.shot_id}`);
  const key = audioKey(project, line.shot_id);
  // cf#957: cut trailing silence here, at the producer, so no door bills or animates it. A file that is
  // not 16-bit PCM WAV is stored as bought.
  const trim = trimTrailingSilence(new Uint8Array(bytes));
  const body = trim ? copyToArrayBuffer(trim.bytes) : bytes;
  await env.R2_RENDERS.put(key, body, {
    httpMetadata: { contentType: media.contentType },
    ...(trim ? { customMetadata: { tail_trimmed_s: trim.tail_trimmed_s.toFixed(3) } } : {}),
  });
  return { shot_id: line.shot_id, audio_key: key, voice_id: line.voice, ...(trim ? { duration_s: trim.seconds } : {}) };
}

function copyToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

/** Per-shot step config. A single short line synth is fast; a generous timeout + a couple of retries
 *  absorbs a transient gateway blip without much double-spend (TTS is cheap vs the music model). */
const SYNTH_STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 3, delay: "5 seconds", backoff: "exponential" },
  timeout: "2 minutes",
};

/** A status read never throws (pollLine), so its retries only cover a step the runtime itself lost. */
const POLL_STEP_CONFIG: WorkflowStepConfig = { retries: { limit: 1, delay: "5 seconds" }, timeout: "1 minute" };
const CANCEL_STEP_CONFIG: WorkflowStepConfig = { retries: { limit: 0, delay: "1 second" }, timeout: "1 minute" };

export class ChatterboxWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<void> {
    withRetryingR2(this.env);
    const { job_id, project, lines } = event.payload;
    try {
      const audio: DialogueShotAudio[] = [];
      for (const line of lines) {
        // One step per shot: each is independently retried + checkpointed, so a recycle or a single
        // shot's transient failure never re-bills the lines already synthesized.
        const url = await awaitLine(this.env, step as unknown as LineSteps, line);
        const shot = await storePaidResult(step, () => storeLine(this.env, project, line, url), {
          storeStep: `store:${line.shot_id}`,
          notStoredError: NOT_STORED_AUDIO_ERROR,
        });
        audio.push(shot);
      }
      await writeState(this.env, job_id, { status: "done", project, audio, applied: appliedTags(audio) });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await writeState(this.env, job_id, { status: "failed", error: msg.slice(0, 500) });
    }
  }
}

async function submit(env: Env, req: InvokeRequest<DialogueInput>): Promise<InvokeResponse<DialogueOutput>> {
  const norm = normalizeInput(req.input);
  if (!norm.ok) return { ok: false, error: "dialogue: " + norm.error, reason: "bad-input" };
  const route = await runpodRoute(env);
  if (!route.credential) return { ok: false, error: "chatterbox: " + runpodCredentialName(route) + " not configured", reason: "not-configured" };

  // No lines with anything to say: a film with no dialogue. Return an empty result immediately rather
  // than spinning up a workflow that does nothing.
  if (norm.lines.length === 0) {
    return { ok: true, output: { project: norm.project, audio: [], applied: appliedTags([]) } };
  }

  const jobId = req.context?.job_id || crypto.randomUUID();
  let workflowId: string | undefined;
  try {
    const instance = await env.CHATTERBOX_WORKFLOW.create({
      params: { job_id: jobId, project: norm.project, lines: norm.lines },
    });
    workflowId = instance.id;
  } catch (e) {
    return { ok: false, error: "dialogue: could not start generation workflow: " + (e as Error).message };
  }

  try {
    await writeState(env, jobId, {
      status: "running",
      started_at: Math.floor(Date.now() / 1000),
      project: norm.project,
      workflow_id: workflowId,
    });
  } catch (e) {
    return { ok: false, error: "dialogue: could not persist run state: " + (e as Error).message };
  }

  return { ok: true, pending: true, poll: encodePoll({ job_id: jobId }) };
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<DialogueOutput>> {
  const token = decodePoll(body.poll);
  if (!token) return { ok: false, error: "dialogue: bad poll token" };
  const state = await readState(env, token.job_id);
  if (!state) return { ok: false, error: "dialogue: run state not found (expired or bad token)" };
  if (state.status === "done") return { ok: true, output: readOutput(state) };
  if (state.status === "failed") return { ok: false, error: state.error || "dialogue generation failed" };

  // running: R2 presence is the authoritative done-signal, but if the workflow errored/terminated
  // without writing a terminal state, surface that instead of pending-forever (#155).
  if (state.workflow_id) {
    try {
      const instance = await env.CHATTERBOX_WORKFLOW.get(state.workflow_id);
      const ws = (await instance.status()).status;
      if (ws === "errored" || ws === "terminated") {
        return { ok: false, error: `dialogue generation workflow ${ws}` };
      }
    } catch { /* instance not found yet / transient: keep polling */ }
  }
  return { ok: true, pending: true };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    withRetryingR2(env);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);

    // GET /ready (cf#295): credential-visibility probe (docs/module-api.md "Credential readiness").
    // The RunPod credential is hard-required (submit() fails the call without it), so its visibility is a
    // genuine ready/not-ready signal. No telemetry field: this module holds no
    // runpod_job_log binding.
    if (request.method === "GET" && url.pathname === "/ready") {
      const route = await runpodRoute(env);
      return json({
        ok: Boolean(route.credential),
        module: MANIFEST.name,
        credentials: { runpod_api_key: Boolean(route.credential) },
        runpod_proxied: route.proxied,
      });
    }

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<DialogueInput>;
      try {
        req = (await request.json()) as InvokeRequest<DialogueInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body", reason: "bad-input" } as InvokeResponse);
      }
      if (req.hook !== "dialogue") {
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
