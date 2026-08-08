// finish-blender: a finish module worker (vivijure-module/2). Blender headless compositor (grade presets),
// dispatched to the dedicated vivijure-blender RunPod endpoint (CUDA; separate from vivijure-backend).
//
// ASYNC: compositor can exceed a Worker request budget:
//   GET  /module.json -> manifest
//   POST /invoke      -> submit to RunPod, return { ok, pending, poll } immediately
//   POST /poll        -> check job status; return output on completion
//
// R2 transport: the endpoint reads `clip_key` and writes `output_key` in the shared bucket itself
// (exactly as vivijure-backend does for finish-rife), so this worker holds no R2 creds.
//
// Failures are DATA, never an exception across the wire. For a chain hook the soft degrade (pass the
// input clip through unchanged, but RECORDED) is preferred over a hard ok:false unless the job cannot
// be submitted at all.

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
  runpodJobGone, classifyGoneState, workersStillCold, terminalErrorInOutput, RUNPOD_COLD_GRACE_MS,
} from "./finish";
import { reconcileRunpodEndpointWorkersMax } from "@skyphusion-labs/vivijure-core/runpod-endpoint-reconcile";

import { recordRunpodJob, probeRunpodJobLog, parseRunpodErrorType, runpodWalkedPastOutcome, timingFromStatus } from "../../_shared/runpod-job-log";
import { planeRefusalReason, planeRefusalError, runpodRoute, runpodEndpointUrl, runpodHeaders, runpodCredentialProblem, type RunpodRoute } from "../../_shared/runpod-route";
import { doorRoute, doorBound, doorProblem, doorHeaders, doorUrl, tokenTookDoor, DOOR_ROUTE_NAME, type DoorBinding, type DoorRoute } from "../../_shared/finish-door";

interface Env {
  RUNPOD_API_KEY: SecretsStoreSecret;
  /** cf#394 / cp#288: the plane-side RunPod proxy. Bound (plain_text) only for shared hosted
   *  tenants; unbound everywhere else, which is the untouched direct path. See
   *  modules/_shared/runpod-route.ts -- the branch is BOUND-ness, never failover. */
  RUNPOD_PROXY_BASE?: string;
  /** cf#394 / cp#288: the per-tenant plane credential presented instead of a RunPod key. */
  RUNPOD_PROXY_TOKEN?: SecretsStoreSecret | string;
  RUNPOD_ENDPOINT_ID: SecretsStoreSecret;
  RUNPOD_WORKERS_MAX?: string;
  /** cf#489: the always-on blender door on our own iron, over a Workers VPC service. UNBOUND is
   *  the normal state and leaves the RunPod path untouched byte for byte. The branch is
   *  BOUND-ness, never a RunPod failure: see modules/_shared/finish-door.ts. */
  FINISH_BLENDER_VPC?: DoorBinding;
  /** cf#489: the door bearer (LOCAL_FINISH_TOKEN on the container). Only read when the binding
   *  above is present. Named from the class rather than by analogy: finish-upscale uses
   *  FINISH_DOOR_TOKEN and speech-upscale uses SPEECH_DOOR_TOKEN. */
  BLENDER_DOOR_TOKEN?: SecretsStoreSecret | string;
  /** cf#279 job log. OPTIONAL: a module deployed without it still works, and its absence
   *  warns rather than reading as a clean run (see modules/_shared/runpod-job-log.ts). */
  TELEMETRY_DB?: D1Database;
}

const MANIFEST: ModuleManifest = {
  name: "finish-blender",
  version: "0.1.0",
  api: MODULE_API,
  hooks: ["finish"],
  provides: [
    { id: "blender-grade", label: "Color grade (Blender compositor)" },
  ],
  config_schema: {
    job_type: { type: "enum", values: ["grade", "composite"], default: "grade", label: "job" },
    preset: {
      type: "enum",
      values: ["neutral", "filmic_warm", "high_contrast", "cool", "soft"],
      default: "filmic_warm",
      label: "grade preset",
    },
    strength: { type: "float", default: 1, min: 0, max: 2, label: "preset strength" },
  },
  // After lipsync (15), before upscale (20): grade at native resolution.
  ui: { section: "finish", icon: "palette", order: 18 },
  finish_artifacts: {
    output_key: { kind: "append_suffix", suffix: "_bl" },
    applied: [{ tag: "blender:{job_type|grade}:{preset|filmic_warm}" }],
  },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function runpodBase(route: RunpodRoute, endpointId: string): string {
  return runpodEndpointUrl(route, endpointId);
}

function auth(route: RunpodRoute) {
  return runpodHeaders(route, MANIFEST.name);
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

/** cf#489. ONE transport interface over two wire-identical services, so submit and poll have a
 *  single body rather than two that drift. The door runs the SAME image as the RunPod endpoint,
 *  behind a serve overlay, so /run, /status/<id> and /cancel/<id> carry the same envelopes.
 *
 *  The RunPod arm is deliberately a pure re-expression of the calls that were already here: same
 *  URL, same headers, same method. If it is not, that is a regression in the untouched path. */
interface Transport {
  /** True only on our own iron. */
  door: boolean;
  /** Recorded into the poll token; empty on the RunPod arm. */
  name: string;
  call(path: string, init?: RequestInit): Promise<Response>;
}

function runpodTransport(route: RunpodRoute, endpointId: string): Transport {
  return {
    door: false,
    name: "",
    call: (path, init) => fetch(runpodBase(route, endpointId) + path, {
      ...init,
      headers: { ...auth(route), ...(init?.headers as Record<string, string> | undefined) },
    }),
  };
}

function doorTransport(route: DoorRoute): Transport {
  return {
    door: true,
    name: DOOR_ROUTE_NAME,
    call: (path, init) => route.binding!.fetch(doorUrl(path), {
      ...init,
      headers: { ...doorHeaders(route, MANIFEST.name), ...(init?.headers as Record<string, string> | undefined) },
    }),
  };
}

/** Resolve the on-iron door route once per request (cf#489). */
async function doorFor(env: Env): Promise<DoorRoute> {
  if (!env.FINISH_BLENDER_VPC) return doorRoute(null, "");
  return doorRoute(env.FINISH_BLENDER_VPC, await secretValue(env.BLENDER_DOOR_TOKEN));
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

/** cf#114, degrade side of credentialProblem: the same propagation-vs-misconfiguration distinction,
 *  expressed as a machine-readable degrade REASON. A polish step never fails the chain, but it must
 *  still say WHICH of the two it hit -- "no-runpod-secrets" on a key that is merely not visible yet
 *  reads as an operator error that does not exist. Returns null when both are readable. */
function credentialDegradeReason(route: RunpodRoute, endpointId: string): string | null {
  if (route.credential && endpointId) return null;
  return endpointId ? "runpod-key-not-yet-visible" : "no-runpod-secrets";
}

/** Is the endpoint still in its virgin cold start (no worker has ever come up)? Best-effort: any
 *  transport/HTTP failure reads as "not cold" so the #141 verdict still fires. */
async function endpointStillCold(t: Transport): Promise<boolean> {
  // cf#489: not a door concept. The door is an ALWAYS-ON resident container, so there is no
  // virgin cold start to tolerate and its /health answers a liveness question rather than a
  // worker-pool one. Returning false keeps the #141 verdict firing on the door route, which is
  // correct: a door that has lost a job really has lost it.
  if (t.door) return false;
  try {
    const r = await t.call("/health");
    if (!r.ok) return false;
    return workersStillCold(await r.json());
  } catch {
    return false;
  }
}

/** Best-effort cancel of a RunPod job we are about to fail: a hung-error job otherwise HOLDS the
 *  billed worker until someone cancels it by hand (F17 spend leak). Never throws; the honest
 *  failure below is the point, the cancel is damage control. */
async function cancelRunpodJobBestEffort(t: Transport, jobId: string): Promise<void> {
  try {
    // The door serves /cancel/<id> too (runpod_http_serve.py), so this is not RunPod-only.
    await t.call("/cancel/" + jobId, { method: "POST" });
  } catch {
    /* best-effort */
  }
}


/** Soft degrade: pass the input clip through unchanged (a no-op beats a crash in a chain), but ALWAYS
 *  record why -- `passthroughOutput` tags `applied` and sets `degraded`, so a real misconfig/backend
 *  failure is never indistinguishable from a legitimate no-op (#77). A real degrade is also warned. */
function passthrough(
  input: FinishInput,
  reason: string,
  opts: { degraded?: boolean; detail?: string } = {},
): InvokeResponse<FinishOutput> {
  const output = passthroughOutput(input, reason, opts);
  if (output.degraded) console.warn(`finish-blender: passthrough (${output.degraded}) shot=${input.shot_id}`);
  return { ok: true, output };
}

async function submit(env: Env, req: InvokeRequest<FinishInput>): Promise<InvokeResponse<FinishOutput>> {
  const input = req.input;
  if (!input?.shot_id || !input?.clip_key) {
    return { ok: false, error: "finish-blender: input needs shot_id and clip_key" };
  }

  // cf#489: our own always-on iron first, and ONLY on bound-ness. RunPod is not consulted, not
  // probed and not billed when the binding is present -- there is no failover, by design, because
  // a failover would quietly restore the rented dependency this exists to remove while every
  // signal stayed green (same rule as the plane proxy, cp#321).
  //
  // Here a failover would also HANG rather than merely cost money: the blender RunPod endpoint is
  // parked at workersMax 0 as the rollback, so a job sent there would sit IN_QUEUE with no worker
  // to take it. And unlike its polish-step siblings this module does NOT soft-degrade a failure
  // into the chain -- a failed blender job fails the whole film -- so a silent second path is
  // exactly the wrong thing to have.
  const door = await doorFor(env);
  if (doorBound(door)) {
    const problem = doorProblem(door);
    // Bound binding, token not visible yet: propagation, not misconfiguration (the cf#114
    // distinction applied to the door credential). Degrade and SAY WHICH.
    if (problem) return passthrough(input, problem);
    return submitVia(env, req, doorTransport(door));
  }

  const { route, apiKey, endpointId } = await runpodCreds(env);
  if (!route.credential || !endpointId) {
    // Degrade, but say WHICH: absent-key-with-endpoint is propagation, not misconfiguration (cf#114).
    return passthrough(input, credentialDegradeReason(route, endpointId) ?? "no-runpod-secrets");
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
      const msg = rec.guidance ? rec.error + ". " + rec.guidance : rec.error;
      return { ok: false, error: "finish-blender: " + msg };
    }
  }

  return submitVia(env, req, runpodTransport(route, endpointId));
}

/** The submit body, shared by both transports. Everything here was the RunPod path verbatim; the
 *  only additions are the route label on the poll token and the degrade reasons naming WHICH
 *  service answered, because runpod-run-failed on a job that never touched RunPod is exactly the
 *  kind of lie that sends an operator to the wrong dashboard. */
async function submitVia(
  env: Env,
  req: InvokeRequest<FinishInput>,
  t: Transport,
): Promise<InvokeResponse<FinishOutput>> {
  const input = req.input;
  const cfg = coerceConfig(req.config);
  const where = t.door ? "door" : "runpod";
  try {
    const r = await t.call("/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildRunPodBody(input, cfg, req.context.project)),
    });
    if (!r.ok) return passthrough(input, where + "-run-failed", { detail: "HTTP " + r.status });
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return passthrough(input, "no-jobid");
    // cf#279: neither service can enumerate jobs, so an id not recorded at submit is unreachable
    // permanently -- and a failure RATE needs this denominator, not only the failures.
    const submittedAt = Date.now();
    await recordRunpodJob(env.TELEMETRY_DB, { jobId, module: MANIFEST.name, outcome: "submitted", submittedAtMs: submittedAt });
    return {
      ok: true,
      pending: true,
      poll: encodePoll({
        jobId, shotId: input.shot_id, srcFps: input.src_fps ?? 24, frames: input.frames ?? 0, submittedAt,
        // cf#489 affinity. Undefined on the RunPod arm, which is what every pre-existing token
        // carries, so old tokens and RunPod tokens stay the same object.
        door: t.name || undefined,
      }),
      jobId,  // cf#289/#296: neither service can enumerate jobs, so a caller not handed the id at submit can never reach it.
    };
  } catch (e) {
    return passthrough(input, "exception", { detail: (e as Error).message });
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<FinishOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "finish-blender: bad poll token" };
  // cf#489. The transport is decided by the TOKEN, not by what is bound right now. Polling the
  // other service would 404 (a door job id is a uuid4 from a per-process registry; a RunPod job
  // id is unknown to the door), runpodJobGone would read that as a GC job, and past the grace
  // window the shot would FAIL -- destroying finished work with every component behaving
  // correctly.
  let t: Transport;
  let route: RunpodRoute | null = null;
  if (tokenTookDoor(st.door)) {
    const door = await doorFor(env);
    if (!doorBound(door)) {
      // The binding was removed while this job was in flight. Refusing to guess is the only
      // honest answer: a poll against RunPod would 404 and fail the shot, and this poll token
      // carries shotId/srcFps/frames but NOT clip_key, so a poll-time passthrough cannot
      // reconstruct the clip it would be passing through.
      //
      // This costs MORE here than in the polish modules, because this one fails the film rather
      // than degrading a step. That is an argument for not unbinding mid-render, not for
      // guessing: a wrong guess destroys finished work while every component reports success.
      return { ok: false, error: "finish-blender: door binding removed while job " + st.jobId + " was in flight; cannot poll (cf#489)" };
    }
    const problem = doorProblem(door);
    if (problem) return { ok: false, error: "finish-blender: " + problem };
    t = doorTransport(door);
  } else {
    const creds = await runpodCreds(env);
    const credProblem = credentialProblem(creds.route, creds.endpointId);
    if (credProblem) return { ok: false, error: "finish-blender: " + credProblem };
    route = creds.route;
    t = runpodTransport(creds.route, creds.endpointId);
  }

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await t.call("/status/" + st.jobId);
    // cf#398: a plane-AUTHORED refusal is NOT an upstream status and must never read as
    // pending. Checked before the body is interpreted, so it does not rest on the refusal
    // body parsing. No header (direct route, a normal response, or a proxy 502 that could
    // not reach RunPod) leaves every branch below byte for byte unchanged.
    // Only meaningful on the RunPod arm: the refusal header is authored by the PLANE proxy,
    // which is not in the door path at all. route is non-null exactly when that arm was taken.
    const refusal = route ? planeRefusalReason(route, resp) : null;
    if (refusal) return { ok: false, error: planeRefusalError(MANIFEST.name, refusal) };
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
        (await endpointStillCold(t))
      ) {
        return { ok: true, pending: true };
      }
      await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "gone", submittedAtMs: st.submittedAt });
      return { ok: false, error: "finish-blender job not found on RunPod (GC'd or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") {
    await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "failed", submittedAtMs: st.submittedAt, detail: JSON.stringify(s.error ?? s), errorType: parseRunpodErrorType(s.error), ...timingFromStatus(s) });
    return { ok: false, error: "finish-blender job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
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
    await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: walkedPast, submittedAtMs: st.submittedAt, detail: "runpod status " + String(s.status ?? "unknown"), errorType: parseRunpodErrorType(s.error), ...timingFromStatus(s) });
  }
  if (s.status !== "COMPLETED") {
    // F17: a backend whose error path RETURNS (instead of raising) leaves the RunPod job IN_PROGRESS
    // forever -- holding and billing the worker -- while `output` already carries the structured
    // terminal error. Surface the REAL error (never "not found") and cancel to stop the spend.
    const backendErr = terminalErrorInOutput(s.output);
    if (backendErr) {
      await cancelRunpodJobBestEffort(t, st.jobId);
      await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "backend-error", submittedAtMs: st.submittedAt, detail: backendErr, errorType: parseRunpodErrorType(s.output), ...timingFromStatus(s) });
      return { ok: false, error: "finish-blender backend error (job " + st.jobId + ", status stuck " + String(s.status ?? "unknown") + ", cancel issued): " + backendErr };
    }
    return { ok: true, pending: true };
  }
  // cf#279: the ENDPOINT completed. Recorded before the output is parsed, because whether WE
  // could use the output is a different fact and the chain response is what carries it.
  await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "completed", submittedAtMs: st.submittedAt, ...timingFromStatus(s) });

  const out = parseBackendOutput(s.output);
  if (!out?.clip_key) return { ok: false, error: "finish-blender: backend returned no clip_key" };
  return {
    ok: true,
    output: {
      shot_id: out.shot_id ?? st.shotId,
      clip_key: out.clip_key,
      out_fps: out.out_fps ?? st.srcFps,
      frames: out.frames ?? st.frames,
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
