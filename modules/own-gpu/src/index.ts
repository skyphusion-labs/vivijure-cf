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
  type TenantR2Config,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type MotionBackendInput,
  type MotionBackendOutput,
} from "./contract";
import { buildI2vBody, readOutput, encodePoll, decodePoll, runpodJobGone, classifyGoneState, workersStillCold, terminalErrorInOutput, RUNPOD_COLD_GRACE_MS } from "./i2v";
import { reconcileRunpodEndpointWorkersMax } from "@skyphusion-labs/vivijure-core/runpod-endpoint-reconcile";

import { recordRunpodJob, probeRunpodJobLog, parseRunpodErrorType, runpodWalkedPastOutcome } from "../../_shared/runpod-job-log";
import { planeRefusalReason, planeRefusalError, runpodRoute, runpodEndpointUrl, runpodHeaders, runpodCredentialProblem, type RunpodRoute } from "../../_shared/runpod-route";
import { withTenantR2Body } from "../../_shared/tenant-r2-body";
import { takeTenantR2 } from "@skyphusion-labs/vivijure-core/modules/tenant-r2";

interface Env {
  RUNPOD_API_KEY: SecretsStoreSecret;
  /** cf#394 / cp#288: the plane-side RunPod proxy. Bound (plain_text) only for shared hosted
   *  tenants; unbound everywhere else, which is the untouched direct path. See
   *  modules/_shared/runpod-route.ts -- the branch is BOUND-ness, never failover. */
  RUNPOD_PROXY_BASE?: string;
  /** cf#394 / cp#288: the per-tenant plane credential presented instead of a RunPod key. */
  RUNPOD_PROXY_TOKEN?: SecretsStoreSecret | string;
  RUNPOD_ENDPOINT_ID: SecretsStoreSecret;
  /** Expected workersMax for idle reconcile (cf#61). Plain-text module var. */
  RUNPOD_WORKERS_MAX?: string;
  /** cf#279 job log. OPTIONAL: a module deployed without it still works, and its absence
   *  warns rather than reading as a clean run (see modules/_shared/runpod-job-log.ts). */
  TELEMETRY_DB?: D1Database;
}

// Exported so the core's tier-drift guard (tests/quality-tier-drift.test.ts, issue #124) can assert
// this module's `quality` enum stays in lockstep with the core QUALITY_TIERS set.
export const MANIFEST: ModuleManifest = {
  // cp#270: this module submits to the vivijure-backend endpoint, which may be POOLED across
  // tenants, so it needs the tenant's per-job R2 credential on the invoke envelope. Declared on
  // the MANIFEST rather than decided in core: which modules ride a pooled endpoint is a property
  // of the module, and core must not branch on module identity.
  needs_tenant_r2: true,
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
const auth = (route: RunpodRoute) => runpodHeaders(route, MANIFEST.name);

/** Is the endpoint still in its virgin cold start (no worker has ever come up)? Best-effort: any
 *  transport/HTTP failure reads as "not cold" so the #141 verdict still fires. */
async function endpointStillCold(route: RunpodRoute, endpointId: string): Promise<boolean> {
  try {
    const r = await fetch(endpoint(route, endpointId) + "/health", { headers: auth(route) });
    if (!r.ok) return false;
    return workersStillCold(await r.json());
  } catch {
    return false;
  }
}

/** Best-effort cancel of a RunPod job we are about to fail: a hung-error job otherwise HOLDS the
 *  billed worker until someone cancels it by hand (F17 spend leak). Never throws; the honest
 *  failure below is the point, the cancel is damage control. */
async function cancelRunpodJobBestEffort(route: RunpodRoute, endpointId: string, jobId: string): Promise<void> {
  try {
    await fetch(endpoint(route, endpointId) + "/cancel/" + jobId, { method: "POST", headers: auth(route) });
  } catch {
    /* best-effort */
  }
}

const endpoint = (route: RunpodRoute, endpointId: string) => runpodEndpointUrl(route, endpointId);

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
async function runpodCreds(env: Env): Promise<{ route: RunpodRoute; apiKey: string; endpointId: string }> {
  const [route, apiKey, endpointId] = await Promise.all([
    runpodRoute(env),
    secretValue(env.RUNPOD_API_KEY),
    secretValue(env.RUNPOD_ENDPOINT_ID),
  ]);
  // apiKey is kept alongside the route for ONE caller: the workersMax reconcile, which
  // targets the RunPod MANAGEMENT API and is gated to the direct route. Nothing else
  // reads it -- the bearer on every render call comes off `route`.
  return { route, apiKey, endpointId };
}

/** cf#114: classify an absent RunPod credential HONESTLY.
 *  RUNPOD_ENDPOINT_ID is a plain_text binding written at module UPLOAD; RUNPOD_API_KEY is a secret
 *  written LATER (by installInvokeKey on the control plane). The two therefore arrive by different
 *  routes at different times, so endpoint-present + key-absent is diagnostic of PROPAGATION, not of
 *  misconfiguration, and saying "not configured" about it is a lie that sent a real tenant chasing a
 *  correctly-configured credential. Both absent stays a genuine "not configured".
 *  Returns null when both are readable. */
function credentialProblem(route: RunpodRoute, endpointId: string): string | null {
  return runpodCredentialProblem(route, Boolean(endpointId));
}

/** /invoke: validate, submit the i2v_clip job to our backend, return a poll token immediately. */
async function submit(
  env: Env,
  req: InvokeRequest<MotionBackendInput>,
  /** cp#270: the tenant's per-job R2 credential, already STRIPPED off the request at the handler
   *  boundary. Passed as a value rather than read off `req` here precisely so `req` no longer
   *  carries it by the time anything in this function can serialise it. */
  tenantR2: TenantR2Config | null,
): Promise<InvokeResponse<MotionBackendOutput>> {
  const input = req.input;
  if (!input || !input.prompt || !input.shot_id) {
    return { ok: false, error: "motion.backend: input needs shot_id and prompt" };
  }
  const { route, apiKey, endpointId } = await runpodCreds(env);
  const credProblem = credentialProblem(route, endpointId);
  if (credProblem) return { ok: false, error: "own-gpu: " + credProblem };
  const workersMax = Number(env.RUNPOD_WORKERS_MAX);
  // cf#394: NOT on the proxied route. This reconcile targets the RunPod MANAGEMENT API
  // (rest.runpod.io/v1), which the plane proxy does not carry, and endpoint capacity on a
  // shared pool is an operator property a tenant must neither set nor need. Skipped, not
  // failed: the render is unaffected and the pool is sized by whoever owns it.
  if (!route.proxied && Number.isFinite(workersMax) && workersMax > 0) {
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
    const r = await fetch(endpoint(route, endpointId) + "/run", {
      method: "POST",
      headers: { ...auth(route), "content-type": "application/json" },
      body: JSON.stringify(
        withTenantR2Body(buildI2vBody(input, req.config, req.context.project), tenantR2),
      ),
    });
    if (!r.ok) return { ok: false, error: "own-gpu /run -> " + r.status };
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return { ok: false, error: "own-gpu /run returned no job id" };
    // cf#279: RunPod cannot enumerate jobs, so an id not recorded at submit is unreachable
    // permanently -- and a failure RATE needs this denominator, not only the failures.
    const submittedAt = Date.now();
    await recordRunpodJob(env.TELEMETRY_DB, { jobId, module: MANIFEST.name, outcome: "submitted", submittedAtMs: submittedAt });
    return { ok: true, pending: true, poll: encodePoll({ jobId, project: req.context.project, shotId: input.shot_id, submittedAt }), jobId };  // cf#289/#296: RunPod cannot enumerate jobs, so a caller not handed the id at submit can never reach it.
  } catch (e) {
    return { ok: false, error: "own-gpu submit failed: " + (e as Error).message };
  }
}

/** /poll: check the RunPod job; on completion the backend has already stored the clip in R2, so we
 *  just surface the clip_key it reported. No download, no re-upload. */
async function poll(env: Env, body: PollRequest): Promise<PollResponse<MotionBackendOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "own-gpu: bad poll token" };
  const { route, endpointId } = await runpodCreds(env);
  const credProblem = credentialProblem(route, endpointId);
  if (credProblem) return { ok: false, error: "own-gpu: " + credProblem };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(endpoint(route, endpointId) + "/status/" + st.jobId, { headers: auth(route) });
    // cf#398: a plane-AUTHORED refusal is NOT an upstream status and must never read as
    // pending. Checked before the body is interpreted, so it does not rest on the refusal
    // body parsing. No header (direct route, a normal response, or a proxy 502 that could
    // not reach RunPod) leaves every branch below byte for byte unchanged.
    const refusal = planeRefusalReason(route, resp);
    if (refusal) return { ok: false, error: planeRefusalError(MANIFEST.name, refusal) };
    httpStatus = resp.status;
    s = (await resp.json()) as typeof s;
  } catch {
    // Transient transport: no honest wait signal; omit rather than invent accepted/running.
    return { ok: true, pending: true };
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
        (await endpointStillCold(route, endpointId))
      ) {
        return { ok: true, pending: true, wait: "accepted" };
      }
      await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "gone", submittedAtMs: st.submittedAt });
      return { ok: false, error: "own-gpu job not found on RunPod (GC'd or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true, wait: "accepted" }; // still inside the grace window
  }
  if (s.status === "FAILED") {
    await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "failed", submittedAtMs: st.submittedAt, detail: JSON.stringify(s.error ?? s), errorType: parseRunpodErrorType(s.error) });
    return { ok: false, error: "own-gpu job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  }
  // cf#298: CANCELLED and TIMED_OUT are TERMINAL, and the branch below treats every non-COMPLETED
  // status as "still running" -- so for those two no terminal write was ever ATTEMPTED and the row
  // stayed `submitted` permanently. That is a different bug from a terminal write being LOST, and a
  // write retry cannot touch it. Observed live on a keyframe job that ran to completion, wrote its
  // PNG to R2, and was booked CANCELLED by RunPod.
  //
  // RECORD ONLY. The render-path behaviour below is deliberately UNCHANGED: telemetry must never
  // gate the render path, and the live CANCELLED job above had already produced the artifact the
  // film went on to use, so failing a shot here would break a path that works today. What the chain
  // should DO about a terminal-cancelled job is a render-path question with its own evidence
  // requirement.
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
      await cancelRunpodJobBestEffort(route, endpointId, st.jobId);
      await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "backend-error", submittedAtMs: st.submittedAt, detail: backendErr, errorType: parseRunpodErrorType(s.output) });
      return { ok: false, error: "own-gpu backend error (job " + st.jobId + ", status stuck " + String(s.status ?? "unknown") + ", cancel issued): " + backendErr };
    }
    // cf#307: map RunPod queue vs running onto the backend-neutral wait field.
    const wait =
      s.status === "IN_QUEUE" || s.status === "SUBMITTED"
        ? ("accepted" as const)
        : s.status === "IN_PROGRESS"
          ? ("running" as const)
          : undefined;
    return wait ? { ok: true, pending: true, wait } : { ok: true, pending: true };
  }
  // cf#279: the ENDPOINT completed. Recorded before the output is parsed, because whether WE
  // could use the output is a different fact and the chain response is what carries it.
  await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "completed", submittedAtMs: st.submittedAt });

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
      const { route, endpointId } = await runpodCreds(env);
      return json({
        ok: Boolean(route.credential && endpointId),
        // Echoed so a prober can prove it reached the script it MEANT to reach (a tenant-prefixed
        // script name is easy to get wrong); already public in /module.json, so it leaks nothing.
        module: MANIFEST.name,
        credentials: { runpod_api_key: Boolean(route.credential), runpod_endpoint_id: Boolean(endpointId) },
        // cf#394: which route answered. Additive -- the plane parses runpod_api_key and
        // refuses a module whose /ready omits it, so that field keeps its name.
        runpod_proxied: route.proxied,
        // cf#279: is this worker able to RECORD a job outcome at all? Reported here because
        // otherwise an empty job log is indistinguishable from a clean run, which is the exact
        // failure shape the log exists to end. Deliberately NOT part of `ok`: the job log is
        // telemetry and a module without it still renders.
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
      // cp#270: STRIP AT THE BOUNDARY. Reads the tenant credential and REMOVES it from `req` in
      // one call, so nothing below this line holds an object that still contains it -- the
      // mirror of the backend's `strip_from_payload`. Done here, at the parse boundary, rather
      // than inside submit(): the guarantee is about the REQUEST object, and every line after
      // this one should be unable to leak it even by accident.
      const tenantR2 = takeTenantR2(req);
      if (req.hook !== "motion.backend") {
        return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
      }
      return json(await submit(env, req, tenantR2));
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
