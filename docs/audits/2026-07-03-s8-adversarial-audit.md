# Vivijure Studio control plane -- adversarial security audit (S8)

> **Published under the house rule: publish once patched.** Every control-plane finding below is
> closed or documented, and this is the record of how that was reached. The one item still open is
> called out by name rather than quietly dropped.

## About this audit

| | |
|---|---|
| Author | Ernst (Skyphusion crew, legal affairs; here as an adversarial reader, not a lawyer) |
| Audit date | 2026-07-03 (sprint S8) |
| Code audited | The studio control plane, `src/`, at the v0.12.0 line (token-mode edge auth, Secrets Store migration) |
| Published | 2026-07-16, on Conrad Rockenhaus's disclosure ruling |

**Why the line numbers may not match `main`.** This audit was performed while the studio control
plane lived in the `vivijure` repo. That code has since moved here, to `vivijure-cf`, in the
constellation split ([vivijure#774](https://github.com/skyphusion-labs/vivijure/issues/774)). Every
`src/...:NNN` reference in the body below points at the **pre-split tree as it stood on 2026-07-03**.
The paths are still meaningful against this codebase; the line numbers have drifted. Read them as
landmarks, not coordinates.

The body is reproduced **verbatim**, including the findings that turned out to be low severity and
the five items the audit could not settle without a live check. An audit edited after the fact to
look better is not an audit.

## Where each finding landed (verified against `main`, 2026-07-16)

| Finding | Status |
|---|---|
| F1 (MED) `bundleKey` reached R2 and the backend unvalidated | **FIXED.** `isSafeBundleKey()` now guards all three submit boundaries and asserts the `bundles/` prefix |
| F2 (MED) named per-consumer tokens are not access-scoped | **DOCUMENTED** (the audit's recommended option (a)): `docs/SECURITY.md` s1b-i states a named token is full-access and revocable, NOT isolating |
| F3 (LOW-MED) module trust boundary | **DOCUMENTED**: `docs/SECURITY.md` s7a, "What installing a module grants it" |
| F4 (LOW) malformed cookie threw a 500 inside the gate | **FIXED.** The decode is wrapped; a non-decoding cookie is treated as no token presented and lands the clean deny path |
| F5 (LOW) the read cookie is a full-read credential if it leaks | **DOCUMENTED**: `docs/SECURITY.md` s1b, cookie authenticates GET/HEAD only; a cookie-only mutation is answered `403` |
| F6 (LOW, SUSPECTED) backend job-input trust | **Control-plane half FIXED (via F1). Backend half OPEN** -- see below |
| F7 (INFO) spend rate limiter failed OPEN by default | **FIXED, default flipped**: fail-CLOSED unless `SPEND_LIMIT_FAIL_CLOSED="false"` |

Hardening that followed this audit: [#485](https://github.com/skyphusion-labs/vivijure/pull/485)
(post-deploy no-bearer-403 self-check), [#486](https://github.com/skyphusion-labs/vivijure/pull/486)
(loud `ALLOW_UNAUTHENTICATED` signalling),
[#487](https://github.com/skyphusion-labs/vivijure/pull/487) (opaque resource ids, F13),
[#488](https://github.com/skyphusion-labs/vivijure/pull/488) (spend limiter fails closed, F7),
[#490](https://github.com/skyphusion-labs/vivijure/pull/490) (the docs truth pass on all of it).

### The one item still open: F6, backend half

F6 had two halves. The control-plane half is closed: F1 landed, so the core now forwards only a
validated, `bundles/`-prefixed key.

The backend half, "confirm the RunPod handler treats `bundle_key` / `project` / `pretrained_loras`
as untrusted before any path or subprocess use", **is not closed.** The handler presence-checks
`bundle_key` (it raises if absent), which is not the same as treating the string as untrusted. It is
tracked in the open
**[vivijure-backend#281](https://github.com/skyphusion-labs/vivijure-backend/issues/281)**.

Stating the reachability plainly, because a vague security note is worse than none: there is **no
known path to exploit this.** The only caller that reaches the backend is the control plane, and the
control plane validates the key first (F1). This is defense-in-depth we want and do not yet have, not
a live hole. It is published here open, rather than held back, because it is bounded, already public
in #281, and the rule is publish once patched, not publish once flattering.

---
- Auditor: Ernst (legal affairs, NOT a lawyer; here as an adversarial reader)
- Scope: read-only static + reasoning audit of `~/dev/vivijure/src` (studio control plane) and its
  immediate seams. No code touched, no commits, no live payloads, no prod mutation.
- Date: 2026-07-03. Repo HEAD: v0.12.0 line (token-mode edge auth, Secrets Store migration).
- Method: traced every auth path, the secret resolver, the presign/IDOR surface, the module seam, and
  input validation. Findings ranked by real exploitability. CONFIRMED = I traced the code path end to
  end. SUSPECTED = needs a live check or lives in another repo.

## Verdict up top

No CRITICAL finding. I could not construct an auth bypass, a secret leak to the wire, or an
unauthenticated path to a protected handler. The v0.12.0 token gate is fail-closed on every branch I
traced, uses a constant-time compare, denies on an unknown `AUTH_MODE`, and denies when the secret is
unset. The secret resolver fails closed. There is no CORS allowance and the non-page CSP is
`default-src 'none'`. The findings below are real but bounded, and most are defense-in-depth or
"document the model so nobody deploys it wrong."

The single-operator self-host model matters for severity: `vivijure.skyphusion.org` is one operator's
gated instance, not multi-tenant SaaS. Several "IDOR" style items are low-impact under that model but
become real the moment anyone hands out named consumer tokens expecting isolation.

---

## Findings

### F1 (MED, CONFIRMED) -- `bundleKey` reaches R2 and the backend with no `isSafeRelKey` validation

- Where: `src/index.ts` render-submit handlers, e.g. `hSubmitRender` line 519 (`if (!b.bundleKey)`
  only), then used raw at line 548 (`bundle_key: b.bundleKey`) and line 571; same pattern at lines 587,
  596, 619, 658, 741--749, 939--961. Consumed raw at `src/bundle-storyboard.ts:66`
  (`env.R2_RENDERS.get(bundleKey)`).
- The gap: every OTHER externally-supplied key IS validated with `isSafeRelKey` -- `start_image`
  (`storyboard-validate.ts:446`), `refs_dir` (`storyboard-validate.ts:594`), the artifact GET route
  (`index.ts:350`). `bundleKey` is the exception: it is checked for presence only.
- Attack scenario: an authenticated caller (operator token OR any named consumer token) POSTs
  `/api/storyboard/render` with `bundleKey` set to an arbitrary key in the `vivijure` bucket (e.g.
  another project's bundle, or a cast asset path). The core does `R2_RENDERS.get(bundleKey)` to read
  scenes, and forwards the same raw string to the RunPod backend as `bundle_key`, which fetches and
  untars it. Result: steer a core R2 read and a backend R2 fetch to an operator-chosen within-bucket
  object. Blast radius is bounded (authenticated only, one bucket, must parse as a bundle to yield
  scenes), but it is a real cross-object targeting primitive and an inconsistency with the codebase's
  own key-safety doctrine.
- Fix: validate `bundleKey` with `isSafeRelKey` at each submit boundary (and ideally assert the
  `bundles/` prefix, mirroring `ARTIFACT_PREFIXES` at line 350) before it reaches `readBundleScenes`
  or the job input. Reject loudly on a bad key.

### F2 (MED, CONFIRMED) -- named per-consumer tokens are NOT access-scoped; `gate.sub` is never used

- Where: `src/auth-gate.ts:110-138` (`verifyTokenRequest` returns `sub: api-token:<consumer>`), but
  the identity is discarded: `src/index.ts:1285` checks `gate.ok` only. A grep for `gate.`/`.sub`/
  `consumer`/`principal` across `index.ts` finds no authorization use of the identity anywhere.
- The gap: every valid bearer (the operator secret OR any named token from the `api_tokens` table)
  gets identical, complete access to ALL projects, cast, renders, and artifacts. A named token is
  independently REVOCABLE but not SCOPED. This is fine for a single operator, but the #445 feature
  reads as "issue a bot its own credential," which invites a deployer to hand out consumer tokens
  believing they isolate data. They do not.
- Attack scenario: consumer A's token reads/writes/deletes consumer B's projects and downloads B's
  render artifacts, trivially, because there is no per-consumer row scoping in any handler.
- Fix: either (a) document explicitly, in `docs/SECURITY.md` and the mint script's help, that a named
  token is a full-access, revocable credential with NO data isolation; or (b) if isolation is ever
  intended, thread `gate.sub` into project/render/cast queries as an owner column. (a) is the honest
  near-term move given the self-host model; do not ship the implication of (b) without the mechanism.

### F3 (LOW-MED, CONFIRMED, largely by-design) -- module trust boundary: a module reads and can tamper the render assets it handles

- Where: `src/modules/registry.ts` invoke/chain dispatch; `InvokeContext` is `{project, job_id}` only
  (`types.ts:183`, correctly no secrets). But a hook's `input` payload carries presigned R2 GET/PUT
  URLs (that is how a `finish`/`motion.backend` module reads its source and writes its output, e.g.
  `film-orchestrator.ts:686-688` presigns a GET + PUT pair per chain step).
- The reality: modules are now user Workers (WfP dynamic dispatch), i.e. community/untrusted code. An
  installed malicious module can: read the keyframe/clip it is handed (content confidentiality leak to
  a third party), and PUT arbitrary bytes to its output key (poison the render -- ship a garbage or
  hostile clip). It CANNOT read other projects (presign is per-key, short TTL), CANNOT obtain
  long-lived credentials, CANNOT read secrets (none cross the wire), and CANNOT choose its own output
  key (all PUT keys are core-derived). Existing mitigations are good: 1MB response cap
  (`registry.ts:496`), `ok:false` degrade on any module misbehavior, no secrets in context.
- Fix / posture: this is inherent to a plugin model and acceptable, but it must be DOCUMENTED:
  installing a module grants that code read-and-tamper over the specific render assets it processes.
  Recommend a provenance/allowlist note for third-party modules and a line in the module-authoring +
  security docs making the trust grant explicit to operators.

### F4 (LOW, CONFIRMED) -- malformed cookie percent-encoding throws inside the gate (500, not clean 403)

- Where: `src/auth-gate.ts:73` `decodeURIComponent(v)` on the `vivijure_token` cookie value; the gate
  call `await gateApi(request, env)` at `src/index.ts:1285` is NOT inside the handler try/catch (that
  try/catch is only around `hit.handler`, line 1315), and `fetch()` (`index.ts:1270`) does not wrap
  `routeRequest`.
- Scenario: a GET/HEAD with `Cookie: vivijure_token=%zz` (invalid escape) makes `decodeURIComponent`
  throw, which propagates out of the gate as an unhandled exception -> Workers returns a generic 500.
- Severity: this is FAIL-CLOSED (the request never reaches a protected handler; no access is granted),
  so it is a robustness/DoS-noise nit, not a bypass. Still worth fixing: an uncaught throw in the auth
  chokepoint is a smell.
- Fix: wrap the `decodeURIComponent` in try/catch and treat a malformed cookie as "no token presented"
  (returns the clean 403 missing-token path).

### F5 (LOW, CONFIRMED, informational) -- the read cookie is a full-read credential if it leaks

- Where: `src/auth-gate.ts:23-32, 61-77`. The `vivijure_token` cookie authenticates GET/HEAD on all
  `/api/*`. If it leaks, an attacker gets full READ of every project/render/artifact via GET.
- Mitigations already in place and sound: cookie is `Secure; SameSite=Strict; Path=/api/`, mutations
  require the explicit bearer header (cookie ignored on POST/PUT/PATCH/DELETE, line 66), and the studio
  CSP is strict with no inline script (`asset-response.ts:32`), which is the main XSS backstop.
- Recommendation: keep the CSP strict (it is load-bearing here); consider a bounded cookie lifetime /
  idle expiry and a server-side revoke path so a leaked read cookie is not indefinitely valid.

### F6 (LOW, SUSPECTED -- other repo) -- backend hand-off of job-input strings

- Where: `src/runpod-submit.ts` builds the RunPod job input from `project`, `bundle_key`,
  `pretrained_loras` (R2 keys), `process_shot_ids`. The control plane sanitizes the DERIVED project
  (`sanitizeKeySegment`) but forwards `bundle_key` raw (see F1), and `pretrained_loras` values are
  server-resolved from cast rows (safer). These are JSON-serialized into the RunPod API call (no shell
  injection at the submit layer itself).
- The seam: the backend `rp_handler.py` consumes these strings and may use them as file paths /
  subprocess args. If the backend does not treat every job-input string as untrusted, F1's raw
  `bundle_key` becomes a backend path/traversal issue.
- Fix: (control-plane half) land F1. (backend half, out of this repo's scope) confirm the handler
  treats `bundle_key`/`project`/`pretrained_loras` as untrusted before any path or process use. Flag
  to whoever owns `vivijure-backend`.

### F7 (INFO, CONFIRMED, by-design) -- spend rate limiter fails OPEN by default

- Where: `src/rate-limit.ts:10-11, 128-149`. If the limiter binding is unbound or `.limit()` throws,
  spend routes are ALLOWED + warned (denial-of-wallet exposure) unless `SPEND_LIMIT_FAIL_CLOSED=true`.
- This is a deliberate availability-over-wallet choice and clearly documented. Noting it so the
  operator knows: during a limiter outage the wallet is unprotected unless the fail-closed knob is set.
  Given Conrad self-funds GPU spend, consider defaulting `SPEND_LIMIT_FAIL_CLOSED=true` in the
  production `[vars]` (operator preference, not a code bug).

---

## What is solid (verified, so nobody re-audits it cold)

- Auth chokepoint: `index.ts:1284` gates the WHOLE `/api/` prefix; every `API_ROUTES` pattern is
  `/api/`-prefixed and `match()` uses the same `url.pathname` string as the gate, so there is no
  gate/route pathname desync. Non-`/api` studio pages are static HTML shells carrying no data.
- Token gate fail-closed on all branches: empty `STUDIO_API_TOKEN` -> 403 (`auth-gate.ts:112`);
  no/insufficient token -> 403; unknown `AUTH_MODE` -> 403 (`auth-gate.ts:147`); named-token D1 error
  or missing table -> deny (`auth-gate.ts:102`).
- Constant-time compare: `constantTimeEqual` hashes both sides (SHA-256) and XOR-folds fixed-length
  digests, always scanning all 32 bytes; neither length nor first-mismatch position leaks. Named-token
  lookup is hash-equality on a 256-bit random, no partial-match climb.
- Access-mode path (legacy/optional) verifies the RS256 signature against the team JWKS, checks
  exp/nbf/iss/aud, and fails closed on unverifiable tokens (`access-auth.ts`).
- Secret resolver fails closed: `secret-store.ts` returns "" on a failed store read, which trips every
  "not configured" guard (presign `configFromEnv` throws; RunPod submit gets an empty key -> upstream
  401). It logs `e.message` only, never a secret value.
- No secret VALUE is logged anywhere (grep clean). `deploy.sh` mints `STUDIO_API_TOKEN` as
  `openssl rand -hex 32` (256-bit) via `put_secret`, never echoed to logs.
- Presign safety: `isPresignSafeKey` blocks traversal/absolute/scheme/non-ASCII before signing
  (`shared.ts:28`, `r2-presign.ts:97`); expiry is clamped to [1, 604800]s (`clampExpires`); PUT keys
  are always core-derived, never module-chosen.
- Response security: single `applyResponseSecurity` chokepoint; non-page responses get
  `default-src 'none'` locked CSP; studio pages get a strict `script-src 'self'` CSP with no inline;
  `nosniff` + `frame-ancestors 'none'` + `x-frame-options: DENY` everywhere; NO
  `Access-Control-Allow-Origin` is ever set (no cross-origin allowance).
- Input bounds: <=50 scenes, <=50 prompt words, <=1024 full-prompt chars, <=300 dialogue chars,
  <=60s/scene, preflight <=24 (`storyboard-validate.ts`, `preflight.ts`).
- Module registry hardening: 1MB module-response cap; module failure is data (`ok:false`) not a crash;
  manifest validated (api version, name, hooks) before trust; the internal `binding`/transport is
  stripped from the public `/api/modules` payload (`toPublic`).

## Could NOT verify statically (recommend a live check)

1. That the edge path-scoped Access app on `/health` + `/welcome` is actually configured, and that the
   deleted whole-hostname Access app leaves the in-worker token gate as the sole (and sufficient) data-
   plane authority. The code is sound; the CF dashboard/IaC state is not visible from here.
2. F4 live: confirm a malformed `vivijure_token` cookie returns 500 (fail-closed) and not something
   permissive.
3. F6: the `vivijure-backend` `rp_handler.py` consumption of `bundle_key`/`project`/`pretrained_loras`
   as paths or subprocess args (separate repo).
4. That production `STUDIO_API_TOKEN` is the strong minted value and not a weak manual override, and
   that the real `wrangler.toml [vars]` sets `AUTH_MODE=token` with the limiter bound.
5. `api_tokens` under concurrency: `migrations/0009_api_tokens.sql` has a non-unique index on
   `token_hash`; a duplicate hash is astronomically unlikely at 256-bit, so this is a non-issue, but a
   `UNIQUE` constraint would make it structurally impossible.

## Priority order for fixes

1. F1 -- validate `bundleKey` with `isSafeRelKey` at the submit boundary (small, closes the one real
   inconsistency in the key-safety doctrine).
2. F2 -- document that named tokens are full-access + revocable, NOT scoped (before anyone hands one
   out). Doc change, my lane; happy to draft it.
3. F4 -- try/catch the cookie decode (tiny robustness fix).
4. F3 / F5 -- document the module trust grant and the read-cookie exposure in `docs/SECURITY.md`.
5. F7 -- operator decision on defaulting the spend fail-closed knob in prod.
