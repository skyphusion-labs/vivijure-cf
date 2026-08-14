// speech-upscale: a `speech` module worker (vivijure-module/2). Dialogue SPEECH enhancement
// (resemble-enhance: denoise + restore + bandwidth-extend), dispatched to the dedicated
// vivijure-audio-upscale RunPod endpoint (CUDA). Pure audio: audio_key in -> enhanced audio_key out.
//
// The speech chain runs between the dialogue (TTS) phase and finish, so finish-lipsync (MuseTalk)
// drives off the cleaned audio. The orchestrator folds this module's output.audio_key back into
// job.dialogue_audio[shot] (a `degraded` output keeps the original, guarded by the core).
//
// ASYNC: GPU enhance exceeds a Worker request budget:
//   GET  /module.json -> manifest
//   POST /invoke      -> submit to RunPod, return { ok, pending, poll } immediately
//   POST /poll        -> check job status; return output on completion
//
// R2 transport: the endpoint reads `audio_key` and writes `output_key` itself, so this worker holds
// no R2 creds.
//
// POLISH step: a disabled toggle, a missing endpoint, OR an endpoint failure all SOFT-DEGRADE (input
// audio through unchanged, applied:[], `degraded` set) -- never a hard chain failure, never a fake
// success tag (#249/#77). The only hard ok:false is malformed input or a bad poll token.

import {
  MODULE_API,
  type ModuleManifest,
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type SpeechInput,
  type SpeechOutput,
} from "./contract";
import {
  coerceConfig, buildRunPodBody, encodePoll, decodePoll, parseBackendOutput, passthroughOutput,
  successOutput, runpodJobGone, classifyGoneState, workersStillCold, terminalErrorInOutput,
  RUNPOD_COLD_GRACE_MS, type PollState,
} from "./speech";
import { reconcileRunpodEndpointWorkersMax } from "@skyphusion-labs/vivijure-core/runpod-endpoint-reconcile";

import { recordRunpodJob, probeRunpodJobLog, parseRunpodErrorType, runpodWalkedPastOutcome, timingFromStatus } from "../../_shared/runpod-job-log";
import { planeRefusalReason, planeRefusalError, runpodRoute, runpodEndpointUrl, runpodHeaders, runpodCredentialProblem, type RunpodRoute } from "../../_shared/runpod-route";
import { doorPool, usableDoors, pickDoor, resolveDoor, doorName, doorProblem, doorHeaders, doorUrl, tokenTookDoor, DOOR_ROUTE_NAME, type DoorBinding, type DoorRoute } from "../../_shared/finish-door";

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
  /** cf#480: the always-on speech-enhance door on our own GPU iron, over a Workers VPC service.
   *  Bound -> every job goes here and RunPod is not called at all. Unbound -> the RunPod path,
   *  byte for byte. Bound-ness, never failover (modules/_shared/finish-door.ts). */
  SPEECH_UPSCALE_VPC?: DoorBinding;
  /** cf#507: the SECOND always-on speech door. Same image, same wire contract; jobs round-robin
   *  across both and a poll returns to the box that took it. Unset = one door = cf#480 exactly. */
  SPEECH_UPSCALE_VPC_PROPAGANDHI?: DoorBinding;
  SPEECH_DOOR_TOKEN_PROPAGANDHI?: SecretsStoreSecret | string;
  /** cf#480: the door's bearer (`LOCAL_FINISH_TOKEN`). Read only when the binding is bound. */
  SPEECH_DOOR_TOKEN?: SecretsStoreSecret | string;
}

const MANIFEST: ModuleManifest = {
  name: "speech-upscale",
  version: "0.2.0",
  api: MODULE_API,
  hooks: ["speech"],
  provides: [
    { id: "speech-upscale", label: "Clean dialogue audio (resemble-enhance)" },
  ],
  config_schema: {
    enable:  { type: "bool", default: false, label: "enhance dialogue audio (opt-in)" },
    denoise: { type: "bool", default: false, label: "extra denoise pass" },
  },
  ui: { section: "speech", icon: "wand", order: 10 },
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function runpodBase(route: RunpodRoute, endpointId: string): string {
  return runpodEndpointUrl(route, endpointId);
}

/** cf#480 -- see modules/finish-upscale/src/index.ts for the full note. ONE transport interface
 *  over two wire-identical services so submit and poll keep a single body. */
interface Transport {
  door: boolean;
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
    // cf#507: the door's OWN name. A constant here would send a poll to whichever door is listed
    // first rather than to the box holding the job, which reads as a GC'd job on the other one.
    name: route.name,
    call: (path, init) => route.binding!.fetch(doorUrl(path), {
      ...init,
      headers: { ...doorHeaders(route, MANIFEST.name), ...(init?.headers as Record<string, string> | undefined) },
    }),
  };
}

/** Round-robin cursor; per-isolate, deliberately not health-aware (see finish-upscale). */
let doorCursor = 0;

/** Resolve the on-iron door POOL once per request (cf#480, pooled cf#507). The legacy door keeps
 *  the bare `DOOR_ROUTE_NAME` label so an in-flight poll token's label IS this door's name and
 *  back-compat is structural rather than a special case. */
async function doorsFor(env: Env): Promise<DoorRoute[]> {
  const [legacyToken, propagandhiToken] = await Promise.all([
    secretValue(env.SPEECH_DOOR_TOKEN),
    secretValue(env.SPEECH_DOOR_TOKEN_PROPAGANDHI),
  ]);
  return doorPool([
    { name: DOOR_ROUTE_NAME, binding: env.SPEECH_UPSCALE_VPC, token: legacyToken, legacy: true },
    { name: doorName("propagandhi"), binding: env.SPEECH_UPSCALE_VPC_PROPAGANDHI, token: propagandhiToken },
  ]);
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
async function endpointStillCold(t: Transport): Promise<boolean> {
  // cf#480: not a door concept -- the door is an always-on resident container with no virgin cold
  // start, so the #141 verdict must keep firing there. A door that lost a job really lost it.
  if (t.door) return false;
  try {
    const r = await t.call("/health");
    if (!r.ok) return false;
    return workersStillCold(await r.json());
  } catch {
    return false;
  }
}

/** Best-effort cancel of a RunPod job we are about to degrade away from: a hung-error job otherwise
 *  HOLDS the billed worker until someone cancels it by hand (F17 spend leak). Never throws. */
async function cancelRunpodJobBestEffort(t: Transport, jobId: string): Promise<void> {
  try {
    // The door serves /cancel/<id> as well (runpod_http_serve.py), so this is not RunPod-only.
    await t.call("/cancel/" + jobId, { method: "POST" });
  } catch {
    /* best-effort */
  }
}

/** Soft degrade: pass the input audio through unchanged, record `degraded`. `disabled` is the
 *  intentional opt-out (not warned); a real failure is warned so a misconfig/backend-down is never
 *  silent (#77). */
function passthrough(input: SpeechInput, reason: string, detail?: string): InvokeResponse<SpeechOutput> {
  if (reason !== "disabled") console.warn(`speech-upscale: passthrough (${reason}) shot=${input.shot_id}`);
  return { ok: true, output: passthroughOutput(input, reason, detail) };
}

/** Same soft-degrade, reconstructed from the stateless poll token (the input audio_key lives in it). */
function pollPassthrough(st: PollState, reason: string, detail?: string): PollResponse<SpeechOutput> {
  console.warn(`speech-upscale: poll passthrough (${reason}) shot=${st.shotId}`);
  return { ok: true, output: passthroughOutput({ shot_id: st.shotId, audio_key: st.audioKey }, reason, detail) };
}

async function submit(env: Env, req: InvokeRequest<SpeechInput>): Promise<InvokeResponse<SpeechOutput>> {
  const input = req.input;
  if (!input?.shot_id || !input?.audio_key) {
    return { ok: false, error: "speech-upscale: input needs shot_id and audio_key" };
  }
  const cfg = coerceConfig(req.config);
  if (!cfg.enable) return passthrough(input, "disabled");              // opt-in off: clean no-op

  // cf#480: our own always-on iron first, and ONLY on bound-ness. No failover to RunPod -- that
  // would restore the rented dependency this removes, silently, with every signal still green.
  const pool = await doorsFor(env);
  if (pool.length > 0) {
    const problem = usableDoors(pool).length > 0 ? null : (doorProblem(pool[0]) ?? "door-token-not-yet-visible");
    if (problem) return passthrough(input, problem);   // bound, token not visible yet (cf#114 shape)
    return submitVia(env, req, cfg, doorTransport(pickDoor(usableDoors(pool), doorCursor++)!));
  }

  const { route, apiKey, endpointId } = await runpodCreds(env);
  // Degrade, but say WHICH: absent-key-with-endpoint is propagation, not misconfiguration (cf#114).
  const degradeReason = credentialDegradeReason(route, endpointId);
  if (degradeReason) return passthrough(input, degradeReason);

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
      return { ok: false, error: "speech-upscale: " + msg };
    }
  }

  return submitVia(env, req, cfg, runpodTransport(route, endpointId));
}

/** The submit body, shared by both transports. Verbatim the RunPod path apart from the route label
 *  on the poll token and a degrade reason that names which service answered. */
async function submitVia(
  env: Env,
  req: InvokeRequest<SpeechInput>,
  cfg: ReturnType<typeof coerceConfig>,
  t: Transport,
): Promise<InvokeResponse<SpeechOutput>> {
  const input = req.input;
  const where = t.door ? "door" : "runpod";
  try {
    const r = await t.call("/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildRunPodBody(input, cfg, req.context.project)),
    });
    if (!r.ok) return passthrough(input, where + "-run-failed", "HTTP " + r.status);
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId) return passthrough(input, "no-jobid");
    // cf#279: neither service can enumerate jobs, so an id not recorded at submit is unreachable
    // permanently -- and a failure RATE needs this denominator, not only the failures.
    const submittedAt = Date.now();
    await recordRunpodJob(env.TELEMETRY_DB, { jobId, module: MANIFEST.name, outcome: "submitted", submittedAtMs: submittedAt });
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, shotId: input.shot_id, audioKey: input.audio_key, submittedAt, door: t.name || undefined }),
      jobId,  // cf#289/#296: neither service can enumerate jobs, so a caller that is not handed the id at submit can never reach it.
    };
  } catch (e) {
    return passthrough(input, "exception", (e as Error).message);
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<SpeechOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "speech-upscale: bad poll token" };
  // cf#480. The transport comes from the TOKEN, never from what is bound right now: a door job id
  // is unknown to RunPod and vice versa, and the miss returns 404, which reads as a GC'd job.
  let t: Transport;
  let route: RunpodRoute | null = null;
  if (tokenTookDoor(st.door)) {
    // cf#507: resolve BY NAME, never re-pick -- a poll on the wrong box 404s and reads as GC'd.
    const door = resolveDoor(await doorsFor(env), st.door);
    // Binding removed mid-flight. Unlike its finish sibling this token DOES carry the input
    // audio_key, so the honest answer is the module's own soft degrade rather than a hard error --
    // the chain keeps the original dialogue audio and the reason is recorded, never a fake tag.
    if (!door) return pollPassthrough(st, "door-unbound-mid-job");
    if (doorProblem(door)) return pollPassthrough(st, "door-token-not-yet-visible");
    t = doorTransport(door);
  } else {
    const { route: rp, endpointId } = await runpodCreds(env);
    if (!rp.credential || !endpointId) return pollPassthrough(st, "not-configured");
    route = rp;
    t = runpodTransport(rp, endpointId);
  }

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await t.call("/status/" + st.jobId);
    // cf#398: a plane-AUTHORED refusal is NOT an upstream status and must never read as
    // pending. Checked before the body is interpreted, so it does not rest on the refusal
    // body parsing. No header (direct route, a normal response, or a proxy 502 that could
    // not reach RunPod) leaves every branch below byte for byte unchanged.
    // RunPod arm only: the refusal header is authored by the PLANE proxy, absent from the door path.
    const refusal = route ? planeRefusalReason(route, resp) : null;
    if (refusal) return { ok: false, error: planeRefusalError(MANIFEST.name, refusal) };
    httpStatus = resp.status;
    s = await resp.json() as typeof s;
  } catch {
    return { ok: true, pending: true };  // transient transport blip -> keep polling
  }
  // RunPod GC'd the job (HTTP 404 / numeric "status":404): inside the grace window it's a post-submit
  // race -> keep polling; past it the job is really gone -> SOFT-DEGRADE (polish step, never fail the
  // chain), lip-sync uses the original audio.
  if (runpodJobGone(httpStatus, s)) {
    const now = Date.now();
    if (classifyGoneState(st.submittedAt, now) === "gone-failed") {
      // Cold-start tolerance: a virgin host's image pull can outlive the grace window while the job
      // 404s. If no worker has EVER come up, keep polling up to the cold cap before degrading.
      if (
        classifyGoneState(st.submittedAt, now, RUNPOD_COLD_GRACE_MS) === "gone-grace" &&
        (await endpointStillCold(t))
      ) {
        return { ok: true, pending: true };
      }
      await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "gone", submittedAtMs: st.submittedAt });
      return pollPassthrough(st, "endpoint-gone");
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") {
    await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "failed", submittedAtMs: st.submittedAt, detail: JSON.stringify(s.error ?? s), errorType: parseRunpodErrorType(s.error), ...timingFromStatus(s) });
    return pollPassthrough(st, "endpoint-failed", JSON.stringify(s.error ?? s).slice(0, 160));
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
    // terminal error. Cancel to stop the spend, then soft-degrade (polish step, never fail the chain).
    const backendErr = terminalErrorInOutput(s.output);
    if (backendErr) {
      await cancelRunpodJobBestEffort(t, st.jobId);
      await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "backend-error", submittedAtMs: st.submittedAt, detail: backendErr, errorType: parseRunpodErrorType(s.output), ...timingFromStatus(s) });
      return pollPassthrough(st, "endpoint-error", backendErr.slice(0, 160));
    }
    return { ok: true, pending: true };
  }
  // cf#279: the ENDPOINT completed. Recorded before the output is parsed, because whether WE
  // could use the output is a different fact and the chain response is what carries it.
  await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "completed", submittedAtMs: st.submittedAt, ...timingFromStatus(s) });

  const out = parseBackendOutput(s.output);
  // The endpoint soft-degrades (ok:false in its payload) on its own failures; without an output_key
  // there's no enhanced audio -> pass the original through. Otherwise return the cleaned key.
  if (!out?.output_key) return pollPassthrough(st, "no-output-key");
  return { ok: true, output: successOutput(st, out) };
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
      const pool = await doorsFor(env);
      const onDoor = pool.length > 0;
      return json({
        // cf#480: on the door route RunPod credentials are irrelevant -- requiring them would make
        // a correctly-configured on-iron module report NOT READY, which is a readiness probe
        // reporting the opposite of the truth.
        ok: onDoor ? usableDoors(pool).length > 0 : Boolean(route.credential && endpointId),
        // Echoed so a prober can prove it reached the script it MEANT to reach (a tenant-prefixed
        // script name is easy to get wrong); already public in /module.json, so it leaks nothing.
        module: MANIFEST.name,
        credentials: { runpod_api_key: Boolean(route.credential), runpod_endpoint_id: Boolean(endpointId) },
        // cf#394: which route answered. Additive -- the plane parses runpod_api_key and
        // refuses a module whose /ready omits it, so that field keeps its name.
        runpod_proxied: route.proxied,
        // cf#480: PRESENT ONLY WHEN A DOOR IS BOUND, so an unbound module's /ready is byte-identical
        // to what it served before this change and the module-agnostic shape contract holds. When it
        // IS present, it distinguishes bound-with-token from bound-without-token, which behave
        // completely differently and are indistinguishable from outside otherwise.
        // cf#507: `route` keeps the legacy label so a one-door deploy reports what it always did;
        // `routes` names every bound door so two doors cannot be reported as one.
        ...(onDoor
          ? {
              door: {
                bound: true,
                token: usableDoors(pool).length > 0,
                route: (pool.find((d) => d.legacy) ?? pool[0]).name,
                routes: pool.map((d) => ({ name: d.name, token: !doorProblem(d) })),
              },
            }
          : {}),
        // cf#279: is this worker able to RECORD a job outcome at all? Reported here because
        // otherwise an empty job log is indistinguishable from a clean run, which is the exact
        // failure shape the log exists to end. Deliberately NOT part of `ok`: the job log is
        // telemetry and a module without it still renders.
        telemetry: { job_log: await probeRunpodJobLog(env.TELEMETRY_DB) },
      });
    }

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest<SpeechInput>;
      try { req = await request.json() as InvokeRequest<SpeechInput>; }
      catch { return json({ ok: false, error: "invalid JSON body" } as InvokeResponse); }
      if (req.hook !== "speech") return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
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
