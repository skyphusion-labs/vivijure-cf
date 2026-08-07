// The ON-IRON FINISH DOOR route: reach an always-on GPU door over a Workers VPC service binding
// instead of renting a RunPod serverless worker for the same job (cf#480).
//
// ------------------------------------------------------------------------------------------------
// WHY THIS IS NOT A COPY OF vivijure-local's `src/modules/door-pool.ts`.
//
// The obvious reading of cf#480 is "local already solved door selection, import it". Measured
// against both trees, the two panels' doors are not the same KIND of object, and the parts that
// look shared mostly are not:
//
//   * local's door is a URL STRING from an env var (`LOCAL_FINISH_UPSCALE_URL`), so 39 of
//     door-pool.ts's 125 lines are `normalizeDoorBaseUrl` / `normalizeDoorBaseUrls` -- a
//     comma-list parser, a protocol check, a de-duplicator and a dropped-entry counter.
//   * cf's door is a `[[vpc_services]]` BINDING. There is no URL to parse, no list to split, no
//     entry that can be invalid, and nothing to de-duplicate: a binding is bound or it is not,
//     decided at deploy time by wrangler. Copying that parser here would be a duplicate of code
//     this repo can never call.
//
// What genuinely IS shared is `orderDoors` (health-probe, drop the dead, rotate the survivors) --
// and sharing it needs it generalised over an opaque door handle, because local probes with global
// `fetch(url + "/health")` while cf must probe with `binding.fetch(...)`. That generalisation is a
// change to vivijure-local's shipped code and a new module in vivijure-core, which cf consumes as a
// PUBLISHED npm dependency (`"@skyphusion-labs/vivijure-core": "^1.10.0"`) -- so it cannot be
// imported here until core cuts a release and this repo bumps. It is filed, not forgotten.
//
// THIS FILE THEREFORE CARRIES NO POOL AND NO ROTATION. One binding, one door. When the core
// selector lands, `DoorRoute.name` is already the field a rotation would rotate over and the poll
// token already carries it, so the pool is additive rather than a rewrite.
//
// (Correction to the dispatch premise, stated because a wrong premise outlives the work built on
// it: the poll AFFINITY is not in local's `door-pool.ts`. It is in `src/modules/chain/handlers.ts`,
// which puts `doorUrl` in the speech poll token. door-pool.ts has no affinity of any kind.)
// ------------------------------------------------------------------------------------------------
//
// WHY BOUND-NESS AND NEVER FAILOVER. Same rule as the RunPod plane proxy (cp#321, see
// modules/_shared/runpod-route.ts): the branch is whether the binding is BOUND, never whether the
// other path FAILED. A door-to-RunPod failover would silently re-rent the GPU this change exists to
// stop renting, at exactly the moment nobody is watching -- so the cost saving would decay to zero
// with every signal still green. Unbound is the untouched RunPod path, byte for byte.
//
// WIRE CONTRACT. The door is the same image as the RunPod endpoint behind a serve overlay
// (`runpod_http_serve.py` in the satellite repos), so it speaks the RunPod job API exactly:
//   POST /run          {"input": {...}}   -> 200 {"id": "<hex>"}          (bearer)
//   GET  /status/<id>                     -> 200 RunPod status envelope   (bearer)
//                                            404 {"status":404,...} once the job is unknown
//   POST /cancel/<id>                     -> 200 {"ok":true}              (bearer)
//   GET  /health                          -> 200 {"ok":true,...}          (NO auth, by design)
// Every RunPod-envelope helper the modules already use (runpodJobGone, classifyGoneState,
// terminalErrorInOutput, parseBackendOutput) therefore applies unchanged on this route.

/** A Workers VPC service binding. Structurally a Fetcher; the URL's host is ignored by the binding,
 *  so callers pass an absolute URL purely because a bare path is not a valid `Request` input. */
export interface DoorBinding {
  fetch(url: RequestInfo, init?: RequestInit): Promise<Response>;
}

/** Which transport serves this job. Exactly one of the two, decided by bound-ness at submit. */
export interface DoorRoute {
  /** The bound door, or null when no binding is present (-> the caller takes the RunPod path). */
  binding: DoorBinding | null;
  /** Stable route name recorded in the poll token so a poll cannot cross routes. Empty when
   *  unbound, which is the same value an old RunPod-minted token carries -- so a token predating
   *  this change and a token minted on the RunPod route are the same object, deliberately. */
  name: string;
  /** The door's bearer, resolved once. Empty when unbound OR when the binding is bound and the
   *  token is not visible yet -- the caller must distinguish those two (see doorProblem). */
  token: string;
}

/** The name recorded in a poll token for the single door this repo binds today. A CONSTANT rather
 *  than a derived string: the token outlives the request that minted it, so its route label must
 *  not change when a binding is renamed. */
export const DOOR_ROUTE_NAME = "vpc";

/** Classify a door route HONESTLY, in the same spirit as cf#114's credential classification.
 *
 *  A bound binding with no readable token is NOT "no door": the binding is a plain wrangler block
 *  written at deploy while the token is a Secrets Store value written separately, so the two arrive
 *  by different routes at different times. Saying "not configured" about that sends an operator
 *  chasing a correctly-declared binding. Returns null when the route is usable, and null when the
 *  route is simply unbound (which is not a problem at all -- it is the RunPod path). */
export function doorProblem(route: DoorRoute): string | null {
  if (!route.binding) return null;          // unbound is the RunPod path, not a fault
  if (!route.token) return "door-token-not-yet-visible";
  return null;
}

/** True when this route should serve the job on our own iron. */
export function doorBound(route: DoorRoute): boolean {
  return Boolean(route.binding);
}

/** Resolve the door route for a request. `token` is already-resolved plaintext (the module owns
 *  Secrets Store resolution; this file never touches a secret binding, so it stays testable with
 *  plain values and cannot leak one by accident). */
export function doorRoute(binding: DoorBinding | undefined | null, token: string): DoorRoute {
  if (!binding) return { binding: null, name: "", token: "" };
  return { binding, name: DOOR_ROUTE_NAME, token: token || "" };
}

/** Bearer headers for the door. Separate from `runpodHeaders` on purpose: this is a different
 *  credential for a different service, and folding them together is how one gets presented to the
 *  other. `/health` takes no auth but sending one is harmless and keeps one code path. */
export function doorHeaders(route: DoorRoute, module: string): Record<string, string> {
  return {
    authorization: "Bearer " + route.token,
    "user-agent": "vivijure-" + module,
  };
}

/** Absolute URL for a door path. The host is a label the binding ignores; it exists because
 *  `fetch("/run")` is not a valid absolute request. Kept in one place so every call site spells it
 *  the same way and a reader can see immediately that the host is not a routing decision. */
export function doorUrl(path: string): string {
  return "http://finish-door" + path;
}

/** Did the poll token that minted this job come from the door route? A token with no route label
 *  predates this change or was minted on RunPod -- identical cases, both RunPod. */
export function tokenTookDoor(routeName: string | undefined): boolean {
  return routeName === DOOR_ROUTE_NAME;
}
