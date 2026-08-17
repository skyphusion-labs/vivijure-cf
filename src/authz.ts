// cf#520 -- AUTHORIZATION: the second question, asked after admission.
//
// src/auth-gate.ts answers WHO is calling and has always answered it well: the operator secret, a
// named per-consumer token (#445), an Access JWT, a demo visitor. Nothing answered WHAT the caller
// may do, so every named token was operator-equivalent -- a consumer token could call
// `POST /api/storage/reconcile`, which rewrites an ESTATE-WIDE ledger and can leave it
// under-reporting (cf#516). The identity was already resolved and already propagated; only the
// authorization was missing.
//
// THE AXIS IS WHOSE DATA, NOT HOW VIOLENT THE VERB.
//   operator -- installation, configuration, or estate-wide state.
//   consumer -- one tenant's own data, HOWEVER destructive.
// All ten DELETE routes are `consumer`: deleting your own cast portrait is correct work, and a
// guard that refuses correct work is the guard people switch off.
//
// TWO VALUES, deliberately. The demonstrated hole is exactly one axis. Named scopes
// (`storage:write`, `modules:admin`) would express more than anything needs, and a scope system
// nobody uses is one that rots. Widening a union later is additive and the compiler re-enumerates
// every site; starting fine-grained and never using it is not reversible in the same way.

/** The one vocabulary, used for BOTH what a route requires and what a credential holds. One type
 *  rather than two, because a comparison between two separately-maintained enums is a place for
 *  them to drift. */
export type Scope = "operator" | "consumer";

/** The complete set, derived from nothing -- this IS the definition. Exported so a test can
 *  enumerate the domain instead of hand-listing it. */
export const SCOPES: readonly Scope[] = ["operator", "consumer"] as const;

/** Narrowing guard for a value read from D1. A row's `scope` column is a string at runtime whatever
 *  the schema says, and migration 0020's CHECK constraint is not re-evaluated for rows that predate
 *  it. Anything outside the union is a CONFIGURATION DEFECT, and the caller fails closed on it. */
export function isScope(v: unknown): v is Scope {
  return v === "operator" || v === "consumer";
}

/** The comparison. `credential` is null when no gate decision exists for this request -- today that
 *  cannot happen for a table route (every API_ROUTES pattern is under `/api/`, asserted in
 *  tests/route-scope-authz.test.ts), and it fails CLOSED anyway so a future route added outside the
 *  gated prefix cannot reach an operator handler unauthenticated. */
export function authorizeRoute(route: Scope, credential: Scope | null): boolean {
  if (route === "consumer") return true;
  return credential === "operator";
}

/** The 403 body for an authorization refusal.
 *
 *  DELIBERATELY FREE OF THE WORDS THE FRONTEND SHIM KEYS ON. public/auth-token.js:124 pops its
 *  paste-once prompt when a 403 reason matches `/api token|STUDIO_API_TOKEN/i`. An AUTHENTICATION
 *  failure should raise that prompt; an AUTHORIZATION failure must not, because the caller's token
 *  is fine and prompting them to re-paste it points at the one thing that is not broken. Asserted
 *  against the shim's OWN regex, read out of the shim, in tests/route-scope-authz.test.ts. */
export const AUTHZ_DENY_REASON =
  "insufficient scope: this credential is not authorized for this route";

/** Machine-readable discriminator for an authorization refusal (cf#525).
 *
 *  Authn failures (missing/bad token) also 403, and their `error` strings mention "API token" so
 *  the paste-once shim fires. Status alone cannot tell the two apart. This code is attached ONLY
 *  to the authorizeRoute deny, never to an auth-gate 403, so a client that already authenticated
 *  can tell "re-issue with operator scope" from "paste a live token". A prober without a valid
 *  credential never reaches this path. */
export const AUTHZ_DENY_CODE = "scope_denied";
