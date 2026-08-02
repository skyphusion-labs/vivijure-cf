// narration-gen: a `score` module worker (vivijure-module/2). Synthesizes narration via MiniMax
// Speech 02 HD on RunPod's hosted endpoint, using the SAME async submit+poll transport as seedance/kling.
//
// ASYNC: a synth takes tens of seconds, longer than a Worker request can hold, so (NOT Workers AI /
// ctx.waitUntil, which the runtime cancels ~30s after the response -> pending forever, #155):
//   GET  /module.json -> manifest
//   POST /invoke      -> submit the RunPod job, return { ok, pending, poll } IMMEDIATELY (no blocking)
//   POST /poll        -> { poll } -> check the job; finalize (download + store to R2) on COMPLETED
// Each /poll is fast (a status check; only the final one downloads), so nothing holds a multi-minute
// request, and the durable poll (runpodJobGone + grace, #141) survives a worker recycle.
//
// Failures are DATA (ok:false), never thrown across the wire. Muxing onto the film is video-finish's job.

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
  DEFAULT_VOICE,
  EMOTIONS,
  SAMPLE_RATES,
  FORMATS,
  buildSpeechBody,
  extractAudioUrl,
  mimeForFormat,
  encodePoll,
  decodePoll,
  audioKey,
  appliedTags,
  normalizeConfig,
  textFromScoreInput,
  runpodJobGone,
  classifyGoneState, workersStillCold, terminalErrorInOutput, RUNPOD_COLD_GRACE_MS,
} from "./narration-gen";

import { recordRunpodJob, probeRunpodJobLog, parseRunpodErrorType, runpodWalkedPastOutcome } from "../../_shared/runpod-job-log";

interface R2Bucket {
  put(key: string, value: ArrayBuffer, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
}

interface Env {
  RUNPOD_API_KEY: SecretsStoreSecret;
  R2_RENDERS: R2Bucket;
  /** cf#279 job log, cf#305. OPTIONAL: a module deployed without it still works, and its
   *  absence warns rather than reading as a clean run (modules/_shared/runpod-job-log.ts). */
  TELEMETRY_DB?: D1Database;
}

const ENDPOINT = "https://api.runpod.ai/v2/" + MODEL;

const MANIFEST: ModuleManifest = {
  name: "narration-gen",
  version: "0.2.1",
  api: MODULE_API,
  hooks: ["score"],
  // Tier-honest identity + knob labels (cf#211): this manifest is canonical + drift-locked (synced
  // into vivijure-local/dev/manifests/ by scripts/sync-module-manifests.ts, checked by
  // check-module-manifest-drift.sh), so it has to read true on BOTH panels. Hosted (vivijure-cf)
  // always has RUNPOD_API_KEY configured, so MiniMax HD is the tier that actually runs here; the
  // local panel's default install has no RunPod (local#202) and instead runs Deepgram Aura-1 on CF
  // AI, with MiniMax HD as the opt-in high-fidelity tier when RUNPOD_API_KEY is set. The label below
  // names both tiers rather than asserting the RunPod one is universal; local's runtime /module.json
  // override (narrationManifestView, same string) becomes a same-value no-op once this ships.
  provides: [{ id: "minimax-speech", label: "Narration (Deepgram Aura on Cloudflare; MiniMax HD with RunPod)" }],
  config_schema: {
    text: {
      type: "string",
      default: "",
      label: "narration script (blank = derive from storyboard)",
    },
    voice_id: {
      type: "string",
      default: DEFAULT_VOICE,
      label: "voice id",
    },
    emotion: {
      type: "enum",
      values: [...EMOTIONS],
      default: "neutral",
      label: "emotion (MiniMax HD only)",
    },
    format: { type: "enum", values: [...FORMATS], default: "mp3", label: "audio format" },
    pitch: { type: "int", default: 0, min: -12, max: 12, label: "pitch (MiniMax HD only)" },
    speed: { type: "float", default: 1, min: 0.5, max: 2, label: "speed (MiniMax HD only)" },
    volume: { type: "float", default: 1, min: 0, max: 10, label: "volume (MiniMax HD only)" },
    sample_rate: {
      type: "enum",
      values: SAMPLE_RATES.map(String),
      default: "44100",
      label: "sample rate",
    },
  },
  ui: { section: "score", order: 20 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const auth = (apiKey: string) => ({ authorization: "Bearer " + apiKey });

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

/** Is the endpoint still in its virgin cold start (no worker has ever come up)? Best-effort: any
 *  transport/HTTP failure reads as "not cold" so the #141 verdict still fires. */
async function endpointStillCold(apiKey: string): Promise<boolean> {
  try {
    const r = await fetch(ENDPOINT + "/health", { headers: auth(apiKey) });
    if (!r.ok) return false;
    return workersStillCold(await r.json());
  } catch {
    return false;
  }
}

/** Best-effort cancel of a RunPod job we are about to fail: a hung-error job otherwise HOLDS the
 *  billed worker until someone cancels it by hand (F17 spend leak). Never throws; the honest
 *  failure below is the point, the cancel is damage control. */
async function cancelRunpodJobBestEffort(apiKey: string, jobId: string): Promise<void> {
  try {
    await fetch(ENDPOINT + "/cancel/" + jobId, { method: "POST", headers: auth(apiKey) });
  } catch {
    /* best-effort */
  }
}


/** /invoke: validate, submit to RunPod, return a poll token immediately. No blocking. */
async function submit(env: Env, req: InvokeRequest<ScoreInput>): Promise<InvokeResponse<ScoreOutput>> {
  const input = req.input;
  const filmKey = typeof input?.film_key === "string" ? input.film_key.trim() : "";
  if (!filmKey) return { ok: false, error: "score: input.film_key required" };
  const apiKey = await secretValue(env.RUNPOD_API_KEY);
  if (!apiKey) return { ok: false, error: "narration-gen: RUNPOD_API_KEY not configured" };

  const config = normalizeConfig(req.config ?? {});
  let body: { input: Record<string, unknown> };
  try {
    body = buildSpeechBody(textFromScoreInput({ ...input, film_key: filmKey }, config), config);
  } catch (e) {
    return { ok: false, error: "score: " + (e as Error).message };
  }

  const jobId = req.context?.job_id || crypto.randomUUID();
  const format = config.format ?? "mp3";
  const applied = appliedTags(format, config);
  try {
    const r = await fetch(ENDPOINT + "/run", {
      method: "POST",
      headers: { ...auth(apiKey), "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) return { ok: false, error: "narration-gen /run -> " + r.status };
    const runpodJobId = ((await r.json()) as { id?: string }).id;
    if (!runpodJobId) return { ok: false, error: "narration-gen /run returned no job id" };
    const submittedAt = Date.now();
    await recordRunpodJob(env.TELEMETRY_DB, { jobId: runpodJobId, module: MANIFEST.name, outcome: "submitted", submittedAtMs: submittedAt });
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId: runpodJobId, job_id: jobId, film_key: filmKey, format, applied, submittedAt }),
      // cf#289/#296: RunPod cannot enumerate jobs, so a caller not handed the id at submit can
      // never reach it. NAME THE VALUE: `jobId` in this scope is the FILM job id
      // (req.context.job_id), so the `jobId,` shorthand every sibling module uses would return
      // the wrong id here and still typecheck. Pinned by test against exactly that swap.
      jobId: runpodJobId,
    };
  } catch (e) {
    return { ok: false, error: "narration-gen submit failed: " + (e as Error).message };
  }
}

/** /poll: check the RunPod job; on COMPLETED download the audio + store it in R2 and return the output. */
async function poll(env: Env, body: PollRequest): Promise<PollResponse<ScoreOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "narration-gen: bad poll token" };
  const apiKey = await secretValue(env.RUNPOD_API_KEY);
  if (!apiKey) return { ok: false, error: "narration-gen: RUNPOD_API_KEY not configured" };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(ENDPOINT + "/status/" + st.jobId, { headers: auth(apiKey) });
    httpStatus = resp.status;
    s = (await resp.json()) as typeof s;
  } catch {
    return { ok: true, pending: true }; // transient; poll again
  }
  // RunPod GC'd the job (HTTP 404): would otherwise read as not-COMPLETED forever (#141). narration writes
  // R2 only on COMPLETED, so a gone job has no recoverable artifact: fail past grace, keep polling inside it.
  if (runpodJobGone(httpStatus, s)) {
    const now = Date.now();
    if (classifyGoneState(st.submittedAt, now) === "gone-failed") {
      // Cold-start tolerance: a virgin host's image pull can outlive the grace window while the job
      // 404s. If no worker has EVER come up, this is "still initializing", not "dropped" -- keep
      // polling up to the cold cap instead of false-failing the first-ever job.
      if (
        classifyGoneState(st.submittedAt, now, RUNPOD_COLD_GRACE_MS) === "gone-grace" &&
        (await endpointStillCold(apiKey))
      ) {
        return { ok: true, pending: true };
      }
      await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "gone", submittedAtMs: st.submittedAt });
      return { ok: false, error: "narration-gen job not found on RunPod (GC'd or never ran) (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") {
    await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "failed", submittedAtMs: st.submittedAt, detail: JSON.stringify(s.error ?? s), errorType: parseRunpodErrorType(s.error) });
    return { ok: false, error: "narration-gen job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  }
  // cf#298: CANCELLED and TIMED_OUT are TERMINAL, and the branch below treats every
  // non-COMPLETED status as "still running" -- so for those two no terminal write is ever
  // ATTEMPTED and the row stays `submitted` forever. RECORD ONLY: the render-path behaviour
  // below is deliberately UNCHANGED, because telemetry must never gate the render path and a
  // live CANCELLED job had already produced the artifact the film went on to use.
  const walkedPast = runpodWalkedPastOutcome(s.status);
  if (walkedPast) {
    await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: walkedPast, submittedAtMs: st.submittedAt, detail: "runpod status " + String(s.status ?? "unknown"), errorType: parseRunpodErrorType(s.error) });
  }
  if (s.status !== "COMPLETED") {
    // F17: a backend whose error path RETURNS (instead of raising) leaves the RunPod job IN_PROGRESS
    // forever -- holding and billing the worker -- while `output` already carries the structured
    // terminal error. Surface the REAL error (never "not found") and cancel to stop the spend.
    const backendErr = terminalErrorInOutput(s.output);
    if (backendErr) {
      await cancelRunpodJobBestEffort(apiKey, st.jobId);
      await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "backend-error", submittedAtMs: st.submittedAt, detail: backendErr, errorType: parseRunpodErrorType(s.output) });
      return { ok: false, error: "narration-gen backend error (job " + st.jobId + ", status stuck " + String(s.status ?? "unknown") + ", cancel issued): " + backendErr };
    }
    return { ok: true, pending: true }; // IN_QUEUE / IN_PROGRESS
  }

  // cf#279: the ENDPOINT completed. Recorded before the output is parsed, because whether
  // WE could use the output is a different fact and the chain response is what carries it.
  await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "completed", submittedAtMs: st.submittedAt });

  const url = extractAudioUrl(s.output);
  if (!url) return { ok: false, error: "narration-gen output had no audio url" };
  let bytes: ArrayBuffer;
  let mime: string;
  try {
    const a = await fetch(url);
    if (!a.ok) return { ok: false, error: "fetch narration audio -> " + a.status };
    mime = a.headers.get("content-type")?.split(";")[0]?.trim() || mimeForFormat(st.format);
    bytes = await a.arrayBuffer();
  } catch (e) {
    return { ok: false, error: "download narration audio failed: " + (e as Error).message };
  }
  const key = audioKey(st.job_id, st.format);
  try {
    await env.R2_RENDERS.put(key, bytes, { httpMetadata: { contentType: mime } });
  } catch (e) {
    return { ok: false, error: "R2 put failed: " + (e as Error).message };
  }
  return { ok: true, output: { film_key: st.film_key, applied: [...st.applied, `audio:${key}`] } };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);

    // GET /ready (cf#295): credential-visibility probe, matching the contract of the six tenant
    // RunPod modules (docs/module-api.md "Credential readiness"). This module's RunPod endpoint id is
    // a fixed PUBLIC url baked into the code, not a per-tenant secret, so the API key is the only
    // credential worth reporting -- unlike the tenant finish satellites there is no endpoint-id
    // propagation state to distinguish. cf#305 added the runpod_job_log binding, so
    // `telemetry.job_log` is reported here too.
    if (request.method === "GET" && url.pathname === "/ready") {
      const apiKey = await secretValue(env.RUNPOD_API_KEY);
      return json({
        ok: Boolean(apiKey),
        module: MANIFEST.name,
        credentials: { runpod_api_key: Boolean(apiKey) },
        // cf#279/#305: can this worker RECORD a job outcome at all? Reported because an empty
        // job log is otherwise indistinguishable from a clean run, which is the exact failure
        // shape the log exists to end. Deliberately NOT part of `ok`: the job log is telemetry
        // and a module without it still renders.
        telemetry: { job_log: await probeRunpodJobLog(env.TELEMETRY_DB) },
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
