// keyframe: a `keyframe` module worker (vivijure-module/2). Drives the vivijure-backend GPU render
// endpoint on RunPod in its keyframes-only mode (action=preview) to turn a project's storyboard into
// start keyframes -- the upstream stage the motion.backend orchestrator animates. Async like the
// other GPU modules: GET /module.json, POST /invoke (submit -> poll token), POST /poll (check
// GET /status, return the keyframe keys on completion). PROJECT-level: one job emits every shot's
// keyframe, reusing trained cast LoRAs -- never a per-shot job (that would re-train = GPU waste).
//
// The backend writes the keyframe PNGs to the shared `vivijure` R2 bucket itself (its own creds), so
// this module does no R2 I/O -- it just reports the keys; the core presigns them for the next stage.
// Failures are DATA (ok:false), never thrown across the wire.

import {
  MODULE_API,
  type ModuleManifest,
  type TenantR2Config,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type CancelRequest,
  type CancelResponse,
  type KeyframeInput,
  type KeyframeOutput,
} from "./contract";
import { buildPreviewBody, parseKeyframes, parseTrainedLoras, encodePoll, decodePoll, runpodJobGone, classifyGoneState, workersStillCold, terminalErrorInOutput, RUNPOD_COLD_GRACE_MS } from "./keyframe";
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
  // The vivijure-backend RunPod endpoint id. A SECRET (not hardcoded) so the public repo never
  // exposes the specific endpoint -- same rule as push-secrets.sh (#38).
  RUNPOD_ENDPOINT_ID: SecretsStoreSecret;
  RUNPOD_WORKERS_MAX?: string;
  /** cf#279 job log. OPTIONAL: a module deployed without it still works, and its absence
   *  warns rather than reading as a clean run (see modules/_shared/runpod-job-log.ts). */
  TELEMETRY_DB?: D1Database;
}

const endpoint = (route: RunpodRoute, endpointId: string) => runpodEndpointUrl(route, endpointId);
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

// Exported so the core's tier-drift guard (tests/quality-tier-drift.test.ts, issue #124) can assert
// this module's quality_tier enum stays in lockstep with the core QUALITY_TIERS set.
export const MANIFEST: ModuleManifest = {
  name: "keyframe",
  version: "0.3.1",
  api: MODULE_API,
  hooks: ["keyframe"],
  provides: [{ id: "gpu-keyframe", label: "GPU Keyframe (SDXL on RunPod)" }],
  config_schema: {
    quality_tier: {
      type: "enum",
      values: ["draft", "standard", "final"],
      default: "final",
      label: "quality tier",
    },
    // Default to a 16:9 landscape keyframe (SDXL-friendly 1344x768). Image-to-video backends conform
    // the clip to the KEYFRAME's aspect ratio (they ignore an aspect_ratio param once given an input
    // image), so a square keyframe forced square clips that the assembler then pillarboxed into 16:9
    // with black bars. A 16:9 keyframe makes the whole chain 16:9. Override via keyframe_config for
    // portrait/square. (fixes the square showcase clips)
    width: { type: "int", default: 1344, min: 512, max: 1536, label: "width" },
    height: { type: "int", default: 768, min: 512, max: 1536, label: "height" },
    steps: { type: "int", default: 30, min: 1, max: 60, label: "diffusion steps" },
    guidance_scale: { type: "float", default: 6.5, min: 0, max: 20, label: "guidance scale" },
    seed: { type: "int", default: -1, min: -1, label: "seed (-1 = random)" },
    // cf#299: expose InstantID on the studio door. Backend default is ip_adapter;
    // "instantid" selects the insightface face path (proven on vivijure-backend).
    identity_method: {
      type: "enum",
      values: ["ip_adapter", "instantid"],
      default: "ip_adapter",
      label: "face identity method",
    },
  },
  ui: { section: "keyframe", order: 10 },
  // This module is async + GPU-backed, so it implements POST /cancel: the core can stop an in-flight
  // RunPod job (a cancelled render, or an adopted keyframe phase) instead of orphaning it (#327/#328).
  cancelable: true,
  // #454: compact display token for the keyframe-stage backend, so the planner projects it inline
  // instead of hardcoding "SDXL". OPTIONAL/additive, mirrors src/modules/types.ts.
  keyframe_label: "SDXL",
  // cp#270: this module submits to the vivijure-backend endpoint, which may be POOLED across
  // tenants, so it needs the tenant's per-job R2 credential on the invoke envelope. Declared on
  // the MANIFEST rather than decided in core: which modules ride a pooled endpoint is a property
  // of the module, and core must not branch on module identity.
  needs_tenant_r2: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

async function submit(
  env: Env,
  req: InvokeRequest<KeyframeInput>,
  /** cp#270: the tenant's per-job R2 credential, already STRIPPED off the request at the handler
   *  boundary. Passed as a value rather than read off `req` here precisely so `req` no longer
   *  carries it by the time anything in this function can serialise it. */
  tenantR2: TenantR2Config | null,
): Promise<InvokeResponse<KeyframeOutput>> {
  const input = req.input;
  if (!input || !input.project || !input.bundle_key) {
    return { ok: false, error: "keyframe: input needs project and bundle_key" };
  }
  const { route, apiKey, endpointId } = await runpodCreds(env);
  const credProblem = credentialProblem(route, endpointId);
  if (credProblem) {
    return { ok: false, error: "keyframe: " + credProblem };
  }
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
      return { ok: false, error: "keyframe: " + msg };
    }
  }
  try {
    const r = await fetch(endpoint(route, endpointId) + "/run", {
      method: "POST",
      headers: { ...auth(route), "content-type": "application/json" },
      body: JSON.stringify(withTenantR2Body(buildPreviewBody(input, req.config), tenantR2)),
    });
    if (!r.ok) return { ok: false, error: "keyframe /run -> " + r.status };
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return { ok: false, error: "keyframe /run returned no job id" };
    // cf#279: RunPod cannot enumerate jobs, so an id not recorded at submit is unreachable
    // permanently -- and a failure RATE needs this denominator, not only the failures.
    const submittedAt = Date.now();
    await recordRunpodJob(env.TELEMETRY_DB, { jobId, module: MANIFEST.name, outcome: "submitted", submittedAtMs: submittedAt });
    return { ok: true, pending: true, poll: encodePoll({ jobId, project: input.project, submittedAt }), jobId };  // jobId (#318): lets the core read this RunPod job's keyframe_done snapshot
  } catch (e) {
    return { ok: false, error: "keyframe submit failed: " + (e as Error).message };
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<KeyframeOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "keyframe: bad poll token" };
  const { route, endpointId } = await runpodCreds(env);
  const credProblem = credentialProblem(route, endpointId);
  if (credProblem) {
    return { ok: false, error: "keyframe: " + credProblem };
  }

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
    return { ok: true, pending: true }; // transient; caller polls again
  }
  // RunPod GC'd the job (HTTP 404 / "job not found"): the numeric 404 status would otherwise read as
  // "not COMPLETED" and the poll would report pending forever (issue #141). Past the grace window (or a
  // legacy token) fail; inside it keep polling (post-submit race).
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
        return { ok: true, pending: true };
      }
      await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "gone", submittedAtMs: st.submittedAt });
      return { ok: false, error: "keyframe job " + st.jobId + " not found on RunPod (GC'd or never ran); failing (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") {
    await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "failed", submittedAtMs: st.submittedAt, detail: JSON.stringify(s.error ?? s), errorType: parseRunpodErrorType(s.error) });
    return { ok: false, error: "keyframe job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
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
      return { ok: false, error: "keyframe backend error (job " + st.jobId + ", status stuck " + String(s.status ?? "unknown") + ", cancel issued): " + backendErr };
    }
    return { ok: true, pending: true };
  }
  // cf#279: the ENDPOINT completed. Recorded before the output is parsed, because whether WE
  // could use the output is a different fact and the chain response is what carries it.
  await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "completed", submittedAtMs: st.submittedAt });

  const keyframes = parseKeyframes(s.output);
  if (!keyframes.length) return { ok: false, error: "keyframe job completed but returned no keyframes" };
  const trained_loras = parseTrainedLoras(s.output);
  return {
    ok: true,
    output: {
      project: st.project,
      keyframes,
      ...(Object.keys(trained_loras).length ? { trained_loras } : {}),
    },
  };
}

// Stop the in-flight RunPod job named by this poll token. RunPod's cancel is POST /v2/<id>/cancel/<job>.
// Idempotent by contract: a 200 (cancelled) and a 404 (job already GC'd / terminal) both mean the job is
// NOT running on our account, so both report ok:true. Any other status is surfaced as ok:false so the
// core degrade-logs the orphan rather than assuming it stopped. Failures are DATA, never thrown.
async function cancel(env: Env, body: CancelRequest): Promise<CancelResponse> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "keyframe: bad poll token" };
  const { route, endpointId } = await runpodCreds(env);
  const credProblem = credentialProblem(route, endpointId);
  if (credProblem) {
    return { ok: false, error: "keyframe: " + credProblem };
  }
  try {
    const resp = await fetch(endpoint(route, endpointId) + "/cancel/" + st.jobId, { method: "POST", headers: auth(route) });
    if (resp.ok || resp.status === 404) return { ok: true };
    return { ok: false, error: "keyframe /cancel -> " + resp.status };
  } catch (e) {
    return { ok: false, error: "keyframe cancel failed: " + (e as Error).message };
  }
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
      let req: InvokeRequest<KeyframeInput>;
      try {
        req = (await request.json()) as InvokeRequest<KeyframeInput>;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as InvokeResponse);
      }
      // cp#270: STRIP AT THE BOUNDARY. Reads the tenant credential and REMOVES it from `req` in
      // one call, so nothing below this line holds an object that still contains it -- the
      // mirror of the backend's `strip_from_payload`. Done here, at the parse boundary, rather
      // than inside submit(): the guarantee is about the REQUEST object, and every line after
      // this one should be unable to leak it even by accident.
      const tenantR2 = takeTenantR2(req);
      if (req.hook !== "keyframe") {
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
      if (!body || typeof body.poll !== "string") return json({ ok: false, error: "poll token required" } as PollResponse);
      return json(await poll(env, body));
    }
    if (request.method === "POST" && url.pathname === "/cancel") {
      let body: CancelRequest;
      try {
        body = (await request.json()) as CancelRequest;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as CancelResponse);
      }
      if (!body || typeof body.poll !== "string") return json({ ok: false, error: "poll token required" } as CancelResponse);
      return json(await cancel(env, body));
    }
    return json({ ok: false, error: "not found" }, 404);
  },
};
