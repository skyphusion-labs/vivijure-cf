// kling: a motion.backend module worker (vivijure-module/2), Kuaishou Kling V2.1 I2V Pro on RunPod.
// Async (same shape as seedance): GET /module.json, POST /invoke (submit -> poll token), POST /poll
// (check GET /status, finalize to R2 on completion). The second motion.backend backend -> the UI's
// pick_one hook now has a real choice. Failures are DATA.

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
import { buildKlingBody, extractVideoUrl, clipKey, clampDuration, encodePoll, decodePoll, runpodJobGone, classifyGoneState, workersStillCold, terminalErrorInOutput, RUNPOD_COLD_GRACE_MS } from "./kling";

import { recordRunpodJob, probeRunpodJobLog, parseRunpodErrorType, runpodWalkedPastOutcome } from "../../_shared/runpod-job-log";
import { planeRefusalReason, planeRefusalError, runpodRoute, runpodEndpointUrl, runpodHeaders, runpodCredentialName, type RunpodRoute } from "../../_shared/runpod-route";

interface Env {
  RUNPOD_API_KEY: SecretsStoreSecret;
  /** cf#394 / cp#288: the plane-side RunPod proxy. Bound (plain_text) only for shared hosted
   *  tenants; unbound everywhere else, which is the untouched direct path. See
   *  modules/_shared/runpod-route.ts -- the branch is BOUND-ness, never failover. */
  RUNPOD_PROXY_BASE?: string;
  /** cf#394 / cp#288: the per-tenant plane credential presented instead of a RunPod key. */
  RUNPOD_PROXY_TOKEN?: SecretsStoreSecret | string;
  R2_RENDERS: { put(key: string, value: ArrayBuffer): Promise<unknown> };
  /** cf#279 job log, cf#305. OPTIONAL: a module deployed without it still works, and its
   *  absence warns rather than reading as a clean run (modules/_shared/runpod-job-log.ts). */
  TELEMETRY_DB?: D1Database;
}

const ENDPOINT_ID = "kling-v2-1-i2v-pro";
const OUT_FPS = 24;

const MANIFEST: ModuleManifest = {
  name: "kling",
  version: "0.1.1",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-cloud", label: "Silent cinematic (Kling)" }],
  config_schema: {
    guidance_scale: { type: "float", default: 0.5, min: 0, max: 1, label: "guidance scale" },
    negative_prompt: { type: "string", default: "", label: "negative prompt" },
    enable_safety_checker: { type: "bool", default: true, label: "safety checker" },
  },
  ui: {
    section: "motion",
    order: 20,
    locality: "cloud",
    cost: "Pay per render",
    blurb: "Cinematic camera, silent clips. 5 or 10 seconds. Cast voice + MuseTalk if they speak.",
    limits: [
      "5 or 10 second clips",
      "Silent motion",
      "Speaking is Cast voice plus MuseTalk",
    ],
  },
  usage: {
    native_audio: false,
    voice: "cast_tts",
    scatter_native_audio: true,
    min_seconds: 5,
    max_seconds: 10,
    duration_steps: [5, 10],
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
const endpoint = (route: RunpodRoute) => runpodEndpointUrl(route, ENDPOINT_ID);
const auth = (route: RunpodRoute) => runpodHeaders(route, MANIFEST.name);

/** Is the endpoint still in its virgin cold start (no worker has ever come up)? Best-effort: any
 *  transport/HTTP failure reads as "not cold" so the #141 verdict still fires. */
async function endpointStillCold(route: RunpodRoute): Promise<boolean> {
  try {
    const r = await fetch(endpoint(route) + "/health", { headers: auth(route) });
    if (!r.ok) return false;
    return workersStillCold(await r.json());
  } catch {
    return false;
  }
}

/** Best-effort cancel of a RunPod job we are about to fail: a hung-error job otherwise HOLDS the
 *  billed worker until someone cancels it by hand (F17 spend leak). Never throws; the honest
 *  failure below is the point, the cancel is damage control. */
async function cancelRunpodJobBestEffort(route: RunpodRoute, jobId: string): Promise<void> {
  try {
    await fetch(endpoint(route) + "/cancel/" + jobId, { method: "POST", headers: auth(route) });
  } catch {
    /* best-effort */
  }
}



async function submit(env: Env, req: InvokeRequest<MotionBackendInput>): Promise<InvokeResponse<MotionBackendOutput>> {
  const input = req.input;
  if (!input || !input.keyframe_url || !input.prompt || !input.shot_id) {
    return { ok: false, error: "motion.backend: input needs shot_id, keyframe_url, and prompt" };
  }
  const route = await runpodRoute(env);
  if (!route.credential) return { ok: false, error: "kling: " + runpodCredentialName(route) + " not configured" };
  try {
    const r = await fetch(endpoint(route) + "/run", {
      method: "POST",
      headers: { ...auth(route), "content-type": "application/json" },
      body: JSON.stringify(buildKlingBody(input, req.config)),
    });
    if (!r.ok) return { ok: false, error: "kling /run -> " + r.status };
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return { ok: false, error: "kling /run returned no job id" };
    const submittedAt = Date.now();
    await recordRunpodJob(env.TELEMETRY_DB, { jobId, module: MANIFEST.name, outcome: "submitted", submittedAtMs: submittedAt });
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, project: req.context.project, shotId: input.shot_id, seconds: clampDuration(input.seconds), submittedAt }),
      jobId,  // cf#289/#296: RunPod cannot enumerate jobs; an id the caller is not handed at submit is unreachable forever.
    };
  } catch (e) {
    return { ok: false, error: "kling submit failed: " + (e as Error).message };
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<MotionBackendOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "kling: bad poll token" };
  const route = await runpodRoute(env);
  if (!route.credential) return { ok: false, error: "kling: " + runpodCredentialName(route) + " not configured" };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(endpoint(route) + "/status/" + st.jobId, { headers: auth(route) });
    // cf#398: a plane-AUTHORED refusal is NOT an upstream status and must never read as
    // pending. Checked before the body is interpreted, so it does not rest on the refusal
    // body parsing. No header (direct route, a normal response, or a proxy 502 that could
    // not reach RunPod) leaves every branch below byte for byte unchanged.
    const refusal = planeRefusalReason(route, resp);
    if (refusal) return { ok: false, error: planeRefusalError(MANIFEST.name, refusal) };
    httpStatus = resp.status;
    s = (await resp.json()) as typeof s;
  } catch {
    return { ok: true, pending: true };
  }
  // RunPod GC'd the job (HTTP 404 / "job not found"): the numeric 404 status would otherwise read as
  // "not COMPLETED" and the poll would report pending forever (issue #141). kling downloads + writes R2
  // only on COMPLETED, so a never-completed job has no recoverable artifact: past the grace window (or a
  // legacy token) fail the shot; inside it keep polling (post-submit race).
  if (runpodJobGone(httpStatus, s)) {
    const now = Date.now();
    if (classifyGoneState(st.submittedAt, now) === "gone-failed") {
      // Cold-start tolerance: a virgin host's image pull can outlive the grace window while the job
      // 404s. If no worker has EVER come up, this is "still initializing", not "dropped" -- keep
      // polling up to the cold cap instead of false-failing the first-ever job.
      if (
        classifyGoneState(st.submittedAt, now, RUNPOD_COLD_GRACE_MS) === "gone-grace" &&
        (await endpointStillCold(route))
      ) {
        return { ok: true, pending: true };
      }
      await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "gone", submittedAtMs: st.submittedAt });
      return { ok: false, error: "kling job not found on RunPod (GC'd or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") {
    await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "failed", submittedAtMs: st.submittedAt, detail: JSON.stringify(s.error ?? s), errorType: parseRunpodErrorType(s.error) });
    return { ok: false, error: "kling job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
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
      await cancelRunpodJobBestEffort(route, st.jobId);
      await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "backend-error", submittedAtMs: st.submittedAt, detail: backendErr, errorType: parseRunpodErrorType(s.output) });
      return { ok: false, error: "kling backend error (job " + st.jobId + ", status stuck " + String(s.status ?? "unknown") + ", cancel issued): " + backendErr };
    }
    return { ok: true, pending: true };
  }

  // cf#279: the ENDPOINT completed. Recorded before the output is parsed, because whether
  // WE could use the output is a different fact and the chain response is what carries it.
  await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "completed", submittedAtMs: st.submittedAt });

  const url = extractVideoUrl(s.output);
  if (!url) return { ok: false, error: "kling output had no video url" };
  let bytes: ArrayBuffer;
  try {
    const v = await fetch(url);
    if (!v.ok) return { ok: false, error: "fetch kling video -> " + v.status };
    bytes = await v.arrayBuffer();
  } catch (e) {
    return { ok: false, error: "download kling video failed: " + (e as Error).message };
  }
  const key = clipKey(st.project, st.shotId);
  try {
    await env.R2_RENDERS.put(key, bytes);
  } catch (e) {
    return { ok: false, error: "R2 put failed: " + (e as Error).message };
  }
  return { ok: true, output: { shot_id: st.shotId, clip_key: key, fps: OUT_FPS, frames: st.seconds * OUT_FPS } };
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
      const route = await runpodRoute(env);
      return json({
        ok: Boolean(route.credential),
        module: MANIFEST.name,
        credentials: { runpod_api_key: Boolean(route.credential) },
        // cf#394: which route answered. Additive -- the plane parses runpod_api_key and
        // refuses a module whose /ready omits it, so that field keeps its name.
        runpod_proxied: route.proxied,
        // cf#279/#305: can this worker RECORD a job outcome at all? Reported because an empty
        // job log is otherwise indistinguishable from a clean run, which is the exact failure
        // shape the log exists to end. Deliberately NOT part of `ok`: the job log is telemetry
        // and a module without it still renders.
        telemetry: { job_log: await probeRunpodJobLog(env.TELEMETRY_DB) },
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
      if (!body || typeof body.poll !== "string") return json({ ok: false, error: "poll token required" } as PollResponse);
      return json(await poll(env, body));
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
