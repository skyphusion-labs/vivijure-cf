// alibaba-wan-lora: a motion.backend module worker (vivijure-module/2), Wan 2.2 I2V on the RunPod
// PUBLIC managed endpoint `wan-2-2-t2v-720-lora` (pay-per-job, no endpoint to deploy). 720p i2v that
// takes a START IMAGE (the keyframe) AND accepts CUSTOM operator LoRAs (high-noise + low-noise passes).
// This is the alibaba-wan pattern + LoRA controls + the R2-fetch detail below.
//
// ASYNC: cloud i2v takes minutes, longer than a Worker request can hold, so:
//   GET  /module.json -> manifest
//   POST /invoke      -> submit the job, return { ok, pending, poll } IMMEDIATELY (no blocking)
//   POST /poll        -> { poll } -> check the job; finalize (download + store to R2) on completion
// The caller (the core / an orchestrator) polls /poll until it is no longer pending. Each call is
// fast (a status check; only the final one downloads), so nothing holds a multi-minute request.
//
// THE 7-DAY EXPIRY (critical): the endpoint's output `video_url` EXPIRES AFTER 7 DAYS. On COMPLETED the
// module FETCHES the clip from that URL and writes it to the shared `vivijure` R2 bucket under the
// motion.backend clip key, then returns the R2 key. The expiring provider URL is NEVER passed
// downstream -- the film assembler only ever sees the durable R2 key.
//
// Pairs with the cloud-keyframe module: cloud keyframe -> THIS i2v -> shot clip.

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
  buildWanLoraBody,
  extractVideoUrl,
  extractCost,
  clipKey,
  clampDuration,
  ALLOWED_DURATIONS,
  encodePoll,
  decodePoll,
  runpodJobGone,
  classifyGoneState, workersStillCold, terminalErrorInOutput, RUNPOD_COLD_GRACE_MS,
} from "./wan-lora";

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

const ENDPOINT_ID = "wan-2-2-t2v-720-lora";
const OUT_FPS = 24;

const MANIFEST: ModuleManifest = {
  name: "alibaba-wan-lora",
  version: "0.1.1",
  api: MODULE_API,
  hooks: ["motion.backend"],
  provides: [{ id: "i2v-cloud-lora", label: "Wan 2.2 (cloud i2v + custom LoRA)" }],
  config_schema: {
    // The LoRA lists are the whole point: control over cloud i2v. The contract's ConfigField has no
    // array type, so each list rides as a JSON STRING of [{ path, scale }] the module parses (path =
    // URL/path to the LoRA file; HuggingFace URLs supported). Default "[]" = plain Wan 2.2 i2v.
    high_noise_loras: { type: "string", default: "[]", label: "high-noise LoRAs -- JSON [{path,scale}]" },
    low_noise_loras: { type: "string", default: "[]", label: "low-noise LoRAs -- JSON [{path,scale}]" },
    seed: { type: "int", default: -1, min: -1, label: "seed (-1 = random)" },
    enable_safety_checker: { type: "bool", default: true, label: "safety checker" },
  },
  ui: { section: "motion", order: 75, locality: "cloud", cost: "Pay per render", blurb: "Rents datacenter GPUs by the second -- top quality, scale-to-zero; you pay only for render seconds." },
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


/** /invoke: validate, submit to RunPod, return a poll token immediately. No blocking. */
async function submit(env: Env, req: InvokeRequest<MotionBackendInput>): Promise<InvokeResponse<MotionBackendOutput>> {
  const input = req.input;
  if (!input || !input.keyframe_url || !input.prompt || !input.shot_id) {
    return { ok: false, error: "motion.backend: input needs shot_id, keyframe_url, and prompt" };
  }
  const route = await runpodRoute(env);
  if (!route.credential) return { ok: false, error: "alibaba-wan-lora: " + runpodCredentialName(route) + " not configured" };
  // Non-silent duration snap (#279): the endpoint only accepts ALLOWED_DURATIONS, so record when a
  // requested per-shot duration is snapped -- the user's timing change must be observable, never silent.
  const requestedDuration = Math.round(Number(input.seconds) || 5);
  const snappedDuration = clampDuration(input.seconds);
  if (snappedDuration !== requestedDuration) {
    console.log(
      "alibaba-wan-lora shot " + input.shot_id + ": duration snapped " + requestedDuration +
      "s -> " + snappedDuration + "s (endpoint allows " + JSON.stringify([...ALLOWED_DURATIONS]) + ")",
    );
  }
  try {
    const r = await fetch(endpoint(route) + "/run", {
      method: "POST",
      headers: { ...auth(route), "content-type": "application/json" },
      body: JSON.stringify(buildWanLoraBody(input, req.config)),
    });
    if (!r.ok) return { ok: false, error: "alibaba-wan-lora /run -> " + r.status };
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return { ok: false, error: "alibaba-wan-lora /run returned no job id" };
    const submittedAt = Date.now();
    await recordRunpodJob(env.TELEMETRY_DB, { jobId, module: MANIFEST.name, outcome: "submitted", submittedAtMs: submittedAt });
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, project: req.context.project, shotId: input.shot_id, seconds: clampDuration(input.seconds), submittedAt }),
      jobId,  // cf#289/#296: RunPod cannot enumerate jobs; an id the caller is not handed at submit is unreachable forever.
    };
  } catch (e) {
    return { ok: false, error: "alibaba-wan-lora submit failed: " + (e as Error).message };
  }
}

/** /poll: check the RunPod job; on completion download the clip + store it in R2 and return output.
 *  The provider video_url expires in 7 days, so we persist to R2 here and return ONLY the R2 key. */
async function poll(env: Env, body: PollRequest): Promise<PollResponse<MotionBackendOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "alibaba-wan-lora: bad poll token" };
  const route = await runpodRoute(env);
  if (!route.credential) return { ok: false, error: "alibaba-wan-lora: " + runpodCredentialName(route) + " not configured" };

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
    return { ok: true, pending: true }; // transient; poll again
  }
  // RunPod GC'd the job (HTTP 404 / "job not found"): the numeric 404 status would otherwise read as
  // "not COMPLETED" and the poll would report pending forever (issue #141). We download + write R2
  // only on COMPLETED, so a never-completed job has no recoverable artifact: past the grace window
  // (or a legacy token) fail the shot; inside it keep polling (post-submit race).
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
      return { ok: false, error: "alibaba-wan-lora job not found on RunPod (GC'd or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") {
    await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "failed", submittedAtMs: st.submittedAt, detail: JSON.stringify(s.error ?? s), errorType: parseRunpodErrorType(s.error) });
    return { ok: false, error: "alibaba-wan-lora job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
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
      return { ok: false, error: "alibaba-wan-lora backend error (job " + st.jobId + ", status stuck " + String(s.status ?? "unknown") + ", cancel issued): " + backendErr };
    }
    return { ok: true, pending: true }; // IN_QUEUE / IN_PROGRESS
  }

  // cf#279: the ENDPOINT completed. Recorded before the output is parsed, because whether
  // WE could use the output is a different fact and the chain response is what carries it.
  await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "completed", submittedAtMs: st.submittedAt });

  const url = extractVideoUrl(s.output);
  if (!url) return { ok: false, error: "alibaba-wan-lora output had no video url" };
  const cost = extractCost(s.output);
  if (cost !== null) console.log("alibaba-wan-lora shot " + st.shotId + " cost $" + cost.toFixed(4));
  // The provider video_url expires in 7 days -- download it NOW and store the durable copy in R2.
  let bytes: ArrayBuffer;
  try {
    const v = await fetch(url);
    if (!v.ok) return { ok: false, error: "fetch alibaba-wan-lora video -> " + v.status };
    bytes = await v.arrayBuffer();
  } catch (e) {
    return { ok: false, error: "download alibaba-wan-lora video failed: " + (e as Error).message };
  }
  const key = clipKey(st.project, st.shotId);
  try {
    await env.R2_RENDERS.put(key, bytes);
  } catch (e) {
    return { ok: false, error: "R2 put failed: " + (e as Error).message };
  }
  // Return the DURABLE R2 key, never the expiring provider URL.
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
      if (!body || typeof body.poll !== "string") {
        return json({ ok: false, error: "poll token required" } as PollResponse);
      }
      return json(await poll(env, body));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};

export { MANIFEST };
