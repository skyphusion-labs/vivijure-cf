// Where a module's RunPod calls actually go, and what credential they carry (cf#394, cp#288).
//
// ------------------------------------------------------------------------------------------------
// WHY THIS EXISTS. On the shared hosted tier no tenant-namespace script may hold a RunPod
// credential (CLAUDE.md, Conrad 2026-08-02: a consumer reaches RunPod through our product or not at
// all, BYOK excepted). The control plane therefore stands a proxy in front of RunPod: the tenant
// module calls the plane, the plane holds the pool key and calls RunPod.
//
// The plane deliberately mounted that proxy at RUNPOD'S OWN URL SHAPE
// (vivijure-control-plane/src/runpod-proxy-route-match.ts) -- `<base>/<endpoint>` plus `/run`,
// `/status/<id>`, `/cancel/<id>` or `/health`, byte-identical suffixes -- so the module-side change
// is a base string and a bearer, and not a rewrite of 22 call sites.
//
// ------------------------------------------------------------------------------------------------
// THE BRANCH IS ON `RUNPOD_PROXY_BASE` BEING BOUND. IT IS NOT A FAILOVER, AND THAT DISTINCTION IS
// THE WHOLE SAFETY ARGUMENT.
//
//   bound   -> proxied. Bearer is the plane token. We never touch api.runpod.ai.
//   unbound -> direct.  Bearer is RUNPOD_API_KEY, byte-for-byte the behaviour that shipped before.
//
// It must NEVER become "the proxy failed, so fall back to the direct key". A shared tenant that
// could fall back to a direct key is a shared tenant holding a RunPod credential, which is the exact
// thing the proxy exists to make impossible. A proxied module with a missing or broken token
// REFUSES HONESTLY; it does not find another way to RunPod.
//
// ORDERING, and it is load-bearing (cf#394): vivijure-cf teaches the modules this base BEFORE the
// plane stops installing the RunPod key. Reversed, every hosted render breaks. That is why the
// unbound branch is the untouched original path and why this file ships ahead of any plane change.
//
// THE UNBOUND BRANCH IS A PRODUCT, NOT A MIGRATION CRUTCH. Read the word "fallback" here as
// "the self-host door", because that is what it is. vivijure-cf ships TWO products (Conrad,
// 2026-08-03): individual self-hosters running it on their own Cloudflare Workers with their own
// RunPod account, and shared hosted tenants reaching RunPod through the plane. The unbound path is
// the entire first product and it is permanently supported. Nobody should ever propose deleting it
// once the plane half lands -- doing so would remove the self-host door, not finish a migration.
//
// PARITY follows from that rather than being a separate promise: dedicated, BYO and self-host bind
// nothing here, so their path does not change at all. A self-hoster must never need our plane to
// render, and this file guarantees that by construction rather than by assertion.
//
// ------------------------------------------------------------------------------------------------
// CROSS-REPO CONTRACT. Two binding names, and the plane must bind exactly these:
//
//   RUNPOD_PROXY_BASE   plain_text, the plane's public origin + `/api/runpod/v2` (no trailing
//                       slash required; one is tolerated). Bound ONLY for runpod_mode = 'shared'.
//   RUNPOD_PROXY_TOKEN  secret, the per-tenant `vjp1.<tenant>.<mac>` credential minted by
//                       vivijure-control-plane/src/runpod-proxy-auth.ts mintTenantProxyToken.
//
// The plane side of that contract does not exist yet. Until it does, nothing binds these and every
// module takes the unbound branch, which is why this change is a no-op on the operator panel.
// ------------------------------------------------------------------------------------------------

/** RunPod's own API base. The value every module used unconditionally before this file existed. */
export const RUNPOD_DIRECT_BASE = "https://api.runpod.ai/v2";

/**
 * Attribution header the plane reads off a submit (`MODULE_HEADER` in
 * vivijure-control-plane/src/runpod-proxy-routes.ts). TENANT-ASSERTED and treated as such upstream:
 * it labels a metering row, it never prices one. Sent anyway, because without it every proxied job
 * lands in the plane's ledger with a null module and the meter cannot say what the spend was for.
 */
export const RUNPOD_MODULE_HEADER = "x-vivijure-module";

export interface RunpodRoute {
  /** Absolute base with no trailing slash. Append `/<endpointId>` then a RunPod verb suffix. */
  readonly base: string;
  /** The bearer to present: the plane token when proxied, the RunPod key when direct. */
  readonly credential: string;
  /** True when RUNPOD_PROXY_BASE was bound. Read it for DIAGNOSIS, never to pick a fallback. */
  readonly proxied: boolean;
}

/**
 * Decide the route for one request.
 *
 * `proxyBase` is whitespace-trimmed and trailing slashes are stripped, because a plain_text binding
 * is hand-configured and a stray `/` would produce `//<endpoint>` -- a URL that still resolves on
 * most stacks and would make this untestable by inspection.
 *
 * An all-whitespace `RUNPOD_PROXY_BASE` is treated as UNBOUND rather than as a proxy base of "".
 * The alternative is a module that thinks it is proxied and builds `/<endpoint>/run` as a relative
 * URL, which throws deep inside fetch rather than at the guard that exists to catch it.
 */
export function resolveRunpodRoute(
  proxyBase: string | undefined,
  proxyToken: string,
  apiKey: string,
): RunpodRoute {
  const base = (proxyBase ?? "").trim().replace(/\/+$/, "");
  if (base) return { base, credential: proxyToken, proxied: true };
  return { base: RUNPOD_DIRECT_BASE, credential: apiKey, proxied: false };
}

/** `<base>/<endpointId>`. The four RunPod verb suffixes append to this unchanged, on both routes. */
export function runpodEndpointUrl(route: RunpodRoute, endpointId: string): string {
  return route.base + "/" + endpointId;
}

/**
 * Headers for a RunPod call. The module name is attribution only and is omitted on the direct
 * route, where nothing reads it and adding a header to a vendor request buys nothing.
 */
export function runpodHeaders(route: RunpodRoute, moduleName?: string): Record<string, string> {
  const h: Record<string, string> = { authorization: "Bearer " + route.credential };
  if (route.proxied && moduleName) h[RUNPOD_MODULE_HEADER] = moduleName;
  return h;
}

/**
 * Classify an absent credential HONESTLY, preserving the cf#114 distinction on both routes.
 *
 * cf#114: the endpoint id is a plain_text binding written at module UPLOAD while the credential is
 * a secret written LATER, so endpoint-present + credential-absent is diagnostic of PROPAGATION, not
 * of misconfiguration. Saying "not configured" about it once sent a real tenant chasing a
 * correctly-configured credential.
 *
 * The proxied route inherits that shape exactly -- RUNPOD_PROXY_BASE is plain_text at upload,
 * RUNPOD_PROXY_TOKEN is a secret installed after -- and it gets its OWN message naming its OWN
 * bindings. A proxied module reporting "RUNPOD_API_KEY not configured" would send an operator to
 * look for a key that must not exist on that worker at all.
 *
 * `endpointId` is passed as `true` by modules whose endpoint is a compile-time public slug and so
 * can never be absent.
 */
export function runpodCredentialProblem(route: RunpodRoute, endpointPresent: boolean): string | null {
  const credentialName = runpodCredentialName(route);
  if (route.credential && endpointPresent) return null;
  if (endpointPresent) return "credential not yet visible on this worker version (retry shortly)";
  // FOURTH BRANCH, and it is the whole point of splitting these: credential present, endpoint
  // absent. Naming the credential here would report a binding that is FINE as unconfigured, which
  // is cf#114's own failure committed inside the function written to prevent it -- an operator sent
  // to check a token that is sitting right there, while the thing actually missing goes unnamed.
  if (route.credential) return "RUNPOD_ENDPOINT_ID not configured";
  return `${credentialName} / RUNPOD_ENDPOINT_ID not configured`;
}

/**
 * The NAME of the binding that carries this route's credential.
 *
 * For the eight public-slug modules, whose endpoint is a compile-time constant and can never be
 * absent, the whole credential guard is one inline `if (!credential)` and what it needs is the right
 * NOUN. Naming RUNPOD_API_KEY on a proxied worker would point an operator at a binding that must not
 * exist there, which is the same class of lie cf#114 was filed about.
 */
export function runpodCredentialName(route: RunpodRoute): string {
  return route.proxied ? "RUNPOD_PROXY_TOKEN" : "RUNPOD_API_KEY";
}

/** The bindings this helper reads. Widened to `| string` because every module already accepts a
 *  plain string in tests and local dev, and a resolver that only understood Secrets Store would
 *  make the proxied path the one path no test could drive. */
export interface RunpodRouteEnv {
  RUNPOD_API_KEY?: SecretsStoreSecret | string;
  /** Plain_text, bound by the plane for `runpod_mode = 'shared'` tenants only. */
  RUNPOD_PROXY_BASE?: string;
  /** Secret, the per-tenant `vjp1.<tenant>.<mac>` plane credential. */
  RUNPOD_PROXY_TOKEN?: SecretsStoreSecret | string;
}

/** Resolve a Secrets Store binding (production) or a plain string (tests / local dev) to its value.
 *  Returns "" if unset or unreadable, so the "not configured" guards still fire rather than a
 *  throw escaping into a render path. Mirrors the per-module `secretValue` this file consolidates. */
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

/**
 * Resolve the route for this request from the environment.
 *
 * BOTH credentials are read every time, deliberately. Reading only the one the branch will use
 * would make the module unable to say which binding it was missing, which is the whole content of
 * the cf#114 diagnosis. The unused one is dropped on the floor and never leaves this function.
 */
export async function runpodRoute(env: RunpodRouteEnv): Promise<RunpodRoute> {
  const [proxyToken, apiKey] = await Promise.all([
    secretValue(env.RUNPOD_PROXY_TOKEN),
    secretValue(env.RUNPOD_API_KEY),
  ]);
  return resolveRunpodRoute(env.RUNPOD_PROXY_BASE, proxyToken, apiKey);
}

// ------------------------------------------------------------------------------------------------
// THE THIRD STATE ON THE POLL PATH (cf#398, the cf-side half of cp#288).
//
// THE DEFECT THIS CLOSES. Every RunPod-reaching module's poll handles an unreadable upstream by
// returning `{ ok: true, pending: true }`. That was correct while the upstream was RunPod: a blip
// means ask again. Once the upstream is OURS, the identical code turns a degraded, mid-deploy or
// refusing plane into a render that never completes and never errors. No error surfaces anywhere,
// nothing is logged as a failure, and the panel shows a job in progress forever. It fails in the
// worst available direction, which is why the plane emits a header rather than an error body.
//
// WHAT THE PLANE ACTUALLY SENDS. Measured at vivijure-control-plane@53152477, four construction
// sites, all non-2xx, none of them a pass-through of an upstream response:
//
//   poll  runpod-proxy-poll-routes.ts  unauthorized 401, endpoint_not_allowed 403
//   poll  runpod-proxy-poll.ts         credential-unavailable 503
//   submit runpod-proxy-routes.ts      unauthorized 401, unknown_tenant/tenant_not_live/
//                                      tenant_suspended/not_shared_mode/endpoint_not_allowed 403,
//                                      bad_body 400, plus a 503 planeUnavailable
//
// The HEADER VALUE IS THE REASON, so a module can name what happened without parsing a body. And a
// transport failure REACHING RunPod is deliberately NOT given the header: it returns 502 with no
// header, because mislabelling a vendor hiccup as our outage is a different wrong answer, not a fix.
//
// WHY TERMINAL AND NOT A RETRY BUDGET. `PollResponse` is exactly three shapes -- pending, output,
// error -- and none of them can carry a reason alongside `pending`, nor return an updated poll
// token. So neither "pend but say why" nor a cross-poll retry counter is expressible without
// widening a contract that is vendored into 26 modules. It is also not warranted: of the three
// refusals reachable on the poll path, `unauthorized` and `endpoint_not_allowed` are permanent until
// a tenant is re-provisioned, and `credential-unavailable` is a plane outage. None is the
// ask-again-in-eight-seconds condition the pending branch exists for. A refusal therefore surfaces
// as an ERROR within one poll interval; a transport failure keeps today's behaviour byte for byte.
//
// GATED ON `route.proxied`, and that is not belt-and-braces. The header means "our plane refused".
// On the direct route there is no plane, so honouring a header that arrives from api.runpod.ai
// would let a vendor response change a self-hoster's render outcome. Gating it makes the self-host
// door provably untouched by this change rather than untouched by assertion.
// ------------------------------------------------------------------------------------------------

/** Emitted by the plane on a plane-AUTHORED refusal; its value is the reason. Must stay byte-equal
 *  to `PLANE_REFUSAL_HEADER` in vivijure-control-plane/src/runpod-proxy-poll.ts. */
export const PLANE_REFUSAL_HEADER = "x-vivijure-plane-refusal";

/** Only what this needs off a Response, so a test can hand in a plain object and so nothing here
 *  depends on the body having parsed. A refusal body always parses today; that is a property of the
 *  plane's current code, not of the contract, and this check must not rest on it. */
export interface PlaneRefusalCarrier {
  readonly headers: { get(name: string): string | null };
}

/**
 * The reason the PLANE refused, or null if this is not a plane refusal.
 *
 * Null covers three genuinely different things and all three must keep today's behaviour: the
 * direct route (no plane exists), a normal proxied response, and a proxy 502 saying it could not
 * reach RunPod. Only the header separates the plane's own refusal from everything else.
 */
export function planeRefusalReason(route: RunpodRoute, resp: PlaneRefusalCarrier): string | null {
  if (!route.proxied) return null;
  const raw = resp.headers.get(PLANE_REFUSAL_HEADER);
  if (!raw) return null;
  // Trimmed and bounded because this string is rendered into a render row. A blank header is not a
  // reason and is treated as no refusal at all; the plane never emits one, and inventing a refusal
  // out of an empty header would fail a render on a header a proxy stripped the value from.
  const reason = raw.trim().slice(0, 120);
  return reason || null;
}

/** The error text for a refused poll. One wording for all fourteen modules, so an operator seeing it
 *  in a render row learns the same thing whichever module produced it, and so the sentence cannot
 *  drift into fourteen variants. Names the plane explicitly: the single most expensive misreading
 *  available here is "RunPod is down" when the answer is our own plane. */
export function planeRefusalError(moduleName: string, reason: string): string {
  return (
    moduleName +
    ": the control plane refused this poll (" +
    reason +
    "). This is a plane refusal, not a RunPod failure, and the job is not observable until it clears."
  );
}
