// The ON-IRON FINISH DOOR route: reach an always-on GPU door over a Workers VPC service binding
// instead of renting a RunPod serverless worker for the same job (cf#480), across a POOL of such
// doors (cf#507).
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
// cf#507 DELIBERATELY DOES NOT PRE-EMPT IT. This file carries a pool and a rotation; it carries NO
// HEALTH PROBING. Selection here is over doors already known bound and already known to hold a
// readable bearer -- both facts are decided by wrangler and the Secrets Store at deploy time, with
// no network call. `orderDoors` (probe /health, drop the dead) remains the filed core work. Two
// known-healthy doors do not need it, and building a probe here would be the duplicate this
// comment block exists to prevent.
//
// (Correction to the original cf#480 dispatch premise, kept because a wrong premise outlives the
// work built on it: the poll AFFINITY is not in local's `door-pool.ts`. It is in
// `src/modules/chain/handlers.ts`, which puts `doorUrl` in the speech poll token. door-pool.ts has
// no affinity of any kind.)
// ------------------------------------------------------------------------------------------------
//
// WHY BOUND-NESS AND NEVER FAILOVER. Same rule as the RunPod plane proxy (cp#321, see
// modules/_shared/runpod-route.ts): the branch is whether a binding is BOUND, never whether the
// other path FAILED. A door-to-RunPod failover would silently re-rent the GPU this change exists to
// stop renting, at exactly the moment nobody is watching -- so the cost saving would decay to zero
// with every signal still green. Unbound is the untouched RunPod path, byte for byte.
//
// cf#507 SHARPENS THAT RULE RATHER THAN RELAXING IT. Door-to-DOOR selection is NOT failover and is
// explicitly allowed. Door-to-RUNPOD is still forbidden, and the pool makes it easier to get wrong:
// the door branch is taken when the pool is NON-EMPTY (any binding bound), NOT when some door is
// usable. A pool of bound doors that all lack a readable bearer degrades with a named reason, the
// same as cf#480's single tokenless door -- it must never fall through to RunPod, because "every
// door's secret is still propagating" is precisely the transient that would silently restore the
// rented dependency.
//
// WHY AFFINITY IS APPLICATION-LEVEL AND MANDATORY (cf#507). Job state on a door is PER-PROCESS RAM
// (`JobRegistry._jobs` in the satellites' `runpod_http_serve.py`), and a poll for an id a process
// does not hold returns `404 {"status":404,...}`, which `runpodJobGone` / `classifyGoneState` read
// as TERMINAL "job gone". A poll landing on the WRONG DOOR therefore does not error: it reports a
// live job as finished-and-vanished while the other box is still burning GPU on it, and past the
// grace window the shot FAILS. Transport affinity cannot fix this -- the poll is a separate Worker
// invocation with no cookie jar and no stable source IP -- so the door's NAME rides in the poll
// token and the poll resolves BY NAME. The poll never re-picks.
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
  /** Stable route name recorded in the poll token so a poll cannot cross routes OR DOORS. Empty
   *  when unbound, which is the same value an old RunPod-minted token carries -- so a token
   *  predating this change and a token minted on the RunPod route are the same object,
   *  deliberately. */
  name: string;
  /** The door's bearer, resolved once. Empty when unbound OR when the binding is bound and the
   *  token is not visible yet -- the caller must distinguish those two (see doorProblem). */
  token: string;
  /** True for the ONE door that a bare `DOOR_ROUTE_NAME` token resolves to. See resolveDoor. */
  legacy: boolean;
}

/** The namespace every door route label lives in. A label is either exactly this (the cf#480
 *  single-door token, still in flight) or this plus `-<host>` (cf#507 per-door). Kept as a
 *  constant because the token OUTLIVES the request that minted it: a route label must not change
 *  when a binding is renamed. */
export const DOOR_ROUTE_PREFIX = "vpc";

/** The bare cf#480 route label. LOAD-BEARING BACK-COMPAT: poll tokens carrying this were minted
 *  before the pool existed and are in flight right now, so it must keep resolving -- to the door
 *  that traffic actually reached, which is the door the deploy marks `legacy`. */
export const DOOR_ROUTE_NAME = DOOR_ROUTE_PREFIX;

/** The per-door route label for a named box, e.g. `doorName("fatmike") === "vpc-fatmike"`. */
export function doorName(host: string): string {
  return DOOR_ROUTE_PREFIX + "-" + host;
}

/** One candidate door, as a module declares it: a name, whatever wrangler bound (or did not), and
 *  the already-resolved bearer plaintext. */
export interface DoorCandidate {
  name: string;
  binding: DoorBinding | undefined | null;
  token: string;
  /** Mark exactly ONE candidate per module: the door a bare `DOOR_ROUTE_NAME` token belongs to. */
  legacy?: boolean;
}

/** The self-host installer seeds an operator-supplied secret as this MARKED placeholder so the
 *  module deploy resolves, and the operator replaces it afterwards (deploy/vivijure_deploy.py).
 *  Treated as ABSENT here, exactly as modules/image-generate does for its BYOK key and for the
 *  same stated reason: presenting `REPLACE_ME__...` as a bearer gets a 401 from the door, which
 *  this module would report as `door-run-failed: HTTP 401` -- a TRANSPORT verdict for what is
 *  actually an unfinished configuration. Reading it as absent produces
 *  `door-token-not-yet-visible`, which names the real state and is the same propagation-vs-
 *  misconfiguration distinction cf#114 drew for the RunPod credentials. */
const OPERATOR_PLACEHOLDER = "REPLACE_ME__vivijure-deploy-operator-secret";

function usableToken(token: string): string {
  return token.trim() === OPERATOR_PLACEHOLDER ? "" : token;
}

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

/** Resolve a SINGLE door route (cf#480 shape, still used by modules that bind one door).
 *  `token` is already-resolved plaintext (the module owns Secrets Store resolution; this file
 *  never touches a secret binding, so it stays testable with plain values and cannot leak one by
 *  accident). The single door is by definition the legacy door: its label is the bare
 *  `DOOR_ROUTE_NAME`, which is exactly what an in-flight token carries. */
export function doorRoute(binding: DoorBinding | undefined | null, token: string): DoorRoute {
  if (!binding) return { binding: null, name: "", token: "", legacy: false };
  return { binding, name: DOOR_ROUTE_NAME, token: usableToken(token) || "", legacy: true };
}

/** Build the pool of BOUND doors, in declaration order.
 *
 *  Bound-ness ONLY -- a door with no readable bearer is still in the pool, because dropping it here
 *  would let a module whose secrets are still propagating read as having no door at all and fall
 *  through to RunPod. That is the one transition this design forbids. `usableDoors` is the
 *  narrower set, and the caller must use the two for different decisions:
 *    pool non-empty  -> take the door branch (never RunPod)
 *    usable non-empty-> which door serves this job */
export function doorPool(candidates: DoorCandidate[]): DoorRoute[] {
  const pool: DoorRoute[] = [];
  for (const c of candidates) {
    if (!c.binding) continue;
    pool.push({ binding: c.binding, name: c.name, token: usableToken(c.token) || "", legacy: Boolean(c.legacy) });
  }
  return pool;
}

/** The doors in the pool that can actually serve a job right now. Config classification only (is a
 *  bearer readable), NOT a health probe -- nothing here touches the network. */
export function usableDoors(pool: DoorRoute[]): DoorRoute[] {
  return pool.filter((d) => doorProblem(d) === null);
}

/** Round-robin over the usable doors. Pure: the caller owns the counter, so a test drives the
 *  rotation deterministically instead of asserting against a hidden global. */
export function pickDoor(pool: DoorRoute[], n: number): DoorRoute | null {
  if (pool.length === 0) return null;
  const i = ((n % pool.length) + pool.length) % pool.length;   // negative-safe
  return pool[i];
}

/** Resolve the door a poll token names. A LOOKUP, never a pick: polling any door but the one that
 *  minted the job reports a live job as gone (see the header). Returns null when this deploy does
 *  not bind the named door, and the caller must refuse rather than guess a sibling. */
export function resolveDoor(pool: DoorRoute[], routeName: string | undefined): DoorRoute | null {
  if (!tokenTookDoor(routeName)) return null;
  const exact = pool.find((d) => d.name === routeName);
  if (exact) return exact;
  // BACK-COMPAT, load-bearing: a bare cf#480 label names no box because only one existed. It can
  // only have been served by the door this deploy marks legacy. If nothing is marked, we do NOT
  // guess -- a deploy binding only new doors cannot honestly claim an old job belongs to one.
  if (routeName === DOOR_ROUTE_NAME) return pool.find((d) => d.legacy) ?? null;
  return null;
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

/** Did the poll token that minted this job come from a door route? A token with no route label
 *  predates cf#480 or was minted on RunPod -- identical cases, both RunPod.
 *
 *  Matched as the bare label OR the prefix followed by its `-` separator, never as a loose
 *  `startsWith`: `vpcfoo` shares the prefix and is not a door, and a prefix/suffix matcher that
 *  quietly accepts a near-miss is a matcher that will one day route a poll to a door that does not
 *  hold the job. */
export function tokenTookDoor(routeName: string | undefined): boolean {
  if (!routeName) return false;
  return routeName === DOOR_ROUTE_NAME || routeName.startsWith(DOOR_ROUTE_PREFIX + "-");
}
