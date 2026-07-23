// finish-lipsync: a finish module worker (vivijure-module/2). MuseTalk audio-driven lip-sync,
// dispatched to the dedicated vivijure-musetalk RunPod endpoint (cu128; separate from vivijure-backend).
// Rewrites a shot's mouth to match its dialogue audio -- the "talking characters" finish stage.
//
// ASYNC: GPU lip-sync runs frame-by-frame and exceeds a Worker request budget:
//   GET  /module.json -> manifest
//   POST /invoke      -> submit to RunPod, return { ok, pending, poll } immediately
//   POST /poll        -> check job status; return output on completion
//
// R2 transport: the endpoint reads `clip_key` + `audio_key` and writes `output_key` in the shared
// bucket itself (exactly as finish-upscale / vivijure-backend do), so this worker holds no R2 creds.
//
// Failures are DATA, never an exception across the wire. For a chain hook the soft degrade (pass the
// input clip through unchanged, but RECORDED) is preferred over a hard ok:false unless the job cannot
// be submitted at all. A shot with no dialogue `audio_key` is an intentional NO-OP, not a degrade.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type FinishInput,
  type FinishOutput,
} from "./contract";
import {
  coerceConfig, buildRunPodBody, encodePoll, decodePoll, parseBackendOutput, passthroughOutput,
  runpodJobGone, classifyGoneState, workersStillCold, terminalErrorInOutput,
  softDegradeInFailedEnvelope, RUNPOD_COLD_GRACE_MS,
} from "./lipsync";
import { reconcileRunpodEndpointWorkersMax } from "@skyphusion-labs/vivijure-core/runpod-endpoint-reconcile";

interface Env {
  RUNPOD_API_KEY: SecretsStoreSecret;
  RUNPOD_ENDPOINT_ID: SecretsStoreSecret;
  RUNPOD_WORKERS_MAX?: string;
}

export const MANIFEST: ModuleManifest = {
  name: "finish-lipsync",
  version: "0.2.0",
  api: MODULE_API,
  hooks: ["finish"],
  provides: [
    { id: "lipsync", label: "Lip-sync to dialogue (MuseTalk)" },
  ],
  config_schema: {
    version:    { type: "enum", values: ["v15", "v1"], default: "v15", label: "MuseTalk version (v15 = v1.5, best)" },
    bbox_shift: { type: "int",  default: 0, min: -20, max: 20, label: "mouth crop shift" },
  },
  // Order < the upscaler's 20 so a lip-synced shot is then upscaled (the 256px face region wants it).
  ui: { section: "finish", icon: "mic", order: 15 },
  // Declared artifact conventions (S6): the MuseTalk container appends _ls to the input clip key.
  finish_artifacts: {
    output_key: { kind: "append_suffix", suffix: "_ls" },
    applied: [{ tag: "lipsync:{version|v15}" }],
  },
  // #584: lip-sync drives the mouth from the shot dialogue audio (audio_key) and is calibrated to the
  // SOURCE frame rate, so the core must run it on the native-fps clip before any interpolation. This
  // flag (not the module name) is how the core hoists it ahead of RIFE for a shot that has a line.
  finish_consumes_audio: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function runpodBase(endpointId: string): string {
  return `https://api.runpod.ai/v2/${endpointId}`;
}

function auth(apiKey: string) {
  return { authorization: "Bearer " + apiKey };
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

/** Resolve both RunPod secrets once per request. */
async function runpodCreds(env: Env): Promise<{ apiKey: string; endpointId: string }> {
  const [apiKey, endpointId] = await Promise.all([
    secretValue(env.RUNPOD_API_KEY),
    secretValue(env.RUNPOD_ENDPOINT_ID),
  ]);
  return { apiKey, endpointId };
}

/** cf#114: classify an absent RunPod credential HONESTLY.
 *  RUNPOD_ENDPOINT_ID is a plain_text binding written at module UPLOAD; RUNPOD_API_KEY is a secret
 *  written LATER (by installInvokeKey on the control plane). The two therefore arrive by different
 *  routes at different times, so endpoint-present + key-absent is diagnostic of PROPAGATION, not of
 *  misconfiguration, and saying "not configured" about it is a lie that sent a real tenant chasing a
 *  correctly-configured credential. Both absent stays a genuine "not configured".
 *  Returns null when both are readable. */
function credentialProblem(apiKey: string, endpointId: string): string | null {
  if (apiKey && endpointId) return null;
  if (endpointId) return "credential not yet visible on this worker version (retry shortly)";
  return "RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID not configured";
}

/** cf#114, degrade side of credentialProblem: the same propagation-vs-misconfiguration distinction,
 *  expressed as a machine-readable degrade REASON. A polish step never fails the chain, but it must
 *  still say WHICH of the two it hit -- "no-runpod-secrets" on a key that is merely not visible yet
 *  reads as an operator error that does not exist. Returns null when both are readable. */
function credentialDegradeReason(apiKey: string, endpointId: string): string | null {
  if (apiKey && endpointId) return null;
  return endpointId ? "runpod-key-not-yet-visible" : "no-runpod-secrets";
}

/** Is the endpoint still in its virgin cold start (no worker has ever come up)? Best-effort: any
 *  transport/HTTP failure reads as "not cold" so the #141 verdict still fires. */
async function endpointStillCold(apiKey: string, endpointId: string): Promise<boolean> {
  try {
    const r = await fetch(runpodBase(endpointId) + "/health", { headers: auth(apiKey) });
    if (!r.ok) return false;
    return workersStillCold(await r.json());
  } catch {
    return false;
  }
}

/** Best-effort cancel of a RunPod job we are about to fail: a hung-error job otherwise HOLDS the
 *  billed worker until someone cancels it by hand (F17 spend leak). Never throws; the honest
 *  failure below is the point, the cancel is damage control. */
async function cancelRunpodJobBestEffort(apiKey: string, endpointId: string, jobId: string): Promise<void> {
  try {
    await fetch(runpodBase(endpointId) + "/cancel/" + jobId, { method: "POST", headers: auth(apiKey) });
  } catch {
    /* best-effort */
  }
}


/** Soft degrade: pass the input clip through unchanged (a no-op beats a crash in a chain), but ALWAYS
 *  record why -- `passthroughOutput` tags `applied` and sets `degraded` for a real failure, or tags a
 *  bare `noop:` for the legitimate no-dialogue case, so the two are never indistinguishable (#77). */
function passthrough(
  input: FinishInput,
  reason: string,
  opts: { degraded?: boolean; detail?: string } = {},
): InvokeResponse<FinishOutput> {
  const output = passthroughOutput(input, reason, opts);
  if (output.degraded) console.warn(`finish-lipsync: passthrough (${output.degraded}) shot=${input.shot_id}`);
  return { ok: true, output };
}

async function submit(env: Env, req: InvokeRequest<FinishInput>): Promise<InvokeResponse<FinishOutput>> {
  const input = req.input;
  if (!input?.shot_id || !input?.clip_key) {
    return { ok: false, error: "finish-lipsync: input needs shot_id and clip_key" };
  }
  // No dialogue for this shot -> nothing to lip-sync to. Intentional no-op, NOT a degrade.
  if (!input.audio_key) {
    return passthrough(input, "no-dialogue", { degraded: false });
  }
  const { apiKey, endpointId } = await runpodCreds(env);
  if (!apiKey || !endpointId) {
    // Degrade, but say WHICH: absent-key-with-endpoint is propagation, not misconfiguration (cf#114).
    return passthrough(input, credentialDegradeReason(apiKey, endpointId) ?? "no-runpod-secrets");
  }

  const workersMax = Number(env.RUNPOD_WORKERS_MAX);
  if (Number.isFinite(workersMax) && workersMax > 0) {
    const rec = await reconcileRunpodEndpointWorkersMax({
      apiKey,
      endpointId,
      spec: { workersMax: Math.floor(workersMax) },
    });
    if (!rec.ok) {
      const msg = rec.guidance ? `${rec.error}. ${rec.guidance}` : rec.error;
      return { ok: false, error: "finish-lipsync: " + msg };
    }
  }

  const cfg = coerceConfig(req.config);
  try {
    const r = await fetch(runpodBase(endpointId) + "/run", {
      method: "POST",
      headers: { ...auth(apiKey), "content-type": "application/json" },
      body: JSON.stringify(buildRunPodBody(input, cfg, req.context.project)),
    });
    if (!r.ok) return passthrough(input, "runpod-run-failed", { detail: "HTTP " + r.status });
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return passthrough(input, "no-jobid");
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, shotId: input.shot_id, clipKey: input.clip_key, srcFps: input.src_fps ?? 24, frames: input.frames ?? 0, submittedAt: Date.now() }),
    };
  } catch (e) {
    return passthrough(input, "exception", { detail: (e as Error).message });
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<FinishOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "finish-lipsync: bad poll token" };
  const { apiKey, endpointId } = await runpodCreds(env);
  const credProblem = credentialProblem(apiKey, endpointId);
  if (credProblem) return { ok: false, error: "finish-lipsync: " + credProblem };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(runpodBase(endpointId) + "/status/" + st.jobId, { headers: auth(apiKey) });
    httpStatus = resp.status;
    s = await resp.json() as typeof s;
  } catch {
    return { ok: true, pending: true };
  }
  // RunPod GC'd the job (HTTP 404 / numeric "status":404): without this guard a 404 reads as
  // "not COMPLETED" and the poll reports pending forever (#141). Past the grace window fail; inside it
  // keep polling (post-submit race).
  if (runpodJobGone(httpStatus, s)) {
    const now = Date.now();
    if (classifyGoneState(st.submittedAt, now) === "gone-failed") {
      // Cold-start tolerance: a virgin host's image pull can outlive the grace window while the job
      // 404s. If no worker has EVER come up, this is "still initializing", not "dropped" -- keep
      // polling up to the cold cap instead of false-failing the first-ever job.
      if (
        classifyGoneState(st.submittedAt, now, RUNPOD_COLD_GRACE_MS) === "gone-grace" &&
        (await endpointStillCold(apiKey, endpointId))
      ) {
        return { ok: true, pending: true };
      }
      return { ok: false, error: "finish-lipsync job not found on RunPod (GC'd or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") {
    // #565: RunPod lifts the handler's top-level `error` into a job-level FAILED, so the backend's
    // structured soft-degrade ({ok:false} kept in output) arrives here, never at the COMPLETED
    // branch below. Pass the original clip through (recorded, #77) instead of failing the shot; a
    // genuine crash (raise -> no structured output) still fails loud.
    const degrade = softDegradeInFailedEnvelope(s);
    if (degrade !== null) {
      console.warn(`finish-lipsync: poll passthrough (backend-soft-degrade) shot=${st.shotId}`);
      return {
        ok: true,
        output: passthroughOutput(
          { shot_id: st.shotId, clip_key: st.clipKey, src_fps: st.srcFps, frames: st.frames, width: 0, height: 0 },
          "backend-soft-degrade",
          { detail: degrade || undefined },
        ),
      };
    }
    return { ok: false, error: "finish-lipsync job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  }
  if (s.status !== "COMPLETED") {
    // F17: a backend whose error path RETURNS (instead of raising) leaves the RunPod job IN_PROGRESS
    // forever -- holding and billing the worker -- while `output` already carries the structured
    // terminal error. Surface the REAL error (never "not found") and cancel to stop the spend.
    const backendErr = terminalErrorInOutput(s.output);
    if (backendErr) {
      await cancelRunpodJobBestEffort(apiKey, endpointId, st.jobId);
      return { ok: false, error: "finish-lipsync backend error (job " + st.jobId + ", status stuck " + String(s.status ?? "unknown") + ", cancel issued): " + backendErr };
    }
    return { ok: true, pending: true };
  }

  // The endpoint's R2-mode result: { ok, clip_key, applied, ... }. If the handler soft-degraded
  // (e.g. no detectable face), ok is false and clip_key is absent -> pass the original clip through.
  // The reason arrives as `detail` since musetalk#25 (a top-level `error` would be lifted by RunPod
  // into a job-level FAILED); `error` is kept as the legacy-handler fallback.
  const o = (s.output ?? {}) as { ok?: unknown; error?: unknown; detail?: unknown };
  if (o.ok === false) {
    const reason = typeof o.detail === "string" && o.detail.length > 0 ? o.detail
      : typeof o.error === "string" && o.error.length > 0 ? o.error : undefined;
    return {
      ok: true,
      output: passthroughOutput(
        { shot_id: st.shotId, clip_key: st.clipKey, src_fps: st.srcFps, frames: st.frames, width: 0, height: 0 },
        "backend-soft-degrade",
        { detail: reason?.slice(0, 120) },
      ),
    };
  }
  const out = parseBackendOutput(s.output);
  if (!out?.clip_key) return { ok: false, error: "finish-lipsync: backend returned no clip_key" };
  return {
    ok: true,
    output: {
      shot_id: st.shotId,
      clip_key: out.clip_key,
      out_fps: st.srcFps,    // lip-sync preserves fps + frame count
      frames: st.frames,
      applied: out.applied ?? [],
    },
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/module.json") return json(MANIFEST);
    // GET /ready (cf#114): does the version the edge is ACTUALLY SERVING read its credentials?
    // Booleans only, NEVER values -- this reports whether a credential is visible here, not what it
    // is. Zero GPU cost and module-agnostic, which is what makes it a probe the control plane can
    // run before flipping a tenant live. Unauthenticated by design, on the same footing as
    // /module.json: these scripts are reachable only through the dispatch namespace (they carry no
    // public route), the response contains nothing secret, and the control plane has to be able to
    // ask this question at the exact moment the tenant has no working credential to authenticate
    // with. Gating it would make it unusable for its one purpose while protecting nothing.
    if (request.method === "GET" && url.pathname === "/ready") {
      const { apiKey, endpointId } = await runpodCreds(env);
      return json({
        ok: Boolean(apiKey && endpointId),
        // Echoed so a prober can prove it reached the script it MEANT to reach (a tenant-prefixed
        // script name is easy to get wrong); already public in /module.json, so it leaks nothing.
        module: MANIFEST.name,
        credentials: { runpod_api_key: Boolean(apiKey), runpod_endpoint_id: Boolean(endpointId) },
      });
    }

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<FinishInput>;
      try { req = await request.json() as InvokeRequest<FinishInput>; }
      catch { return json({ ok: false, error: "invalid JSON body" } as InvokeResponse); }
      if (req.hook !== "finish") return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
      return json(await submit(env, req));
    }

    if (request.method === "POST" && url.pathname === "/poll") {
      let body: PollRequest;
      try { body = await request.json() as PollRequest; }
      catch { return json({ ok: false, error: "invalid JSON body" } as PollResponse); }
      if (!body?.poll || typeof body.poll !== "string") return json({ ok: false, error: "poll token required" } as PollResponse);
      return json(await poll(env, body));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
