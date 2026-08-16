// The ON-IRON FINISH DOOR route: reach always-on GPU doors over public HTTPS origins from
// operator config, instead of renting a RunPod serverless worker for the same job (cf#480),
// across a POOL of such doors (cf#507).
//
// Origins are CONFIG, never code. FINISH_UPSCALE_DOORS / SPEECH_UPSCALE_DOORS /
// FINISH_BLENDER_DOORS are comma-separated HTTPS lists. An empty list is the RunPod path,
// the same as an unbound VPC binding was. There is no baked fallback origin.
//
// Token resolution stays in the module (Secrets Store). This file only pairs already-resolved
// plaintext with the parsed origin list. One token applies to every door when the operator
// chooses that; per-name tokens override when supplied.
//
// WHAT IS SHARED WITH local's door-pool.ts: the comma-list parse + HTTPS check. What is not:
// this file also names doors for poll affinity (job state is per-process RAM) and keeps
// resolving in-flight `vpc` / `vpc-<host>` labels. New tokens mint as `door` / `door-<host>`.
// Health probing (`orderDoors`) remains the filed core work.
//
// WHY BOUND-NESS AND NEVER FAILOVER. Same rule as the RunPod plane proxy (cp#321, see
// modules/_shared/runpod-route.ts): the branch is whether a door origin is CONFIGURED, never
// whether the other path FAILED. A door-to-RunPod failover would silently re-rent the GPU
// this change exists to stop renting. Unconfigured is the untouched RunPod path.
//
// Door-to-DOOR selection is NOT failover and is allowed. A pool of configured doors that all
// lack a readable bearer degrades with a named reason; it must never fall through to RunPod.
//
// WHY AFFINITY IS APPLICATION-LEVEL AND MANDATORY (cf#507). Job state on a door is PER-PROCESS
// RAM (`JobRegistry._jobs` in the satellites' `runpod_http_serve.py`), and a poll for an id a
// process does not hold returns `404 {"status":404,...}`, which `runpodJobGone` /
// `classifyGoneState` read as TERMINAL "job gone". The door's NAME rides in the poll token
// and the poll resolves BY NAME. The poll never re-picks.
//
// WIRE CONTRACT. The door is the same image as the RunPod endpoint behind a serve overlay
// (`runpod_http_serve.py` in the satellite repos), so it speaks the RunPod job API exactly:
//   POST /run          {"input": {...}}   -> 200 {"id": "<hex>"}          (bearer)
//   GET  /status/<id>                     -> 200 RunPod status envelope   (bearer)
//                                            404 {"status":404,...} once the job is unknown
//   POST /cancel/<id>                     -> 200 {"ok":true}              (bearer)
//   GET  /health                          -> 200 {"ok":true,...}          (NO auth, by design)

/** Which transport serves this job. Exactly one of the two, decided by configured-ness at submit. */
export interface DoorRoute {
  /** Empty when unconfigured (-> the caller takes the RunPod path). */
  baseUrl: string;
  /** Stable route name recorded in the poll token so a poll cannot cross routes OR DOORS. Empty
   *  when unconfigured, which is the same value an old RunPod-minted token carries -- so a token
   *  predating this change and a token minted on the RunPod route are the same object,
   *  deliberately. */
  name: string;
  /** The door's bearer, resolved once. Empty when unconfigured OR when the origin is set and the
   *  token is not visible yet -- the caller must distinguish those two (see doorProblem). */
  token: string;
  /** True for the ONE door that a bare `DOOR_ROUTE_NAME` (and in-flight `vpc`) token resolves to. */
  legacy: boolean;
}

/** New mint namespace. A label is either exactly this (first/legacy door) or this plus `-<host>`. */
export const DOOR_ROUTE_PREFIX = "door";

/** In-flight mint namespace from before the VPC purge. Still RESOLVED. Never minted. */
export const LEGACY_DOOR_ROUTE_PREFIX = "vpc";

/** Bare label minted for the first door on a new submit. */
export const DOOR_ROUTE_NAME = DOOR_ROUTE_PREFIX;

/** Bare label still riding on in-flight poll tokens minted before the prefix change. */
export const LEGACY_DOOR_ROUTE_NAME = LEGACY_DOOR_ROUTE_PREFIX;

/** The per-door route label for a named box, e.g. `doorName("fatmike") === "door-fatmike"`. */
export function doorName(host: string): string {
  return DOOR_ROUTE_PREFIX + "-" + host;
}

/** One candidate door, as a module declares it: a name, a public origin (or empty), and
 *  the already-resolved bearer plaintext. */
export interface DoorCandidate {
  name: string;
  baseUrl: string;
  token: string;
  /** Mark exactly ONE candidate per module: the door a bare `DOOR_ROUTE_NAME` token belongs to. */
  legacy?: boolean;
}

/** Tokens already resolved by the module. A single string applies to every door (operator choice).
 *  The object form uses `legacy` on the first URL and `byName[hostnameLabel]` on later ones,
 *  falling back to `legacy` when a later door has no per-name token. */
export type DoorTokens = { legacy: string; byName?: Record<string, string> } | string;

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

/** Last hyphen-separated label of the hostname: finish-upscale-fatmike.example -> fatmike. */
export function hostnameLabel(origin: string): string {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return "";
  }
  const first = host.split(".")[0] ?? "";
  const parts = first.split("-").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/** Parse a comma-separated list of HTTPS origins. Non-HTTPS and unparseable entries are dropped. */
export function parseDoorOrigins(raw: string | undefined | null): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const s = part.trim();
    if (!s) continue;
    try {
      const u = new URL(s);
      if (u.protocol !== "https:") continue;
      out.push(u.origin);
    } catch {
      continue;
    }
  }
  return out;
}

function tokenFor(tokens: DoorTokens, index: number, label: string): string {
  if (typeof tokens === "string") return tokens;
  if (index === 0) return tokens.legacy;
  return tokens.byName?.[label] ?? tokens.legacy;
}

/** Build DoorCandidate[] from an env var of comma-separated HTTPS origins plus already-resolved
 *  tokens. First URL is the legacy door (bare DOOR_ROUTE_NAME). Later URLs are named
 *  door-<hostnameLabel>. Empty / missing var -> empty list (RunPod path). */
export function doorsFromEnv(
  env: Record<string, unknown>,
  varName: string,
  tokens: DoorTokens,
): DoorCandidate[] {
  const raw = typeof env[varName] === "string" ? (env[varName] as string) : "";
  const origins = parseDoorOrigins(raw);
  return origins.map((baseUrl, i) => {
    const label = hostnameLabel(baseUrl);
    return {
      name: i === 0 ? DOOR_ROUTE_NAME : doorName(label),
      baseUrl,
      token: tokenFor(tokens, i, label),
      legacy: i === 0,
    };
  });
}

/** Classify a door route HONESTLY, in the same spirit as cf#114's credential classification.
 *
 *  A configured origin with no readable token is NOT "no door": the origin is a wrangler var
 *  written at deploy while the token is a Secrets Store value written separately, so the two
 *  arrive by different routes at different times. Saying "not configured" about that sends an
 *  operator chasing a correctly-declared origin. Returns null when the route is usable, and
 *  null when the route is simply unconfigured (which is not a problem at all -- it is the
 *  RunPod path). */
export function doorProblem(route: DoorRoute): string | null {
  if (!route.baseUrl) return null;          // unconfigured is the RunPod path, not a fault
  if (!route.token) return "door-token-not-yet-visible";
  return null;
}

/** True when this route should serve the job on our own iron. */
export function doorBound(route: DoorRoute): boolean {
  return Boolean(route.baseUrl);
}

/** Resolve a SINGLE door route (cf#480 shape, still used by modules that bind one door).
 *  `token` is already-resolved plaintext (the module owns Secrets Store resolution; this file
 *  never touches a secret binding, so it stays testable with plain values and cannot leak one by
 *  accident). The single door is by definition the legacy door: its label is the bare
 *  `DOOR_ROUTE_NAME`, which is exactly what a newly minted one-door token carries. */
export function doorRoute(baseUrl: string | undefined | null, token: string): DoorRoute {
  if (!baseUrl) return { baseUrl: "", name: "", token: "", legacy: false };
  return { baseUrl, name: DOOR_ROUTE_NAME, token: usableToken(token) || "", legacy: true };
}

/** Build the pool of CONFIGURED doors, in declaration order.
 *
 *  Configured-ness ONLY -- a door with no readable bearer is still in the pool, because dropping
 *  it here would let a module whose secrets are still propagating read as having no door at all
 *  and fall through to RunPod. That is the one transition this design forbids. `usableDoors` is
 *  the narrower set, and the caller must use the two for different decisions:
 *    pool non-empty  -> take the door branch (never RunPod)
 *    usable non-empty-> which door serves this job */
export function doorPool(candidates: DoorCandidate[]): DoorRoute[] {
  const pool: DoorRoute[] = [];
  for (const c of candidates) {
    if (!c.baseUrl) continue;
    pool.push({ baseUrl: c.baseUrl, name: c.name, token: usableToken(c.token) || "", legacy: Boolean(c.legacy) });
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

function hostFromRouteName(routeName: string): string {
  if (routeName.startsWith(DOOR_ROUTE_PREFIX + "-")) {
    return routeName.slice(DOOR_ROUTE_PREFIX.length + 1);
  }
  if (routeName.startsWith(LEGACY_DOOR_ROUTE_PREFIX + "-")) {
    return routeName.slice(LEGACY_DOOR_ROUTE_PREFIX.length + 1);
  }
  return "";
}

function doorMatchesHost(d: DoorRoute, host: string): boolean {
  if (!host) return false;
  if (d.name === doorName(host)) return true;
  if (d.name.endsWith("-" + host)) return true;
  return hostnameLabel(d.baseUrl) === host;
}

/** Resolve the door a poll token names. A LOOKUP, never a pick: polling any door but the one that
 *  minted the job reports a live job as gone (see the header). Returns null when this deploy does
 *  not configure the named door, and the caller must refuse rather than guess a sibling.
 *
 *  New tokens are `door` / `door-<host>`. In-flight tokens may still say `vpc` / `vpc-<host>`;
 *  those resolve to the same door and must keep working until they drain. */
export function resolveDoor(pool: DoorRoute[], routeName: string | undefined): DoorRoute | null {
  if (!tokenTookDoor(routeName) || !routeName) return null;
  const exact = pool.find((d) => d.name === routeName);
  if (exact) return exact;
  // Bare labels name the first/legacy door. `vpc` is the in-flight mint; `door` is the new one.
  if (routeName === DOOR_ROUTE_NAME || routeName === LEGACY_DOOR_ROUTE_NAME) {
    return pool.find((d) => d.legacy) ?? null;
  }
  const host = hostFromRouteName(routeName);
  if (!host) return null;
  return pool.find((d) => doorMatchesHost(d, host)) ?? null;
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

/** Absolute URL for a door path on THIS box. Never a Traefik SUBMIT hostname. */
export function doorUrl(route: DoorRoute, path: string): string {
  return route.baseUrl.replace(/\/$/, "") + path;
}

/** Did the poll token that minted this job come from a door route? A token with no route label
 *  predates cf#480 or was minted on RunPod -- identical cases, both RunPod.
 *
 *  Matched as the bare label OR the prefix followed by its `-` separator, never as a loose
 *  `startsWith`: `doorfoo` / `vpcfoo` share a prefix and are not a door. New mints use `door`;
 *  in-flight `vpc` / `vpc-<host>` still count so a poll mid-cutover does not fail. */
export function tokenTookDoor(routeName: string | undefined): boolean {
  if (!routeName) return false;
  return (
    routeName === DOOR_ROUTE_NAME ||
    routeName === LEGACY_DOOR_ROUTE_NAME ||
    routeName.startsWith(DOOR_ROUTE_PREFIX + "-") ||
    routeName.startsWith(LEGACY_DOOR_ROUTE_PREFIX + "-")
  );
}
