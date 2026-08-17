// finish-lipsync: a finish module worker (vivijure-module/2). MuseTalk audio-driven lip-sync,
// dispatched to the dedicated vivijure-musetalk RunPod endpoint (cu128; separate from vivijure-backend).
// Rewrites a shot's mouth to match its dialogue audio -- the "talking characters" finish stage.
//
// ASYNC: GPU lip-sync runs frame-by-frame and exceeds a Worker request budget:
//   GET  /module.json -> manifest
//   POST /invoke      -> submit to RunPod, return { ok, pending, poll } immediately
//   POST /poll        -> check job status; return output on completion
//
// R2 transport (cf#312): prefer credentialless presigned mode when the core hands video_url +
// audio_url + output_url (no endpoint R2 env; poolable). Fall back to shared-bucket R2 mode
// (clip_key + audio_key + output_key) when those URLs are absent.
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
  coerceConfig, buildRunPodBody, encodePoll, decodePoll, parseBackendOutput, finishedKey, passthroughOutput,
  type PollState,
  runpodJobGone, classifyGoneState, workersStillCold, terminalErrorInOutput, RUNPOD_COLD_GRACE_MS,
} from "./lipsync";
import { reconcileRunpodEndpointWorkersMax } from "@skyphusion-labs/vivijure-core/runpod-endpoint-reconcile";

import { recordRunpodJob, probeRunpodJobLog, parseRunpodErrorType, runpodWalkedPastOutcome, timingFromStatus } from "../../_shared/runpod-job-log";
import { planeRefusalReason, planeRefusalError, runpodRoute, runpodEndpointUrl, runpodHeaders, runpodCredentialProblem, type RunpodRoute } from "../../_shared/runpod-route";
// cf#594: the poll-path soft-degrade contract, now shared by all four finish modules. This module is
// where it was written; it is no longer where it lives.
import { softDegradeInFailedEnvelope, softDegradeInCompletedOutput, csamRefusalInCompletedOutput, BACKEND_SOFT_DEGRADE } from "../../_shared/finish-soft-degrade";

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
  /** cf#279 job log. OPTIONAL: a module deployed without it still works, and its absence
   *  warns rather than reading as a clean run (see modules/_shared/runpod-job-log.ts). */
  TELEMETRY_DB?: D1Database;
}

export const MANIFEST: ModuleManifest = {
  name: "finish-lipsync",
  version: "0.2.1",
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
  // Homelab / self-host only. Hosted flagship does not bind this module.
  // Native AV already talks. MuseTalk is replace-mouth (planner checkbox).
  participation: "opt_in",
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
async function endpointStillCold(route: RunpodRoute, endpointId: string): Promise<boolean> {
  try {
    const r = await fetch(runpodBase(route, endpointId) + "/health", { headers: auth(route) });
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
    await fetch(runpodBase(route, endpointId) + "/cancel/" + jobId, { method: "POST", headers: auth(route) });
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

/** cf#578 POLL-TIME SOFT DEGRADE, the same decision speech-upscale already makes at its poll site.
 *
 *  A finish step is POLISH. When the endpoint completes but yields no artifact, the honest answer is
 *  the input clip passed through with the reason RECORDED, not a chain failure: an `ok:false` here
 *  routes to the chain failure path and never reaches the degrade accounting, so the whole class is
 *  invisible in telemetry. Only MALFORMED I/O fails loud.
 *
 *  cf#594 CORRECTION to the note that stood here. This module has carried `clipKey` in its poll
 *  token since it shipped, but `decodePoll` resolves a token WITHOUT one to the empty string
 *  (lipsync.ts, `clipKey: typeof o.clipKey === "string" ? o.clipKey : ""`), so a degrade on such a
 *  token built a passthrough with an EMPTY clip_key and returned ok:true. That hands the chain an
 *  artifact reference that resolves to nothing, which is the silent-degrade shape of #77 wearing a
 *  success. It therefore takes the same null-on-no-clip guard as its finish-upscale sibling, and
 *  the four finish modules now answer this identically.
 */
function pollPassthrough(st: PollState, reason: string, detail?: string): PollResponse<FinishOutput> | null {
  if (!st.clipKey) return null;
  console.warn(`finish-lipsync: poll passthrough (${reason}) shot=${st.shotId}`);
  return {
    ok: true,
    output: passthroughOutput(
      { shot_id: st.shotId, clip_key: st.clipKey, src_fps: st.srcFps, frames: st.frames },
      reason,
      detail ? { detail } : {},
    ),
  };
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
      const msg = rec.guidance ? `${rec.error}. ${rec.guidance}` : rec.error;
      return { ok: false, error: "finish-lipsync: " + msg };
    }
  }

  const cfg = coerceConfig(req.config);
  try {
    const r = await fetch(runpodBase(route, endpointId) + "/run", {
      method: "POST",
      headers: { ...auth(route), "content-type": "application/json" },
      body: JSON.stringify(buildRunPodBody(input, cfg, req.context.project)),
    });
    if (!r.ok) return passthrough(input, "runpod-run-failed", { detail: "HTTP " + r.status });
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return passthrough(input, "no-jobid");
    // cf#279: RunPod cannot enumerate jobs, so an id not recorded at submit is unreachable
    // permanently -- and a failure RATE needs this denominator, not only the failures.
    const submittedAt = Date.now();
    await recordRunpodJob(env.TELEMETRY_DB, { jobId, module: MANIFEST.name, outcome: "submitted", submittedAtMs: submittedAt });
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, shotId: input.shot_id, clipKey: input.clip_key, srcFps: input.src_fps ?? 24, frames: input.frames ?? 0, submittedAt }),
      jobId,  // cf#289/#296: RunPod cannot enumerate jobs, so a caller that is not handed the id at submit can never reach it.
    };
  } catch (e) {
    return passthrough(input, "exception", { detail: (e as Error).message });
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<FinishOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "finish-lipsync: bad poll token" };
  const { route, endpointId } = await runpodCreds(env);
  const credProblem = credentialProblem(route, endpointId);
  if (credProblem) return { ok: false, error: "finish-lipsync: " + credProblem };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(runpodBase(route, endpointId) + "/status/" + st.jobId, { headers: auth(route) });
    // cf#398: a plane-AUTHORED refusal is NOT an upstream status and must never read as
    // pending. Checked before the body is interpreted, so it does not rest on the refusal
    // body parsing. No header (direct route, a normal response, or a proxy 502 that could
    // not reach RunPod) leaves every branch below byte for byte unchanged.
    const refusal = planeRefusalReason(route, resp);
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
        (await endpointStillCold(route, endpointId))
      ) {
        return { ok: true, pending: true };
      }
      await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "gone", submittedAtMs: st.submittedAt });
      return { ok: false, error: "finish-lipsync job not found on RunPod (GC'd or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") {
    // cf#594: RunPod lifts a top-level `error` key out of a handler RETURN into a job-level FAILED
    // envelope (cf#565), so a door's honest structured soft-degrade ({ok:false} kept in output)
    // arrives HERE wearing a failure envelope, never at the COMPLETED branch below. Pass the
    // original clip through (recorded, #77) instead of failing the shot; a genuine crash (a raise
    // leaves no structured output) still fails loud, and that discriminator is the whole safety
    // property.
    //
    // TELEMETRY ORDERING, decided BEFORE the row is written. THIS DOES NOT CONTRADICT cf#279, whose
    // rule (record the endpoint outcome before parsing, "because whether WE could use the output is
    // a different fact") is correct and is still obeyed: the outcome recorded is the ENDPOINT's,
    // written before anything is parsed for our own use. The narrower point is that RunPod's FAILED
    // here is an artifact of the lift, not an endpoint failure -- the endpoint ran to completion and
    // returned a structured result -- so `failed` is wrong ABOUT THE ENDPOINT, independently of
    // whether we recovered anything. Recording it anyway would over-report backend failures and
    // under-report degrades, both errors pointing at the door.
    //
    // A token with no source clip (pollPassthrough returns null) has nothing honest to pass through,
    // so it falls through to the pre-cf#594 terminal path below, row and message unchanged.
    const degrade = softDegradeInFailedEnvelope(s);
    if (degrade !== null) {
      const passed = pollPassthrough(st, BACKEND_SOFT_DEGRADE, degrade || undefined);
      if (passed) {
        await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "completed", submittedAtMs: st.submittedAt, ...timingFromStatus(s) });
        return passed;
      }
    }
    await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "failed", submittedAtMs: st.submittedAt, detail: JSON.stringify(s.error ?? s), errorType: parseRunpodErrorType(s.error), ...timingFromStatus(s) });
    return { ok: false, error: "finish-lipsync job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
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
      await cancelRunpodJobBestEffort(route, endpointId, st.jobId);
      await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "backend-error", submittedAtMs: st.submittedAt, detail: backendErr, errorType: parseRunpodErrorType(s.output), ...timingFromStatus(s) });
      return { ok: false, error: "finish-lipsync backend error (job " + st.jobId + ", status stuck " + String(s.status ?? "unknown") + ", cancel issued): " + backendErr };
    }
    return { ok: true, pending: true };
  }
  // cf#279: the ENDPOINT completed. Recorded before the output is parsed, because whether WE
  // could use the output is a different fact and the chain response is what carries it.
  await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "completed", submittedAtMs: st.submittedAt, ...timingFromStatus(s) });

  // The endpoint's R2-mode result: { ok, clip_key, applied, ... }. If the handler soft-degraded
  // (e.g. no detectable face), ok is false and clip_key is absent -> pass the original clip through.
  // The reason arrives as `detail` since musetalk#25 (a top-level `error` would be lifted by RunPod
  // into a job-level FAILED); `error` is kept as the legacy-handler fallback.
  // cf#594: a door that soft-degraded using the CURRENT `detail` key is NOT lifted by RunPod, so it
  // arrives COMPLETED with `{ok:false}` intact. Recovered here, before the output is parsed for an
  // artifact key -- which would otherwise find none, return module ok:false, and have the core's
  // failOrRetry classify it deterministic and FAIL THE FILM. Same shared decision as the FAILED
  // route above, so the two door shapes cannot get different answers. A token with no source clip
  // falls through to the pre-cf#594 terminal path below.
  const softDegrade = softDegradeInCompletedOutput(s.output);
  if (softDegrade !== null) {
    const passed = pollPassthrough(st, BACKEND_SOFT_DEGRADE, softDegrade || undefined);
    if (passed) return passed;
  }
  const csam = csamRefusalInCompletedOutput(s.output);
  if (csam !== null) return { ok: false, error: "csam refusal: " + csam };

  const out = parseBackendOutput(s.output);
  // cf#578: WHICH FIELD carries the written key depends on a branch on the SATELLITE, not on
  // anything visible here -- R2 mode echoes it as `clip_key` (musetalk handler.py:671), presigned
  // mode returns it as `output_key` (:717). Reading only `clip_key` turned a finished, uploaded,
  // paid-for artifact into a parse failure on the exact path cf#449 makes preferred.
  const key = finishedKey(out);
  if (!key) {
    // A REAL absence: COMPLETED with no artifact. Polish never fails the chain (#77/#249), and an
    // `ok:false` here would also skip the degrade accounting entirely, so the class would be
    // invisible in telemetry while the render died. Same decision as speech-upscale and
    // finish-upscale, at the same site.
    const passed = pollPassthrough(st, "no-output-key");
    if (passed) return passed;
    return { ok: false, error: "finish-lipsync: backend returned no clip_key or output_key, and this poll token carries no clip to pass through" };
  }
  return {
    ok: true,
    output: {
      shot_id: st.shotId,
      clip_key: key,
      out_fps: st.srcFps,    // lip-sync preserves fps + frame count
      frames: st.frames,
      applied: out?.applied ?? [],
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
