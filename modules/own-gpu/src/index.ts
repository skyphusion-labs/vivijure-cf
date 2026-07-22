// own-gpu: a motion.backend module worker (vivijure-module/2) that renders image-to-video on YOUR
// OWN GPU via the vivijure-backend RunPod serverless endpoint (Wan2.2-I2V), the i2v_clip action.
// This is the BYO-GPU default -- no rent, own keys -- so it sorts ahead of the cloud i2v modules.
//
// Unlike a cloud i2v module, the backend SHARES our R2 bucket: it reads the keyframe by key and
// WRITES the finished clip itself, returning the clip_key. So this module never downloads or
// re-uploads -- it submits, polls, and surfaces the key the backend reported.
//
// ASYNC (GPU generation + a cold worker exceed a single Worker request):
//   GET  /module.json -> manifest
//   POST /invoke      -> submit i2v_clip, return { ok, pending, poll } IMMEDIATELY (no blocking)
//   POST /poll        -> { poll } -> check the job; surface the clip on completion
// The caller polls /poll until it is no longer pending. Failures are DATA, never an exception.

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
import { buildI2vBody, readOutput, encodePoll, decodePoll, runpodJobGone, classifyGoneState, workersStillCold, terminalErrorInOutput, RUNPOD_COLD_GRACE_MS } from "./i2v";
import { reconcileRunpodEndpointWorkersMax } from "@skyphusion-labs/vivijure-core/runpod-endpoint-reconcile";

interface Env {
  RUNPOD_API_KEY: SecretsStoreSecret;
  RUNPOD_ENDPOINT_ID: SecretsStoreSecret;
  /** Expected workersMax for idle reconcile (cf#61). Plain-text module var. */
  RUNPOD_WORKERS_MAX?: string;
}

// Exported so the core's tier-drift guard (tests/quality-tier-drift.test.ts, issue #124) can assert
// this module's `quality` enum stays in lockstep with the core QUALITY_TIERS set.
export const MANIFEST: ModuleManifest = {
  name: "own-gpu",
  version: "0.2.0",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-own-gpu", label: "Own GPU (Wan2.2 i2v)" }],
  config_schema: {
    quality: { type: "enum", values: ["draft", "standard", "final"], default: "standard", label: "quality" },
    fps: { type: "int", default: 16, min: 8, max: 30, label: "fps" },
    flow_shift: { type: "float", default: 5.0, min: 1, max: 12, label: "motion (flow shift, lower = faster)" },
    negative_prompt: { type: "string", default: "", label: "negative prompt (additive)" },
    seed: { type: "int", default: -1, min: -1, label: "seed (-1 = random)" },
  },
  ui: { section: "motion", order: 5, locality: "byo", cost: "Own keys (your RunPod endpoint)", blurb: "Renders on your own RunPod GPU endpoint -- own keys, no per-render markup; quality follows the GPU tier you rent." },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const auth = (apiKey: string) => ({ authorization: "Bearer " + apiKey });

/** Is the endpoint still in its virgin cold start (no worker has ever come up)? Best-effort: any
 *  transport/HTTP failure reads as "not cold" so the #141 verdict still fires. */
async function endpointStillCold(apiKey: string, endpointId: string): Promise<boolean> {
  try {
    const r = await fetch(endpoint(endpointId) + "/health", { headers: auth(apiKey) });
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
    await fetch(endpoint(endpointId) + "/cancel/" + jobId, { method: "POST", headers: auth(apiKey) });
  } catch {
    /* best-effort */
  }
}

const endpoint = (endpointId: string) => "https://api.runpod.ai/v2/" + endpointId;
const configured = (apiKey: string, endpointId: string) => Boolean(apiKey && endpointId);

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

/** /invoke: validate, submit the i2v_clip job to our backend, return a poll token immediately. */
async function submit(env: Env, req: InvokeRequest<MotionBackendInput>): Promise<InvokeResponse<MotionBackendOutput>> {
  const input = req.input;
  if (!input || !input.prompt || !input.shot_id) {
    return { ok: false, error: "motion.backend: input needs shot_id and prompt" };
  }
  const { apiKey, endpointId } = await runpodCreds(env);
  const credProblem = credentialProblem(apiKey, endpointId);
  if (credProblem) return { ok: false, error: "own-gpu: " + credProblem };
  const workersMax = Number(env.RUNPOD_WORKERS_MAX);
  if (Number.isFinite(workersMax) && workersMax > 0) {
    const rec = await reconcileRunpodEndpointWorkersMax({
      apiKey,
      endpointId,
      spec: { workersMax: Math.floor(workersMax) },
    });
    if (!rec.ok) {
      const msg = rec.guidance ? `${rec.error}. ${rec.guidance}` : rec.error;
      return { ok: false, error: "own-gpu: " + msg };
    }
  }
  try {
    const r = await fetch(endpoint(endpointId) + "/run", {
      method: "POST",
      headers: { ...auth(apiKey), "content-type": "application/json" },
      body: JSON.stringify(buildI2vBody(input, req.config, req.context.project)),
    });
    if (!r.ok) return { ok: false, error: "own-gpu /run -> " + r.status };
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return { ok: false, error: "own-gpu /run returned no job id" };
    return { ok: true, pending: true, poll: encodePoll({ jobId, project: req.context.project, shotId: input.shot_id, submittedAt: Date.now() }) };
  } catch (e) {
    return { ok: false, error: "own-gpu submit failed: " + (e as Error).message };
  }
}

/** /poll: check the RunPod job; on completion the backend has already stored the clip in R2, so we
 *  just surface the clip_key it reported. No download, no re-upload. */
async function poll(env: Env, body: PollRequest): Promise<PollResponse<MotionBackendOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "own-gpu: bad poll token" };
  const { apiKey, endpointId } = await runpodCreds(env);
  const credProblem = credentialProblem(apiKey, endpointId);
  if (credProblem) return { ok: false, error: "own-gpu: " + credProblem };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(endpoint(endpointId) + "/status/" + st.jobId, { headers: auth(apiKey) });
    httpStatus = resp.status;
    s = (await resp.json()) as typeof s;
  } catch {
    return { ok: true, pending: true }; // transient; poll again
  }
  // RunPod GC'd the job (HTTP 404 / "job not found"): without this guard the poll below would treat the
  // numeric 404 status as "not COMPLETED" and report pending forever (issue #141). Past the grace window
  // (or for a legacy token with no submit stamp) fail the shot so it stops polling a dead job; inside the
  // window keep polling (a momentary post-submit propagation race).
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
      return { ok: false, error: "own-gpu job not found on RunPod (GC'd or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true }; // still inside the grace window
  }
  if (s.status === "FAILED") return { ok: false, error: "own-gpu job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  if (s.status !== "COMPLETED") {
    // F17: a backend whose error path RETURNS (instead of raising) leaves the RunPod job IN_PROGRESS
    // forever -- holding and billing the worker -- while `output` already carries the structured
    // terminal error. Surface the REAL error (never "not found") and cancel to stop the spend.
    const backendErr = terminalErrorInOutput(s.output);
    if (backendErr) {
      await cancelRunpodJobBestEffort(apiKey, endpointId, st.jobId);
      return { ok: false, error: "own-gpu backend error (job " + st.jobId + ", status stuck " + String(s.status ?? "unknown") + ", cancel issued): " + backendErr };
    }
    return { ok: true, pending: true }; // IN_QUEUE / IN_PROGRESS
  }

  const output = readOutput(st.shotId, s.output);
  if (!output) return { ok: false, error: "own-gpu output had no clip_key" };
  return { ok: true, output };
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
