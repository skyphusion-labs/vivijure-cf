// finish-upscale: a finish module worker (vivijure-module/2). Real-ESRGAN spatial upscale
// (delivery target_height, or explicit 2x/4x),
// dispatched to the dedicated vivijure-upscale RunPod endpoint (CUDA; separate from vivijure-backend).
//
// ASYNC: GPU upscale runs frame-by-frame and exceeds a Worker request budget:
//   GET  /module.json -> manifest
//   POST /invoke      -> submit to RunPod, return { ok, pending, poll } immediately
//   POST /poll        -> check job status; return output on completion
//
// R2 transport (cf#312): prefer credentialless presigned mode when the core hands video_url +
// output_url (no endpoint R2 env; poolable). Fall back to shared-bucket R2 mode (clip_key +
// output_key) when those URLs are absent (legacy core / unbound PRESIGNER).
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
  coerceConfig, buildRunPodBody, encodePoll, decodePoll, parseBackendOutput, finishedKey, appliedTags,
  passthroughOutput,
  type PollState,
  runpodJobGone, classifyGoneState, workersStillCold, terminalErrorInOutput, RUNPOD_COLD_GRACE_MS,
} from "./finish";
import { reconcileRunpodEndpointWorkersMax } from "@skyphusion-labs/vivijure-core/runpod-endpoint-reconcile";

import { recordRunpodJob, probeRunpodJobLog, parseRunpodErrorType, runpodWalkedPastOutcome, timingFromStatus } from "../../_shared/runpod-job-log";
// cf#594: the poll-path soft-degrade contract, shared by all four finish modules. This module had NO
// such branch before cf#594: a door's honest degrade fell through to the artifact parse and
// destroyed the film.
import { softDegradeInFailedEnvelope, softDegradeInCompletedOutput, csamRefusalInCompletedOutput, BACKEND_SOFT_DEGRADE } from "../../_shared/finish-soft-degrade";
import { planeRefusalReason, planeRefusalError, runpodRoute, runpodEndpointUrl, runpodHeaders, runpodCredentialProblem, type RunpodRoute } from "../../_shared/runpod-route";
import { doorPool, usableDoors, pickDoor, resolveDoor, doorProblem, doorHeaders, doorUrl, tokenTookDoor, doorsFromEnv, type DoorRoute } from "../../_shared/finish-door";

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
  FINISH_DOOR_TOKEN_PROPAGANDHI?: SecretsStoreSecret | string;
  /** cf#480: the door's bearer (`LOCAL_FINISH_TOKEN` on the container). Only read when a
   *  door origin is configured. */
  FINISH_DOOR_TOKEN?: SecretsStoreSecret | string;
  /** Comma-separated HTTPS origins. Empty = RunPod path. First URL is the legacy door. */
  FINISH_UPSCALE_DOORS?: string;
}

// Exported (cf#537) so a test can run conformance against the SHIPPED manifest rather than
// against a transcribed copy in the test file. finish-lipsync already exported its own.
export const MANIFEST: ModuleManifest = {
  name: "finish-upscale",
  version: "0.2.1",
  api: MODULE_API,
  hooks: ["finish"],
  provides: [
    { id: "upscale", label: "Upscale resolution (Real-ESRGAN)" },
  ],
  config_schema: {
    scale: { type: "int",  default: 2, min: 2, max: 4, label: "upscale factor (explicit; omit to send delivery height)", enum_labels: { "2": "2x", "4": "4x" } },
    model: { type: "enum", values: ["realesr-animevideov3", "RealESRGAN_x4plus"], default: "realesr-animevideov3", label: "model" },
  },
  ui: { section: "finish", icon: "expand", order: 20 },
  // cf#537: EXPLICIT, behaviour unchanged. See finish-rife for why silence is not an option here.
  participation: "default",
  // Declared artifact conventions (S6): the Real-ESRGAN container appends _up to the input clip key.
  finish_artifacts: {
    output_key: { kind: "append_suffix", suffix: "_up" },
    applied: [{ tag: "upscale:{scale|2}x" }],
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

/** cf#480. ONE transport interface over two wire-identical services, so submit and poll have a
 *  single body rather than two that drift. The door is the same image as the RunPod endpoint
 *  behind a serve overlay, so `/run`, `/status/<id>` and `/cancel/<id>` carry the same envelopes
 *  and every RunPod-shaped helper below applies unchanged.
 *
 *  The RunPod arm is deliberately a pure re-expression of the calls that were already here: same
 *  URL, same headers, same method. If it is not, that is a regression in the untouched path and
 *  tests/finish-door-cf480.test.ts asserts it byte for byte. */
interface Transport {
  /** True only on our own iron. */
  door: boolean;
  /** Recorded into the poll token; "" on the RunPod arm (see PollState.door). */
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
    // cf#507: the door's OWN name, not a constant. This is the field that makes a poll return to
    // the box that holds the job; a constant here would send every poll to whichever door the
    // deploy happens to list first, which reads as a GC'd job on the other box.
    name: route.name,
    call: (path, init) => fetch(doorUrl(route, path), {
      ...init,
      headers: { ...doorHeaders(route, MANIFEST.name), ...(init?.headers as Record<string, string> | undefined) },
    }),
  };
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

/** Round-robin cursor. Module scope, so it is per-isolate: within an isolate this is a true
 *  rotation, and across isolates the doors still share the load because each starts wherever it
 *  starts. Deliberately NOT health-aware -- that is the filed `orderDoors` work in core (cf#480),
 *  and two known-healthy doors do not need a probe. */
let doorCursor = 0;

/** Resolve the on-iron door POOL once per request (cf#480, pooled cf#507).
 *
 *  Origins come from FINISH_UPSCALE_DOORS. Empty var = empty pool = RunPod path. The first
 *  URL keeps the bare `DOOR_ROUTE_NAME` label (`door`) so a newly minted token names the
 *  legacy door; in-flight `vpc` tokens still resolve to it. Per-name tokens override when
 *  present; a single readable token applies to every configured door. */
async function doorsFor(env: Env): Promise<DoorRoute[]> {
  const [legacyToken, propagandhiToken] = await Promise.all([
    secretValue(env.FINISH_DOOR_TOKEN),
    secretValue(env.FINISH_DOOR_TOKEN_PROPAGANDHI),
  ]);
  return doorPool(doorsFromEnv({ FINISH_UPSCALE_DOORS: env.FINISH_UPSCALE_DOORS }, "FINISH_UPSCALE_DOORS", {
    legacy: legacyToken,
    byName: { propagandhi: propagandhiToken },
  }));
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
  // cf#480: not a door concept. The door is an ALWAYS-ON resident container -- there is no virgin
  // cold start to be tolerant of, and its /health answers a liveness question, not a worker-pool
  // one. Returning false here keeps the #141 verdict firing on the door route, which is correct:
  // a door that has lost a job really has lost it.
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
  if (output.degraded) console.warn(`finish-upscale: passthrough (${output.degraded}) shot=${input.shot_id}`);
  return { ok: true, output };
}


/** cf#578 POLL-TIME SOFT DEGRADE, the same decision speech-upscale already makes at its poll site.
 *
 *  A finish step is POLISH. When the endpoint completes but yields no artifact, the honest answer is
 *  the input clip passed through with the reason RECORDED, not a chain failure: an `ok:false` here
 *  routes to the chain failure path and never reaches the degrade accounting, so the entire class is
 *  invisible in telemetry while the render dies. Only MALFORMED I/O fails loud.
 *
 *  Returns null when the token predates cf#578 and carries no clipKey. There is nothing to pass
 *  through then, and inventing a key would be worse than the error it replaced -- the caller keeps
 *  the terminal error and its message says which case it is.
 */
function pollPassthrough(st: PollState, reason: string, detail?: string): PollResponse<FinishOutput> | null {
  if (!st.clipKey) return null;
  console.warn(`finish-upscale: poll passthrough (${reason}) shot=${st.shotId}`);
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
    return { ok: false, error: "finish-upscale: input needs shot_id and clip_key" };
  }

  // cf#480: our own always-on iron first, and ONLY on bound-ness. RunPod is not consulted, not
  // probed and not billed when the binding is present -- there is no failover, by design, because
  // a failover would quietly restore the rented dependency this exists to remove and every signal
  // would stay green while it happened (same rule as the plane proxy, cp#321).
  // cf#507: the branch is still BOUND-ness and nothing else. `pool` is every BOUND door; a door
  // whose bearer has not propagated yet is IN it, so a module mid-propagation cannot read as
  // having no door and fall through to RunPod. Which door serves the job is decided among the
  // USABLE ones, and that selection is door-to-door only -- never door-to-RunPod.
  const pool = await doorsFor(env);
  if (pool.length > 0) {
    const usable = usableDoors(pool);
    if (usable.length === 0) {
      // Every bound door is still waiting on its bearer. Propagation, not misconfiguration
      // (the cf#114 distinction). Degrade and SAY WHICH -- never re-rent RunPod for it.
      return passthrough(input, doorProblem(pool[0]) ?? "door-token-not-yet-visible");
    }
    const chosen = pickDoor(usable, doorCursor++)!;
    return submitVia(env, req, doorTransport(chosen));
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
      return { ok: false, error: "finish-upscale: " + msg };
    }
  }

  return submitVia(env, req, runpodTransport(route, endpointId));
}

/** The submit body, shared by both transports. Everything below here was the RunPod path verbatim;
 *  the only additions are the route label on the poll token and the degrade reasons naming which
 *  service answered, because "runpod-run-failed" on a job that never touched RunPod is exactly the
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
        // cf#578: the INPUT clip, so the poll site can pass it through on a real absence instead
        // of failing the chain. finish-lipsync has always carried it; that asymmetry is why the
        // two poll sites could not make the same decision before.
        clipKey: input.clip_key,
        // cf#480 affinity. Undefined on the RunPod arm, which is what every pre-existing token
        // carries, so old tokens and RunPod tokens stay the same object.
        door: t.name || undefined,
      }),
      jobId,  // cf#289/#296: neither service can enumerate jobs, so a caller that is not handed the id at submit can never reach it.
    };
  } catch (e) {
    return passthrough(input, "exception", { detail: (e as Error).message });
  }
}

async function poll(env: Env, body: PollRequest): Promise<PollResponse<FinishOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "finish-upscale: bad poll token" };
  // cf#480. The transport is decided by the TOKEN, not by what is bound right now. Polling the
  // other service would 404 (a door job id is a uuid4 from a per-process registry; a RunPod job id
  // is unknown to the door), `runpodJobGone` would read that as a GC'd job, and past the grace
  // window the shot would FAIL -- destroying finished work with every component behaving correctly.
  let t: Transport;
  let route: RunpodRoute | null = null;
  if (tokenTookDoor(st.door)) {
    // cf#507: resolve BY NAME, never re-pick. Job state on a door is per-process RAM, so a poll
    // landing on the other box 404s, `runpodJobGone` reads that as a GC'd job, and past the grace
    // window the shot FAILS while the box that actually holds it is still working.
    const door = resolveDoor(await doorsFor(env), st.door);
    if (!door) {
      // The binding was removed while this job was in flight. Refusing to guess is the only honest
      // answer, and cf#578 CHANGED THE REASON WITHOUT CHANGING THE ANSWER, so the reason is
      // restated rather than left as it was. It used to be that the poll token carried no
      // `clip_key` and a passthrough could not reconstruct the clip; the token now carries it
      // (clipKey), so the module COULD degrade here. It still must not: this job may be RUNNING or
      // FINISHED on the box that was unbound, and passing the input through would report a
      // finished shot as unpolished and discard an artifact that exists. The no-artifact degrade
      // at the poll site below is a different fact -- there the endpoint COMPLETED and produced
      // nothing, which is knowable; here nothing is knowable at all.
      return { ok: false, error: "finish-upscale: door " + st.door + " is not bound; job " + st.jobId + " was in flight on it; cannot poll (cf#480/#507)" };
    }
    const problem = doorProblem(door);
    if (problem) return { ok: false, error: "finish-upscale: " + problem };
    t = doorTransport(door);
  } else {
    const { route: rp, endpointId } = await runpodCreds(env);
    const credProblem = credentialProblem(rp, endpointId);
    if (credProblem) return { ok: false, error: "finish-upscale: " + credProblem };
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
    // Only meaningful on the RunPod arm: the refusal header is authored by the PLANE proxy, which
    // is not in the door's path at all. `route` is non-null exactly when that arm was taken.
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
      // cf#480 made this reachable on TWO transports, and the message named only one.
      // A door keeps job state in per-process RAM, so a container restart drops it and the
      // poll 404s exactly like a RunPod GC -- but telling an operator to check a RunPod
      // dashboard for a job RunPod never saw sends them to another company's console at the
      // moment they are debugging. `t` already knows which transport ran it, and on the door
      // arm `t.name` is the specific door, which a two-door deploy needs.
      return {
        ok: false,
        error: t.door
          ? "finish-upscale job not found on the on-iron door " + t.name +
            " (job state is per-process, so a door restart drops it); failing shot " + st.shotId + " (#141)"
          : "finish-upscale job not found on RunPod (GC'd or never ran); failing shot " + st.shotId + " (#141)",
      };
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
    return { ok: false, error: "finish-upscale job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
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
      return { ok: false, error: "finish-upscale backend error (job " + st.jobId + ", status stuck " + String(s.status ?? "unknown") + ", cancel issued): " + backendErr };
    }
    return { ok: true, pending: true };
  }
  // cf#279: the ENDPOINT completed. Recorded before the output is parsed, because whether WE
  // could use the output is a different fact and the chain response is what carries it.
  await recordRunpodJob(env.TELEMETRY_DB, { jobId: st.jobId, module: MANIFEST.name, outcome: "completed", submittedAtMs: st.submittedAt, ...timingFromStatus(s) });

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
  // cf#578: the endpoint completed. WHICH FIELD carries the written key depends on a branch on the
  // SATELLITE, not on anything visible here -- R2 mode echoes it as `clip_key`, presigned mode
  // returns it as `output_key` and sends no `applied`. Reading only `clip_key` turned a finished,
  // uploaded, paid-for artifact into a parse failure on the exact path cf#449 makes preferred.
  const key = finishedKey(out);
  if (!key) {
    // A REAL absence: COMPLETED with no artifact. Polish never fails the chain (#77/#249), and an
    // `ok:false` here would also skip the degrade accounting entirely, so the class would be
    // invisible. Same decision as speech-upscale and finish-lipsync, at the same site.
    const degraded = pollPassthrough(st, "no-output-key");
    if (degraded) return degraded;
    return { ok: false, error: "finish-upscale: backend returned no clip_key or output_key, and this poll token predates cf#578 so there is no clip to pass through" };
  }
  return {
    ok: true,
    output: {
      shot_id: out?.shot_id ?? st.shotId,
      clip_key: key,
      out_fps: out?.out_fps ?? st.srcFps,
      frames: out?.frames ?? st.frames,
      // cf#578: presigned mode sends no applied array, but DOES report the scale it ran at, so
      // the provenance tag is derived from the endpoint own report rather than lost or invented.
      // See appliedTags in finish.ts for why the config is not an acceptable source.
      applied: appliedTags(out),
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
      const pool = await doorsFor(env);
      const onDoor = pool.length > 0;
      return json({
        // cf#480: on the door route RunPod credentials are irrelevant -- requiring them would make
        // a correctly-configured on-iron module report NOT READY, which is the readiness probe
        // reporting the opposite of the truth. On the door arm `ok` is the door's own readiness.
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
        // cf#507: `route` stays the legacy door's label so a single-door deploy reports exactly
        // what it reported before. `routes` names every bound door with its own readiness, so two
        // bound doors cannot be reported as one -- a pool that reads as a single door is how a
        // silently-unbound second box survives for days.
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
