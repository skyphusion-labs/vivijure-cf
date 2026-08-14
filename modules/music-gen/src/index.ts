// music-gen: a `score` module worker (vivijure-module/2). Generates a music bed via MiniMax Music
// 2.6 through Workers AI + the AI Gateway for the music / narration / beat-sync chain.
//
// ASYNC: a MiniMax music gen is a SINGLE BLOCKING env.AI.run (no async job handle on Workers AI -- the
// model is synchronous-only) that can run minutes -- far longer than any request-path / waitUntil window
// (the runtime cancels waitUntil ~30s after the response, which left every gen hung forever, #155). So the
// gen runs inside a Cloudflare WORKFLOW step: unlimited wall time, automatic retry, and it SURVIVES a
// worker recycle. R2 presence is authoritative for completion (the audio_key artifact in R2 = done),
// exactly like the render pipeline's clips/finish reclaim.
//   GET  /module.json -> manifest
//   POST /invoke      -> validate ScoreInput, persist `running` state, START the workflow, return poll
//                       (token carries submittedAt epoch ms, same as RunPod modules)
//   POST /poll        -> R2 state authoritative: pending (with submitted_at + elapsed_ms) until the
//                       workflow writes done -> ScoreOutput; failed / terminal workflow -> ok:false
//
// Failures are DATA (ok:false), never thrown across the wire. Upstream AI Gateway errors must not
// look like a healthy slow render (#391).

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type ScoreInput,
  type ScoreOutput,
} from "./contract";
import {
  MODEL,
  BITRATES,
  SAMPLE_RATES,
  FORMATS,
  buildMusicParams,
  parseAudioUrl,
  mimeForFormat,
  encodePoll,
  decodePoll,
  resolveSubmittedAtMs,
  stateKey,
  audioKey,
  appliedTags,
  readOutput,
  normalizeConfig,
  promptFromScoreInput,
  type RunState,
  type MusicGenerateConfig,
} from "./music-gen";
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";

interface R2Bucket {
  put(key: string, value: ArrayBuffer | string, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ text(): Promise<string> } | null>;
}

interface AiRun {
  run(model: string, params: unknown, opts?: { gateway?: { id: string } }): Promise<unknown>;
}

// Minimal hand-authored shapes for the Workflow binding (mirrors the wrangler [[workflows]] entry) so we
// do not depend on the full global Workflow types in this module's narrow Env.
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
  SCORE_WORKFLOW: WorkflowBinding;
}

/** Params passed to the workflow instance: everything the gen step needs, no bindings. */
export interface WorkflowParams {
  job_id: string;
  input: ScoreInput;
  config: MusicGenerateConfig;
}

const MANIFEST: ModuleManifest = {
  name: "music-gen",
  version: "0.1.2",
  api: MODULE_API,
  hooks: ["score"],
  provides: [{ id: "minimax-music", label: "MiniMax Music 2.6 (Workers AI)" }],
  config_schema: {
    prompt: {
      type: "string",
      default: "",
      label: "music prompt (blank = derive from storyboard)",
    },
    lyrics: {
      type: "string",
      default: "",
      label: "lyrics (optional; blank uses [Instrumental] unless auto-generating)",
    },
    is_instrumental: { type: "bool", default: true, label: "instrumental (no vocals)" },
    lyrics_optimizer: { type: "bool", default: false, label: "auto-generate lyrics from prompt" },
    format: { type: "enum", values: [...FORMATS], default: "mp3", label: "audio format" },
    bitrate: {
      type: "enum",
      values: BITRATES.map(String),
      default: "128000",
      label: "bitrate",
    },
    sample_rate: {
      type: "enum",
      values: SAMPLE_RATES.map(String),
      default: "44100",
      label: "sample rate",
    },
  },
  ui: { section: "score", order: 10 },
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

/** The actual generation: blocking env.AI.run -> store audio in R2 -> write the `done` R2 state. Runs
 *  inside a Workflow step (unlimited wall, retried, survives recycle). THROWS on failure so the step
 *  retries; the workflow's run() writes the terminal `failed` state once retries are exhausted. */
async function runGeneration(
  env: Env,
  jobId: string,
  input: ScoreInput,
  config: MusicGenerateConfig,
): Promise<void> {
  const format = config.format ?? "mp3";
  const applied = appliedTags(format, config);
  const gatewayId = await secretValue(env.GATEWAY_ID);
  if (!gatewayId) throw new Error("GATEWAY_ID not configured");
  const prompt = promptFromScoreInput(input, config);
  const params = buildMusicParams(prompt, config);
  const result = await env.AI.run(MODEL, params, { gateway: { id: gatewayId } });
  const url = parseAudioUrl(result);
  if (!url) throw new Error("model completed but returned no audio URL");
  const aresp = await fetch(url);
  if (!aresp.ok) throw new Error(`audio fetch ${aresp.status}`);
  const mime = aresp.headers.get("content-type")?.split(";")[0]?.trim() || mimeForFormat(format);
  const bytes = await aresp.arrayBuffer();
  const key = audioKey(jobId, format);
  await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: mime } });
  await writeState(env, jobId, {
    status: "done",
    film_key: input.film_key,
    audio_key: key,
    mime,
    applied: [...applied, `audio:${key}`],
  });
}

/** The durable runner: a single step does the blocking gen. The step config OVERRIDES the Workflows
 *  defaults (timeout 10min, retries 5) for a long, billed AI gen: MiniMax music can run ~20min, so the
 *  10min default would time the gen out mid-flight; and 5 retries of a 20min billed call is a lot of
 *  double-spend on a transient blip, so cap retries low. step.do still survives a worker recycle. If the
 *  step ultimately fails, persist a terminal `failed` R2 state so /poll surfaces it as ok:false. */
const GENERATE_STEP_CONFIG: WorkflowStepConfig = {
  retries: { limit: 2, delay: "15 seconds", backoff: "exponential" },
  timeout: "20 minutes",
};
export class MusicGenWorkflow extends WorkflowEntrypoint<Env, WorkflowParams> {
  async run(event: WorkflowEvent<WorkflowParams>, step: WorkflowStep): Promise<void> {
    const { job_id, input, config } = event.payload;
    try {
      await step.do("generate", GENERATE_STEP_CONFIG, async () => {
        await runGeneration(this.env, job_id, input, config);
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await writeState(this.env, job_id, {
        status: "failed",
        error: msg.slice(0, 500),
        applied: appliedTags(config.format ?? "mp3", config),
      });
    }
  }
}

async function submit(
  env: Env,
  req: InvokeRequest<ScoreInput>,
): Promise<InvokeResponse<ScoreOutput>> {
  const input = req.input;
  const filmKey = typeof input?.film_key === "string" ? input.film_key.trim() : "";
  if (!filmKey) return { ok: false, error: "score: input.film_key required" };
  const gatewayId = await secretValue(env.GATEWAY_ID);
  if (!gatewayId) return { ok: false, error: "score: GATEWAY_ID not configured" };

  const config = normalizeConfig(req.config ?? {});
  const scoredInput = { ...input, film_key: filmKey };
  try {
    buildMusicParams(promptFromScoreInput(scoredInput, config), config);
  } catch (e) {
    return { ok: false, error: "score: " + (e as Error).message };
  }

  const jobId = req.context?.job_id || crypto.randomUUID();
  const applied = appliedTags(config.format ?? "mp3", config);
  // Record submit time ONCE at submit (ms), same field RunPod modules put on their poll tokens (#391).
  // Wall-clock impressions after the fact are not a clock; this is.
  const submittedAt = Date.now();

  // Start the durable workflow that does the (long, blocking) gen off the request path. No waitUntil,
  // no inline await -- the workflow owns execution and survives a recycle.
  let workflowId: string | undefined;
  try {
    const instance = await env.SCORE_WORKFLOW.create({ params: { job_id: jobId, input: scoredInput, config } });
    workflowId = instance.id;
  } catch (e) {
    return { ok: false, error: "score: could not start generation workflow: " + (e as Error).message };
  }

  try {
    await writeState(env, jobId, {
      status: "running",
      started_at: Math.floor(submittedAt / 1000),
      film_key: filmKey,
      applied,
      workflow_id: workflowId,
    });
  } catch (e) {
    return { ok: false, error: "score: could not persist run state: " + (e as Error).message };
  }

  return { ok: true, pending: true, poll: encodePoll({ job_id: jobId, submittedAt }) };
}

/** Pending poll body: always include a submit clock when one is recoverable (#391). */
function pendingPoll(token: { job_id: string; submittedAt?: number }, state: RunState | null): PollResponse<ScoreOutput> {
  const submittedAt = resolveSubmittedAtMs(token, state);
  if (submittedAt === undefined) return { ok: true, pending: true };
  return {
    ok: true,
    pending: true,
    submitted_at: submittedAt,
    elapsed_ms: Math.max(0, Date.now() - submittedAt),
  };
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<ScoreOutput>> {
  const token = decodePoll(body.poll);
  if (!token) return { ok: false, error: "score: bad poll token" };
  const state = await readState(env, token.job_id);
  if (!state) return { ok: false, error: "score: run state not found (expired or bad token)" };
  if (state.status === "done") return { ok: true, output: readOutput(state) };
  // Terminal failed R2 state is the honest surface for upstream AI Gateway / model errors (e.g.
  // AiGatewayError 2002). Never leave those looking like a healthy slow render (#391).
  if (state.status === "failed") return { ok: false, error: state.error || "generation failed" };

  // status === "running": R2 presence is the authoritative done-signal, but if the workflow itself
  // reached a terminal status without a readable done/failed write, surface that instead of
  // pending-forever (upstream AI Gateway / step failures must not look like a healthy slow render).
  if (state.workflow_id) {
    try {
      const instance = await env.SCORE_WORKFLOW.get(state.workflow_id);
      const ws = (await instance.status()).status;
      if (ws === "errored" || ws === "terminated") {
        return { ok: false, error: `generation workflow ${ws}` };
      }
      // "complete" races with the terminal R2 write on the success path: re-read once before treating
      // it as a silent-exit failure. If R2 still says running after complete, the terminal write was
      // lost and the job is stuck -- report ok:false, not pending (#391).
      if (ws === "complete") {
        const again = await readState(env, token.job_id);
        if (again?.status === "done") return { ok: true, output: readOutput(again) };
        if (again?.status === "failed") {
          return { ok: false, error: again.error || "generation failed" };
        }
        return { ok: false, error: "generation workflow complete without a result" };
      }
    } catch { /* instance not found yet / transient: keep polling */ }
  }
  return pendingPoll(token, state);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);

    // GET /ready (cf#295): credential-visibility probe (docs/module-api.md "Credential readiness").
    // GATEWAY_ID is hard-required here (see submit(): "GATEWAY_ID not configured" fails the call), so
    // its visibility is a genuine ready/not-ready signal, unlike the AI-Gateway modules where the
    // credential only routes an optional fallback. No telemetry field: this module holds no
    // runpod_job_log binding.
    if (request.method === "GET" && url.pathname === "/ready") {
      const gatewayId = await secretValue(env.GATEWAY_ID);
      return json({
        ok: Boolean(gatewayId),
        module: MANIFEST.name,
        credentials: { gateway_id: Boolean(gatewayId) },
      });
    }

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<ScoreInput>;
      try {
        req = (await request.json()) as InvokeRequest<ScoreInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as InvokeResponse);
      }
      if (req.hook !== "score") {
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
