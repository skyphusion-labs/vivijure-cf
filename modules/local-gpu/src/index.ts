// local-gpu: dual-hook module (vivijure-module/2) for the LOCAL-CONSUMER door.
//   - motion.backend -> i2v_clip on vivijure-local-12gb / 16gb
//   - keyframe       -> preview (SDXL) on the SAME door (vivijure-local#153)
// One module, one LOCAL_BACKEND_URL: a studio that picks local-gpu for motion never needs RunPod
// vivijure-backend for keyframes. The module is model-agnostic across the 12GB (LTX) and 16GB
// (CogVideoX) doors; the wire contracts match the datacenter backend's i2v_clip / preview shapes.
//
// ASYNC + cancelable (GPU work exceeds a single Worker request):
//   GET  /module.json -> manifest (+ duration_grid when the door declares one)
//   POST /invoke      -> submit preview or i2v_clip, return { ok, pending, poll }
//   POST /poll        -> check the job; surface keyframe keys or clip_key on completion
//   POST /cancel      -> stop an in-flight job so a cancelled render does not orphan the GPU

import {
  type InvokeRequest,
  type InvokeResponse,
  type PollRequest,
  type PollResponse,
  type CancelRequest,
  type CancelResponse,
  type KeyframeInput,
  type KeyframeOutput,
  type MotionBackendInput,
  type MotionBackendOutput,
} from "./contract";
import type { DurationGridDecl } from "./contract";
import { buildI2vBody, readOutput, readDurationGrid, encodePoll, decodePoll, jobGone, classifyGoneState, isSafeJobId, normalizeBackendUrl } from "./i2v";
// MANIFEST is data-only in ./manifest (cf#285) so quality-tier-drift can import it without
// this entrypoint's full graph. Re-exported for callers that still load index.
import { MANIFEST } from "./manifest";
export { MANIFEST };
import {
  buildPreviewBody,
  decodeKeyframePoll,
  encodeKeyframePoll,
  parseKeyframes,
  parseTrainedLoras,
} from "./keyframe";

interface Env {
  // The base URL of the user's local backend (a Cloudflare tunnel hostname terminating at the homelab
  // box), e.g. "https://render.myhomelab.example". Kept a secret: it is the only network handle to the
  // box, and a leaked URL is an unauthenticated GPU-spend / DoS trigger (the same #38 discipline that
  // keeps the RunPod endpoint id a secret).
  LOCAL_BACKEND_URL: SecretsStoreSecret;
  // Optional bearer token the local server checks (a shared secret minted by the homelabber). The
  // service-binding trust boundary is the primary auth (this module has no public surface), but a
  // tunnel origin is reachable if its hostname leaks, so the token is defense in depth. Absent => the
  // body still submits; the server may run open on a trusted LAN tunnel.
  LOCAL_BACKEND_TOKEN?: SecretsStoreSecret;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// --- duration-grid relay (#707) ------------------------------------------------------------------
//
// The door DECLARES its fixed duration grid (pinned fps + per-tier frame caps) on /health; this
// module RELAYS it in the manifest so core preflight can warn about duration clamping at storyboard
// time. Best-effort with a short timeout and an in-isolate cache (positive AND negative results, so
// a down door is not re-probed on every manifest fetch and discovery never hangs on it). On any
// failure the manifest simply omits the field: absence = no declared constraint, never fabricated.
const GRID_CACHE_TTL_MS = 5 * 60_000;
const GRID_FETCH_TIMEOUT_MS = 1_500;
let gridCache: { at: number; grid: DurationGridDecl | null } | null = null;

/** Test hook: drop the in-isolate grid cache. */
export function _resetGridCache(): void {
  gridCache = null;
}

export async function doorDurationGrid(
  env: Env,
  fetcher: typeof fetch = fetch,
  nowMs: number = Date.now(),
): Promise<DurationGridDecl | null> {
  if (gridCache && nowMs - gridCache.at < GRID_CACHE_TTL_MS) return gridCache.grid;
  let grid: DurationGridDecl | null = null;
  try {
    const { baseUrl, token } = await backendCfg(env);
    if (baseUrl) {
      const r = await fetcher(baseUrl + "/health", {
        headers: authHeaders(token),
        signal: AbortSignal.timeout(GRID_FETCH_TIMEOUT_MS),
      });
      if (r.ok) grid = readDurationGrid(((await r.json()) as { duration_grid?: unknown }).duration_grid);
    }
  } catch {
    // down / slow / non-JSON door: omit the field this TTL window; the manifest stays honest.
  }
  gridCache = { at: nowMs, grid };
  return grid;
}

/** Resolve a Secrets Store binding (production) or a plain string (tests / local dev) to its value. */
async function secretValue(
  name: "LOCAL_BACKEND_URL" | "LOCAL_BACKEND_TOKEN",
  s: SecretsStoreSecret | string | undefined,
): Promise<{ value: string; error?: string }> {
  if (typeof s === "string") return { value: s };
  if (!s) return { value: "" };
  try {
    return { value: await s.get() };
  } catch (e) {
    const error = `local-gpu: ${name} secret read failed: ${(e as Error).message}`;
    console.warn(error);
    return { value: "", error };
  }
}

/** Resolve the backend URL + optional token once per request. The URL is normalized without a trailing
 *  slash so the path joins below are unambiguous. */
async function backendCfg(env: Env): Promise<{ baseUrl: string; token: string; urlError?: string }> {
  const [rawUrl, token] = await Promise.all([
    secretValue("LOCAL_BACKEND_URL", env.LOCAL_BACKEND_URL),
    secretValue("LOCAL_BACKEND_TOKEN", env.LOCAL_BACKEND_TOKEN),
  ]);
  const baseUrl = normalizeBackendUrl(rawUrl.value);
  const readError = rawUrl.error ?? token.error;
  return {
    baseUrl: readError ? "" : (baseUrl ?? ""),
    token: readError ? "" : token.value,
    urlError: readError ?? (baseUrl ? undefined : "local-gpu: LOCAL_BACKEND_URL must be an absolute http(s) URL"),
  };
}

/** Auth header for the local server, when a token is configured. */
function authHeaders(token: string): Record<string, string> {
  return token ? { authorization: "Bearer " + token } : {};
}

/** /invoke: validate, submit the i2v_clip job to the local backend, return a poll token immediately. */
async function submit(env: Env, req: InvokeRequest<MotionBackendInput>): Promise<InvokeResponse<MotionBackendOutput>> {
  const input = req.input;
  if (!input || !input.prompt || !input.shot_id) {
    return { ok: false, error: "motion.backend: input needs shot_id and prompt" };
  }
  const { baseUrl, token, urlError } = await backendCfg(env);
  if (!baseUrl) return { ok: false, error: urlError ?? "local-gpu: LOCAL_BACKEND_URL not configured" };
  try {
    const grid = await doorDurationGrid(env);
    const r = await fetch(baseUrl + "/run", {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(buildI2vBody(input, req.config, req.context.project, grid)),
    });
    if (!r.ok) return { ok: false, error: "local-gpu /run -> " + r.status };
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId || !isSafeJobId(jobId)) return { ok: false, error: "local-gpu /run returned no job id" };
    return {
      ok: true,
      pending: true,
      poll: encodePoll({ jobId, shotId: input.shot_id, submittedAt: Date.now() }),
      jobId,
    };
  } catch (e) {
    return { ok: false, error: "local-gpu submit failed: " + (e as Error).message };
  }
}

/** /poll: check the local job; on completion the backend has already stored the clip in R2, so we just
 *  surface the clip_key it reported. No download, no re-upload. */
async function poll(env: Env, body: PollRequest): Promise<PollResponse<MotionBackendOutput>> {
  const st = decodePoll(body.poll);
  if (!st) return { ok: false, error: "local-gpu: bad poll token" };
  const { baseUrl, token } = await backendCfg(env);
  if (!baseUrl) return { ok: false, error: "local-gpu: LOCAL_BACKEND_URL not configured" };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(baseUrl + "/status/" + st.jobId, { headers: authHeaders(token) });
    httpStatus = resp.status;
    s = (await resp.json()) as typeof s;
  } catch {
    return { ok: true, pending: true }; // transient (tunnel hiccup); poll again
  }
  // The local box restarted / GC'd the job (HTTP 404 / "job not found"): without this guard the poll
  // below would treat the numeric 404 as "not COMPLETED" and report pending forever (#141). Past the
  // grace window (or for a legacy token with no submit stamp) fail the shot so it stops polling a dead
  // job; inside the window keep polling (a momentary post-submit propagation race).
  if (jobGone(httpStatus, s)) {
    if (classifyGoneState(st.submittedAt, Date.now()) === "gone-failed") {
      return { ok: false, error: "local-gpu job not found (box restarted or never ran); failing shot " + st.shotId + " (#141)" };
    }
    return { ok: true, pending: true }; // still inside the grace window
  }
  if (s.status === "FAILED") return { ok: false, error: "local-gpu job failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  if (s.status !== "COMPLETED") return { ok: true, pending: true }; // IN_QUEUE / IN_PROGRESS

  const output = readOutput(st.shotId, s.output);
  if (!output) return { ok: false, error: "local-gpu output had no clip_key" };
  return { ok: true, output };
}

/** /cancel: stop the in-flight local job named by this poll token. The local server's cancel is POST
 *  /cancel/<id>. Idempotent by contract: a 200 (cancelled) and a 404 (job already gone / terminal)
 *  both mean the job is NOT running on the box, so both report ok:true. Any other status is surfaced as
 *  ok:false so the core degrade-logs the orphan rather than assuming it stopped. */
async function cancel(env: Env, body: CancelRequest): Promise<CancelResponse> {
  const motion = decodePoll(body.poll);
  const kf = decodeKeyframePoll(body.poll);
  if (motion && kf) return { ok: false, error: "local-gpu: ambiguous poll token" };
  let jobId: string | undefined;
  if (kf) {
    if (kf.kind !== "keyframe" || !isSafeJobId(kf.jobId)) return { ok: false, error: "local-gpu: bad poll token" };
    jobId = kf.jobId;
  } else if (motion) {
    if (!isSafeJobId(motion.jobId)) return { ok: false, error: "local-gpu: bad poll token" };
    jobId = motion.jobId;
  }
  if (!jobId) return { ok: false, error: "local-gpu: bad poll token" };
  const { baseUrl, token, urlError } = await backendCfg(env);
  if (!baseUrl) return { ok: false, error: urlError ?? "local-gpu: LOCAL_BACKEND_URL not configured" };
  try {
    const resp = await fetch(baseUrl + "/cancel/" + encodeURIComponent(jobId), { method: "POST", headers: authHeaders(token) });
    if (resp.ok || resp.status === 404) return { ok: true };
    return { ok: false, error: "local-gpu /cancel -> " + resp.status };
  } catch (e) {
    return { ok: false, error: "local-gpu cancel failed: " + (e as Error).message };
  }
}

async function submitKeyframe(env: Env, req: InvokeRequest<KeyframeInput>): Promise<InvokeResponse<KeyframeOutput>> {
  const input = req.input;
  if (!input || !input.project || !input.bundle_key) {
    return { ok: false, error: "keyframe: input needs project and bundle_key" };
  }
  const { baseUrl, token, urlError } = await backendCfg(env);
  if (!baseUrl) return { ok: false, error: urlError ?? "local-gpu: LOCAL_BACKEND_URL not configured" };
  try {
    const r = await fetch(baseUrl + "/run", {
      method: "POST",
      headers: { ...authHeaders(token), "content-type": "application/json" },
      body: JSON.stringify(buildPreviewBody(input, req.config)),
    });
    if (!r.ok) return { ok: false, error: "local-gpu keyframe /run -> " + r.status };
    const jobId = ((await r.json()) as { id?: string }).id;
    if (!jobId || !isSafeJobId(jobId)) return { ok: false, error: "local-gpu keyframe /run returned no job id" };
    return {
      ok: true,
      pending: true,
      poll: encodeKeyframePoll({ jobId, project: input.project, submittedAt: Date.now(), kind: "keyframe" }),
      jobId,
    };
  } catch (e) {
    return { ok: false, error: "local-gpu keyframe submit failed: " + (e as Error).message };
  }
}

async function pollKeyframe(env: Env, body: PollRequest): Promise<PollResponse<KeyframeOutput>> {
  const st = decodeKeyframePoll(body.poll);
  if (!st) return { ok: false, error: "local-gpu: bad keyframe poll token" };
  const { baseUrl, token } = await backendCfg(env);
  if (!baseUrl) return { ok: false, error: "local-gpu: LOCAL_BACKEND_URL not configured" };

  let httpStatus: number;
  let s: { status?: string; output?: unknown; error?: unknown };
  try {
    const resp = await fetch(baseUrl + "/status/" + st.jobId, { headers: authHeaders(token) });
    httpStatus = resp.status;
    s = (await resp.json()) as typeof s;
  } catch {
    return { ok: true, pending: true };
  }
  if (jobGone(httpStatus, s)) {
    if (classifyGoneState(st.submittedAt, Date.now()) === "gone-failed") {
      return { ok: false, error: "local-gpu keyframe job not found (box restarted or never ran); failing (#141)" };
    }
    return { ok: true, pending: true };
  }
  if (s.status === "FAILED") {
    return { ok: false, error: "local-gpu keyframe failed: " + JSON.stringify(s.error ?? s).slice(0, 200) };
  }
  if (s.status !== "COMPLETED") return { ok: true, pending: true };
  const keyframes = parseKeyframes(s.output);
  if (keyframes.length === 0) {
    return { ok: false, error: "local-gpu keyframe job COMPLETED but produced no keyframes" };
  }
  const trained = parseTrainedLoras(s.output);
  const output: KeyframeOutput = { project: st.project, keyframes };
  if (Object.keys(trained).length) output.trained_loras = trained;
  return { ok: true, output };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/module.json") {
      // #707: relay the door-declared duration grid when the door reports one (cached, best-effort).
      const grid = await doorDurationGrid(env);
      return json(grid ? { ...MANIFEST, duration_grid: grid } : MANIFEST);
    }

    // GET /ready (cf#295): credential-visibility probe (docs/module-api.md "Credential readiness").
    // LOCAL_BACKEND_URL is hard-required (every submit/poll/cancel path fails without it);
    // LOCAL_BACKEND_TOKEN is optional defense-in-depth (the module comment: "Absent => the body still
    // submits; the server may run open on a trusted LAN tunnel"), so it is reported but does not gate
    // `ok`. Read independently of backendCfg() so a failure reading one secret cannot mask the other's
    // real visibility.
    if (request.method === "GET" && url.pathname === "/ready") {
      const rawUrl = await secretValue("LOCAL_BACKEND_URL", env.LOCAL_BACKEND_URL);
      const rawToken = await secretValue("LOCAL_BACKEND_TOKEN", env.LOCAL_BACKEND_TOKEN);
      const baseUrl = normalizeBackendUrl(rawUrl.value);
      return json({
        ok: Boolean(baseUrl),
        module: MANIFEST.name,
        credentials: { local_backend_url: Boolean(baseUrl), local_backend_token: Boolean(rawToken.value) },
      });
    }

    if (request.method === "POST" && url.pathname === "/invoke") {
      let req: InvokeRequest;
      try {
        req = (await request.json()) as InvokeRequest;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as InvokeResponse);
      }
      if (req.hook === "keyframe") {
        return json(await submitKeyframe(env, req as InvokeRequest<KeyframeInput>));
      }
      if (req.hook !== "motion.backend") {
        return json({ ok: false, error: "unsupported hook " + String(req.hook) } as InvokeResponse);
      }
      return json(await submit(env, req as InvokeRequest<MotionBackendInput>));
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
      const kfSt = decodeKeyframePoll(body.poll);
      const motionSt = decodePoll(body.poll);
      if (kfSt && motionSt) {
        return json({ ok: false, error: "local-gpu: ambiguous poll token" } as PollResponse);
      }
      if (kfSt) return json(await pollKeyframe(env, body));
      if (motionSt) return json(await poll(env, body));
      return json({ ok: false, error: "local-gpu: bad poll token" } as PollResponse);
    }

    if (request.method === "POST" && url.pathname === "/cancel") {
      let body: CancelRequest;
      try {
        body = (await request.json()) as CancelRequest;
      } catch {
        return json({ ok: false, error: "invalid JSON body" } as CancelResponse);
      }
      if (!body || typeof body.poll !== "string") {
        return json({ ok: false, error: "poll token required" } as CancelResponse);
      }
      return json(await cancel(env, body));
    }

    return json({ ok: false, error: "not found" }, 404);
  },
};
