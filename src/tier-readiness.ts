// GET /api/tiers/video-finish/readiness (cf#887): an ON-DEMAND read of whether the video-finish tier
// is serving right now, as observed by calls made when someone asks.
//
// THE RULING THIS IMPLEMENTS (cf#887, lead ruling on the design). Option (b): the authenticated
// no-work read is the container's own bearer-gated GET /auth-check (cf#1360), reached through the
// sync pool. On demand only: NO scheduled monitor or poller exists or may be added here, because a
// poll under the 10 minute sleepAfter keeps an instance awake for about USD 82 a month per tenant.
//
// WHAT THIS MUST NEVER BE USED FOR (binding, from the design):
//   1. an input to the render path (enterAssemblePhase, tickVideoFinishAssemble,
//      degradeAssembleUnavailable, studioEnv, preflight admission). core#327 stands;
//   2. an input to videoFinishState or hooks_unavailable;
//   3. something written into VIDEO_FINISH_TIER_STATE automatically;
//   4. a deploy gate;
//   5. a contract test, or proof that a finish would succeed;
//   6. retry, backoff or autoscaling decisions anywhere.
// tests/tier-readiness-887.test.ts scans the import graph and fails if any render or config path
// file reaches this module, with a planted import as its control. The cached result below is
// module-private and is read only by this route.
//
// THE FOUR ANSWERS. UNKNOWN is never folded into NOT_SERVING; collapsing them is the defect cf#887
// names.
//   SERVING      /health answered 200 and /auth-check accepted our bearer.
//   NOT_SERVING  we asked and the tier answered with a failure or a platform start error.
//   AT_CAPACITY  the tier is alive but no instance can be given (a film submitted now would wait).
//   UNKNOWN      we could not ask (no door, no readable token) or could not tell (budget ran out,
//                a route not served by this image, a shape we do not know).
// Every answer carries liveness_only: true. SERVING means the process is up and accepts our bearer.
// It does NOT mean a finish would succeed.
//
// THE TRAP IN THE OBVIOUS PROBE. GET /async/status/<made-up id> on the bound door is answered 404
// by the BINDING and never reaches a container (src/video-finish-binding.ts), so it would read
// SERVING over a dead container. This module calls only /health, /ready and /auth-check, which the
// binding routes as stateless paths to a sync-<n> pool instance, so a probe never mints a job
// instance and never eats a slot of SYNC_POOL_SIZE + jobs <= max_instances.
//
// THE URL DOOR'S 401 (rollins, cf#887). On the standalone Cloudflare Container door the door Worker
// checks the bearer ITSELF before the container sees the request, and its 401 body is byte-identical
// to the container's. So a 401 there is reported with refused_by "door_worker_or_container", or
// "door_worker" when the Worker's own GET /ready says it holds no token. On the bound door no Worker
// gate exists between us and the container, so a 401 is the container's.

import type { Env } from "./env";
import { productionDoorDeps, videoFinishDoor, isCapacityRefusalText } from "./video-finish-binding";
import { usableVideoFinishUrl } from "./video-finish-availability";
import { mediaFinishToken } from "../modules/_shared/media-finish-auth";

export type TierReadinessState = "SERVING" | "NOT_SERVING" | "AT_CAPACITY" | "UNKNOWN";

export type ReadinessDoor = "bound" | "url" | "none";

export type RefusedBy = "container" | "door_worker" | "door_worker_or_container";

/** One call we made and what came back. Never a header, never the bearer. */
export interface ProbeObservation {
  route: "/health" | "/ready" | "/auth-check";
  /** HTTP status, or null when the call threw or the budget ran out first. */
  status: number | null;
  elapsed_ms: number;
  /** First ERROR_TEXT_CHARS of an error body or thrown message. Absent on success. */
  error_text?: string;
  timed_out?: true;
}

export interface TierReadiness {
  tier: "video-finish";
  state: TierReadinessState;
  /** Always true: this is liveness plus bearer acceptance and nothing more. */
  liveness_only: true;
  door: ReadinessDoor;
  /** Which instance was asked: `sync-<n>` on the bound door, the origin host on the URL door. */
  instance: string | null;
  reason: string;
  /** From the /auth-check body: "verified", or "disabled" when the door runs the explicit opt-out. */
  bearer?: string;
  refused_by?: RefusedBy;
  observations: ProbeObservation[];
  observed_at: string;
  elapsed_ms: number;
  budget_ms: number;
  /** True when this answer is the module-private result of a read made in the last CACHE_TTL_MS. */
  cached: boolean;
}

/** Whole-read budget. NOT MEASURED: no cold-start p99 for standard-4 on the video-finish image
 *  exists in the repo (cf#887 open question 3). It is set above a plausible cold start because a
 *  cold start is part of the answer for a tier that scales to zero. Running out is UNKNOWN (budget),
 *  never NOT_SERVING. Replace it with a measured figure when one exists. */
export const PROBE_BUDGET_MS = 90_000;

/** A read is reused for this long, so a burst of operator clicks wakes nothing twice. */
export const CACHE_TTL_MS = 30_000;

export const ERROR_TEXT_CHARS = 256;

/** The origin the bound door expects. A label: nothing resolves it. */
const DOOR_ORIGIN = "http://video-finish";

type ReadinessEnv = Partial<Pick<Env, "FINISH_CONTAINER" | "VIDEO_FINISH_URL" | "MEDIA_FINISH_TOKEN">>;

interface Fetcher {
  fetch(input: string, init?: RequestInit): Promise<Response>;
}

/** Seams, so a plain-node test can drive every state. Production wiring is `productionReadinessDeps`. */
export interface ReadinessDeps {
  now: () => number;
  /** Global fetch for the URL door. */
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Pool index chooser for the bound door, the same one the studio door uses. */
  poolIndex: () => number;
  budgetMs: number;
  cacheTtlMs: number;
}

export const productionReadinessDeps: ReadinessDeps = {
  now: () => Date.now(),
  fetch: (input, init) => fetch(input, init),
  poolIndex: productionDoorDeps.poolIndex,
  budgetMs: PROBE_BUDGET_MS,
  cacheTtlMs: CACHE_TTL_MS,
};

function clip(text: string): string {
  return text.slice(0, ERROR_TEXT_CHARS);
}

class BudgetExceeded extends Error {}

/** Resolve the door to ask, or say why there is none. The binding wins over the URL, the same
 *  precedence every other video-finish caller uses (an observation beats a label). */
function resolveDoor(
  env: ReadinessEnv,
  deps: ReadinessDeps,
): { kind: "bound"; fetcher: Fetcher; instance: () => string } | { kind: "url"; fetcher: Fetcher; instance: string } | null {
  if (env.FINISH_CONTAINER) {
    let asked: number | null = null;
    // The real door over the real namespace, so the probe takes the exact routing a stateless call
    // takes. routingKey is for submits, which this module never makes: throwing makes that a crash
    // instead of a silent job-instance mint.
    const door = videoFinishDoor(env.FINISH_CONTAINER, {
      routingKey: () => {
        throw new Error("tier-readiness never submits a job");
      },
      poolIndex: () => {
        asked = deps.poolIndex();
        return asked;
      },
    });
    return { kind: "bound", fetcher: door, instance: () => (asked === null ? "sync-pool" : "sync-" + asked) };
  }
  const base = usableVideoFinishUrl(env.VIDEO_FINISH_URL);
  if (!base) return null;
  const origin = base.replace(/\/+$/, "");
  let host = origin;
  try {
    host = new URL(origin).host;
  } catch {
    /* usableVideoFinishUrl already proved it parses; keep the raw origin if not */
  }
  return {
    kind: "url",
    instance: host,
    fetcher: { fetch: (url, init) => deps.fetch(origin + new URL(url, DOOR_ORIGIN).pathname, init) },
  };
}

/** One call under the shared deadline. Returns the response (body unread) and its observation. */
async function probe(
  fetcher: Fetcher,
  route: ProbeObservation["route"],
  headers: Record<string, string>,
  deadline: number,
  deps: ReadinessDeps,
): Promise<{ resp: Response | null; obs: ProbeObservation; threw?: string }> {
  const t0 = deps.now();
  const remaining = deadline - t0;
  if (remaining <= 0) return { resp: null, obs: { route, status: null, elapsed_ms: 0, timed_out: true } };
  const ctl = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctl.abort();
      reject(new BudgetExceeded());
    }, remaining);
  });
  try {
    const resp = await Promise.race([fetcher.fetch(DOOR_ORIGIN + route, { method: "GET", headers, signal: ctl.signal }), timeout]);
    return { resp, obs: { route, status: resp.status, elapsed_ms: deps.now() - t0 } };
  } catch (e) {
    const elapsed = deps.now() - t0;
    if (e instanceof BudgetExceeded) return { resp: null, obs: { route, status: null, elapsed_ms: elapsed, timed_out: true } };
    const message = clip(e instanceof Error ? e.message : String(e));
    return { resp: null, obs: { route, status: null, elapsed_ms: elapsed, error_text: message }, threw: message };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function errorText(resp: Response): Promise<string> {
  return clip(await resp.text().catch(() => ""));
}

/** A failed call, classified. Capacity is matched on text because the platform reports it as a 500
 *  or 503, the same statuses as a crash (src/video-finish-binding.ts). */
function failedState(status: number | null, text: string): "AT_CAPACITY" | "NOT_SERVING" {
  if (status === 429 || isCapacityRefusalText(text)) return "AT_CAPACITY";
  return "NOT_SERVING";
}

/** Do the read. No caching here: `createTierReadiness` owns that. */
export async function observeTierReadiness(env: ReadinessEnv, deps: ReadinessDeps = productionReadinessDeps): Promise<TierReadiness> {
  const started = deps.now();
  const observations: ProbeObservation[] = [];
  const answer = (
    door: ReadinessDoor,
    instance: string | null,
    state: TierReadinessState,
    reason: string,
    extra: Partial<Pick<TierReadiness, "bearer" | "refused_by">> = {},
  ): TierReadiness => ({
    tier: "video-finish",
    state,
    liveness_only: true,
    door,
    instance,
    reason,
    ...extra,
    observations,
    observed_at: new Date(started).toISOString(),
    elapsed_ms: deps.now() - started,
    budget_ms: deps.budgetMs,
    cached: false,
  });

  const door = resolveDoor(env, deps);
  if (!door) return answer("none", null, "UNKNOWN", "no FINISH_CONTAINER binding and no usable VIDEO_FINISH_URL: nothing to ask");
  const instance = () => (door.kind === "bound" ? door.instance() : door.instance);

  // No token, no call. The bound door would answer 503 without starting the container, and an
  // unauthenticated /auth-check proves nothing about the token the studio would send.
  const token = await mediaFinishToken(env.MEDIA_FINISH_TOKEN);
  if (!token) return answer(door.kind, null, "UNKNOWN", "MEDIA_FINISH_TOKEN is not readable on this deploy, so no call was made");

  const deadline = started + deps.budgetMs;

  // 1. Liveness. On a cold tier this is the call that starts the instance, so a platform start error
  //    (cf#851, a process that never bound its port) arrives HERE, as a throw or a 5xx.
  const health = await probe(door.fetcher, "/health", {}, deadline, deps);
  observations.push(health.obs);
  if (health.obs.timed_out) return answer(door.kind, instance(), "UNKNOWN", "the probe budget ran out before /health answered");
  if (health.threw !== undefined) {
    const s = failedState(null, health.threw);
    return answer(door.kind, instance(), s, s === "AT_CAPACITY" ? "no container instance can be given" : "/health did not answer: the platform reported an error");
  }
  const hResp = health.resp as Response;
  if (hResp.status !== 200) {
    const text = await errorText(hResp);
    health.obs.error_text = text;
    const s = failedState(hResp.status, text);
    return answer(door.kind, instance(), s, s === "AT_CAPACITY" ? "no container instance can be given" : `/health answered ${hResp.status}`);
  }
  await hResp.body?.cancel().catch(() => undefined);

  // 2. URL door only: the door Worker's own GET /ready (cf#1333). It says whether the WORKER holds a
  //    token, which is what attributes a later 401. It does not replace the authed read: it cannot
  //    see a mismatch with the studio's token. A self-host compose origin has no /ready; that is fine.
  let workerHoldsToken: boolean | null = null;
  if (door.kind === "url") {
    const ready = await probe(door.fetcher, "/ready", {}, deadline, deps);
    observations.push(ready.obs);
    if (ready.resp && ready.resp.status === 200) {
      const body = (await ready.resp.json().catch(() => null)) as { token_configured?: unknown } | null;
      if (body && typeof body.token_configured === "boolean") workerHoldsToken = body.token_configured;
    } else {
      await ready.resp?.body?.cancel().catch(() => undefined);
    }
  }

  // 3. Bearer acceptance, doing no work (cf#1360).
  const auth = await probe(door.fetcher, "/auth-check", { authorization: "Bearer " + token }, deadline, deps);
  observations.push(auth.obs);
  if (auth.obs.timed_out) return answer(door.kind, instance(), "UNKNOWN", "the probe budget ran out before /auth-check answered");
  if (auth.threw !== undefined) {
    const s = failedState(null, auth.threw);
    return answer(door.kind, instance(), s, s === "AT_CAPACITY" ? "no container instance can be given" : "/auth-check did not answer: the platform reported an error");
  }
  const aResp = auth.resp as Response;
  if (aResp.status === 401) {
    auth.obs.error_text = await errorText(aResp);
    const refused_by: RefusedBy =
      door.kind === "bound" ? "container" : workerHoldsToken === false ? "door_worker" : "door_worker_or_container";
    return answer(door.kind, instance(), "NOT_SERVING", "the tier rejected the studio's bearer (a token mismatch, for example a container started before a rotation)", { refused_by });
  }
  if (aResp.status === 404 || aResp.status === 405) {
    // The process answered, but this image predates /auth-check. We cannot tell whether it accepts
    // our token, and saying SERVING or NOT_SERVING would be a guess.
    auth.obs.error_text = await errorText(aResp);
    return answer(door.kind, instance(), "UNKNOWN", "/health answered but /auth-check is not served by this image (it predates cf#1360), so bearer acceptance is unobserved");
  }
  if (aResp.status !== 200) {
    const text = await errorText(aResp);
    auth.obs.error_text = text;
    const s = failedState(aResp.status, text);
    return answer(door.kind, instance(), s, s === "AT_CAPACITY" ? "no container instance can be given" : `/auth-check answered ${aResp.status}`);
  }
  const body = (await aResp.json().catch(() => null)) as { ok?: unknown; serving?: unknown; bearer?: unknown } | null;
  if (!body || body.ok !== true || body.serving !== true) {
    return answer(door.kind, instance(), "UNKNOWN", "/auth-check answered 200 with a body of no known shape");
  }
  const bearer = typeof body.bearer === "string" ? body.bearer : undefined;
  const reason =
    bearer === "disabled"
      ? "the process is up, but the door runs with its bearer check disabled, so no token was checked"
      : "the process is up and accepted the studio's bearer";
  return answer(door.kind, instance(), "SERVING", reason, bearer ? { bearer } : {});
}

/** Single-flight plus a short cache, per isolate. The returned reader is the ONLY way to the cached
 *  result, and the production one below is not exported. */
export function createTierReadiness(deps: ReadinessDeps = productionReadinessDeps): (env: ReadinessEnv) => Promise<TierReadiness> {
  let inflight: Promise<TierReadiness> | null = null;
  let last: { at: number; result: TierReadiness } | null = null;
  return async (env) => {
    if (last && deps.now() - last.at < deps.cacheTtlMs) return { ...last.result, cached: true };
    if (inflight) return inflight;
    inflight = observeTierReadiness(env, deps)
      .then((result) => {
        last = { at: deps.now(), result };
        logRead(result);
        return result;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

/** One structured line per fresh read, so the answer has a record (cf#887 open question 6). Logs
 *  only: no store, and nothing reads it back. Never the token, never a header. */
function logRead(r: TierReadiness): void {
  try {
    console.log(JSON.stringify({ ev: "tier_readiness", tier: r.tier, state: r.state, door: r.door, instance: r.instance, elapsed_ms: r.elapsed_ms }));
  } catch {
    /* logging must never break the read */
  }
}

const readProduction = createTierReadiness();

/** The route handler. Operator scope in the route table. Always 200: the state is in the body. */
export async function hTierReadiness(_req: Request, env: ReadinessEnv): Promise<Response> {
  const result = await readProduction(env);
  return Response.json(result, { headers: { "cache-control": "no-store" } });
}
