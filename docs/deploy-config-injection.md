# Deploy-time config injection: `wrangler.toml.example` -> rendered `wrangler.toml`

How vivijure keeps account-specific config (the CF Access AUD, resource IDs) **out of the public
repo** while still deploying a complete `wrangler.toml`. The committed file is a **template**; the
real file is **rendered at deploy** from encrypted CI secrets. This doc is written so you can
reproduce the pattern in any repo from the doc alone.

If you know Jenkins, you already know this pattern under different names. The map is in section 2.

---

## 1. The problem and the shape of the fix

`wrangler.toml` mixes two kinds of content:

- **Structure** (safe to publish): binding *names* (`R2_RENDERS`, `DB`, `MODULE_*`), the worker name,
  route patterns, the module service names. This is the useful, readable shape of the worker.
- **Account-specific values** (do not publish): the CF Access **AUD**, the D1 `database_id`, the
  Workers-VPC `service_id`s, the rate-limit `namespace_id`, the Secrets Store id. None is a
  *credential* (you still need a signed JWT / API token to do anything), but they are account-internal
  identifiers, and the AUD in particular is the thing we just spent effort getting out of the public surface.

vivijure is a **public** repo. So we:

1. Commit `wrangler.toml.example` -- the full file with the account-specific values replaced by
   `${PLACEHOLDER}` tokens (and two non-`${}` fills, see 3a). Structure stays visible.
2. **Stop tracking** the real `wrangler.toml` (`.gitignore` + `git rm --cached`). It still lives on
   disk and on the deployed worker; it just leaves git history.
3. The deploy workflow **renders** the real `wrangler.toml` from the template at build time, filling
   the placeholders from **encrypted GitHub Actions secrets** (and repo variables), then runs
   `wrangler deploy`.

Net: the public repo shows the binding structure; the opaque IDs live only in the encrypted secret
store / repo variables and on the live worker.

---

## 2. Jenkins -> GitHub Actions (the part to internalize)

This is the same "inject config at build from a secret store" pattern you ran in Jenkins. The names
change; the moving parts do not.

| Jenkins | GitHub Actions | In this repo |
|---|---|---|
| Credentials store (Manage Jenkins -> Credentials) / secret files on the controller | **Encrypted repository secrets** (repo Settings -> Secrets and variables -> Actions) | `ACCESS_AUD`, `VPC_*_ID`, ... |
| Non-secret build parameters | **Repository variables** (same page, Variables tab; readable in logs) | `AUTH_MODE`, `SECRETS_STORE_ID`, `ENABLE_WFP_DISPATCH`, `R2_S3_BUCKET` |
| Config File Provider / `withCredentials` writing a file at build | The **render step** (`envsubst` + `sed`) in the workflow | `Render core wrangler.toml` step in `ci.yml` |
| Build agent / node | GitHub-hosted **runner** (here a `node:22-alpine` container on `ubuntu-latest`) | `runs-on: ubuntu-latest`, `container: node:22-alpine` |
| Pipeline `stage { }` | A **job** (`jobs:`) made of **steps** (`steps:`) | `ci` job, `deploy` job |
| "Only deploy on a release tag" (`when { tag }`) | A job/step **condition** | `if: startsWith(github.ref, 'refs/tags/v')` |
| Secrets masked in console output | Secrets **auto-masked** in logs; **write-only** (you cannot read them back, only overwrite) | -- |
| `Jenkinsfile` in the repo | **Workflow YAML** in `.github/workflows/` | `.github/workflows/ci.yml` |

Two Jenkins instincts to drop:
- GitHub secrets are **write-only**. You set them; you cannot read them back in the UI or API. Lost
  the value? Re-set it. (Keep the source of truth in your encrypted store -- here, crew-secrets.)
- The runner is **ephemeral** and **fork-safe**. vivijure takes outside PRs, so CI runs on a
  GitHub-hosted sandbox, and **secrets are NOT exposed to pull-request runs from forks** -- only to
  trusted events (push/tag on the base repo). That is exactly why deploy is gated to tags (section 4).

---

## 3. The pieces, walked

### 3a. `wrangler.toml.example` (the template, committed)
A copy of the working `wrangler.toml` with **only** the account-specific values turned into fill
tokens. The render fills three ways: `${NAME}` envsubst tokens, a `sed` on the Secrets Store id, and
a conditional uncomment of the Workers-for-Platforms block.

**`${NAME}` envsubst tokens** -- and why each is a value not structure:

| Placeholder | What it is |
|---|---|
| `${AUTH_MODE}` | the #423 auth-gate mode: `token` (the default, including our prod) or `access` (optional hardening) |
| `${ACCESS_TEAM_DOMAIN}` | Zero-Trust team hostname (`<team>.cloudflareaccess.com`) -- F2 JWT `iss` check (access mode) |
| `${ACCESS_AUD}` | the vivijure Access application AUD -- F2 JWT `aud` check (access mode) |
| `${D1_DATABASE_ID}` | the D1 database UUID |
| `${VPC_VIDEO_FINISH_ID}` / `${VPC_IMAGE_PREP_ID}` / `${VPC_AUDIO_BEAT_SYNC_ID}` / `${VPC_AUDIO_MIX_ID}` | Workers-VPC service IDs |
| `${SPEND_RATE_LIMITER_NS_ID}` | the rate-limit namespace id |
| `${R2_S3_ENDPOINT}` | the account-scoped R2 S3 API host (`https://<account-id>.r2.cloudflarestorage.com`), an identifier the render DERIVES from `CLOUDFLARE_ACCOUNT_ID` -- not stored anywhere (#238 follow-up) |
| `${R2_S3_BUCKET}` | the render bucket name the S3 presign targets; defaults to `vivijure` (the `R2_RENDERS` bucket), overridable via the optional `R2_S3_BUCKET` repo variable |

**Two fills that are NOT `${}` tokens** (kept out of envsubst so the committed template stays
free-self-host-safe by default):

- **The Secrets Store id.** The `[[secrets_store_secrets]]` blocks ship with
  `store_id = "REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID"` -- a literal marker, so no real store id sits
  in the public repo (#398). The render `sed`-fills it from the `SECRETS_STORE_ID` **repo variable**
  and fails closed if any `REPLACE_WITH_` marker survives. The module deploy loop fills the same
  marker in every `modules/*/wrangler.toml` before it deploys that module.
- **The WfP dispatch block.** The `[[dispatch_namespaces]]` block ships **commented out**. The render
  UNCOMMENTS it ONLY when the `ENABLE_WFP_DISPATCH` repo variable is `1` (this account created the
  `vivijure-modules` namespace out of band). A community self-host never sets that variable, so the
  block stays commented and the core deploys on the free plan with zero WfP dependency. See
  [deploy-runbook.md](deploy-runbook.md) "Phase 3".

`account_id` is **not** in the file at all -- wrangler reads it from `CLOUDFLARE_ACCOUNT_ID` (already a
CI secret), the cleaner mechanism; the render also reuses it to build `${R2_S3_ENDPOINT}`. Binding
names, bucket names, the route pattern, and the module service names are **kept literal** -- they are
the readable structure and are not sensitive.

### 3b. Stop tracking the real file
```
# .gitignore
/wrangler.toml
```
```
git rm --cached wrangler.toml      # untrack; the file STAYS on disk and on the deployed worker
```
A fresh clone will not have `wrangler.toml`; you render it (section 5). The `.example` is the source
of truth from now on -- **edit the `.example`, not the real file**, or your change never reaches CI.

### 3c. The secrets and variables
Set once. Sensitive IDs go in **secrets** (write-only; values come from the encrypted store, never
typed into a PR); non-sensitive build parameters go in **variables** (readable in logs):
```
printf '%s' "$VALUE" | gh secret set ACCESS_AUD --repo skyphusion-labs/vivijure
gh variable set AUTH_MODE --repo skyphusion-labs/vivijure --body token
gh variable set SECRETS_STORE_ID --repo skyphusion-labs/vivijure --body "<store-id>"
gh secret list  --repo skyphusion-labs/vivijure        # names only; values are not readable
gh variable list --repo skyphusion-labs/vivijure
```
> Which is which here: `AUTH_MODE`, `SECRETS_STORE_ID`, `ENABLE_WFP_DISPATCH`, and the optional
> `R2_S3_BUCKET` are **variables** (identifiers / switches, not sensitive -- the Secrets Store id was
> public in the repo before #398 templated it out). The AUD, the D1/VPC/rate-limit ids stay
> **secrets**. The workflow reads `${{ vars.NAME }}` for variables and `${{ secrets.NAME }}` for secrets.

### 3d. The render step (`.github/workflows/ci.yml`, before `Apply D1 migrations`)
The authoritative step is `ci.yml`; this is its shape (guards abbreviated). It fills all three ways
described in 3a and fails closed at each:
```yaml
- name: Render core wrangler.toml
  env:
    AUTH_MODE:                ${{ vars.AUTH_MODE }}        # a VARIABLE; unset -> render FAILS LOUD (no default)
    ACCESS_TEAM_DOMAIN:       ${{ secrets.ACCESS_TEAM_DOMAIN }}
    ACCESS_AUD:               ${{ secrets.ACCESS_AUD }}
    D1_DATABASE_ID:           ${{ secrets.D1_DATABASE_ID }}
    VPC_VIDEO_FINISH_ID:      ${{ secrets.VPC_VIDEO_FINISH_ID }}
    VPC_IMAGE_PREP_ID:        ${{ secrets.VPC_IMAGE_PREP_ID }}
    VPC_AUDIO_BEAT_SYNC_ID:   ${{ secrets.VPC_AUDIO_BEAT_SYNC_ID }}
    VPC_AUDIO_MIX_ID:         ${{ secrets.VPC_AUDIO_MIX_ID }}
    SPEND_RATE_LIMITER_NS_ID: ${{ secrets.SPEND_RATE_LIMITER_NS_ID }}
    SECRETS_STORE_ID:         ${{ vars.SECRETS_STORE_ID }}       # sed-fill target (3a)
    ENABLE_WFP_DISPATCH:      ${{ vars.ENABLE_WFP_DISPATCH }}     # opt-in uncomment (3a)
    CLOUDFLARE_ACCOUNT_ID:    ${{ secrets.CLOUDFLARE_ACCOUNT_ID }} # also builds R2_S3_ENDPOINT
    R2_S3_BUCKET:             ${{ vars.R2_S3_BUCKET }}            # optional override; unset -> vivijure
  run: |
    set -eu
    apk add --no-cache gettext >/dev/null                 # node:22-alpine has no envsubst; gettext provides it
    # 1) AUTH_MODE must be set -- no default (a silent default would mis-posture prod: the edge Access app was removed at v0.12.0).
    [ -n "${AUTH_MODE:-}" ] || { echo "::error::AUTH_MODE unset"; exit 1; }; export AUTH_MODE
    # 2) Derive the account-scoped R2 S3 endpoint (an identifier, not a secret). Fail closed on an empty account.
    [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ] || { echo "::error::CLOUDFLARE_ACCOUNT_ID unset"; exit 1; }
    R2_S3_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com"; export R2_S3_ENDPOINT
    R2_S3_BUCKET="${R2_S3_BUCKET:-vivijure}"; export R2_S3_BUCKET
    # 3) envsubst ONLY the listed tokens; any other ${...} in the file is left alone.
    VARS='$AUTH_MODE $ACCESS_TEAM_DOMAIN $ACCESS_AUD $D1_DATABASE_ID $VPC_VIDEO_FINISH_ID $VPC_IMAGE_PREP_ID $VPC_AUDIO_BEAT_SYNC_ID $VPC_AUDIO_MIX_ID $SPEND_RATE_LIMITER_NS_ID $R2_S3_ENDPOINT $R2_S3_BUCKET'
    envsubst "$VARS" < wrangler.toml.example > wrangler.toml
    # 4) No placeholder may survive OUTSIDE comments (a missing secret leaves a literal ${...}); comment
    #    prose mentioning ${...} is fine. -F keeps '${' literal on every grep (GNU vs busybox differ).
    if grep -v '^[[:space:]]*#' wrangler.toml | grep -qF '${'; then echo "::error::unsubstituted placeholder"; exit 1; fi
    # 5) Mode-aware auth guard: AUTH_MODE non-empty always; access mode also needs the Access vars non-empty
    #    (a blank would un-arm the in-worker gate -> DENY 503). Plus the R2 endpoint must be a well-formed host.
    grep -Eq 'AUTH_MODE = ".+"' wrangler.toml || { echo "::error::AUTH_MODE empty"; exit 1; }
    if [ "$AUTH_MODE" = access ]; then
      grep -Eq 'ACCESS_AUD = ".+"' wrangler.toml && grep -Eq 'ACCESS_TEAM_DOMAIN = ".+"' wrangler.toml || { echo "::error::F2 vars empty"; exit 1; }
    fi
    grep -Eq 'R2_S3_ENDPOINT = "https://[0-9a-f]+\.r2\.cloudflarestorage\.com"' wrangler.toml || { echo "::error::R2_S3_ENDPOINT malformed"; exit 1; }
    # 6) Opt-in WfP: uncomment the [[dispatch_namespaces]] block ONLY when ENABLE_WFP_DISPATCH=1 (namespace pre-created).
    if [ "${ENABLE_WFP_DISPATCH:-}" = 1 ]; then
      sed -i -e 's/^# \(\[\[dispatch_namespaces\]\]\)$/\1/' -e 's/^# \(binding = "MODULE_DISPATCH"\)$/\1/' -e 's/^# \(namespace = "vivijure-modules"\)$/\1/' wrangler.toml
    fi
    # 7) sed-fill the Secrets Store id (core [[secrets_store_secrets]]) from the repo variable; fail closed on a survivor.
    [ -n "${SECRETS_STORE_ID:-}" ] || { echo "::error::SECRETS_STORE_ID unset"; exit 1; }
    sed -i "s/REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID/${SECRETS_STORE_ID}/g" wrangler.toml
    grep -q "REPLACE_WITH_" wrangler.toml && { echo "::error::store_id placeholder survived"; exit 1; } || true
```
Things worth understanding:
- **`apk add gettext`**: Alpine ships no `envsubst`. On a stock `ubuntu-latest` (no container) it is
  already present and you can drop this line.
- **Explicit `VARS` list** (the SHELL-FORMAT arg to `envsubst`): without it, `envsubst` substitutes
  *every* `${...}` it finds, which can clobber unrelated tokens (and the commented WfP block). Listing
  only ours means any other `${...}` in the file is left alone. Safer and self-documenting.
- **Three fills, all fail-closed**: envsubst for the `${}` tokens, a `sed` for the Secrets Store id,
  and a conditional uncomment for WfP. A missing secret leaves a literal `${NAME}` (caught by grep); a
  *blank* secret renders empty and the mode-aware guard rejects it where it matters (`AUTH_MODE`, and
  the Access vars in access mode); a stray `REPLACE_WITH_` marker fails the store-id fill.
- The **module deploy loop** (earlier in the `deploy` job) does the same `SECRETS_STORE_ID` sed-fill
  per `modules/*/wrangler.toml`, plus a `REPLACE_WITH_VPC_*_ID` fill for the media modules (#520),
  before each `wrangler deploy` -- the same free-self-host-safe placeholder discipline as the core.

### 3d-bis. HOW MANY PATHS RENDER THIS TEMPLATE (cf#560)

> **Superseded in part by 3d-ter below.** This section is accurate about renders of
> `wrangler.toml.example` and that is the WRONG POPULATION for the invariant. Read 3d-ter first.

Section 3d calls `ci.yml` "the authoritative step". That is true of the PROD STUDIO DEPLOY and it is
not true of the template, and the difference cost cf#560 twice. `wrangler.toml.example` is rendered
by more than one thing, the hosted invariant that local-gpu is never bound applies to more than one
of them, and until cf#560 was reopened nobody knew the count. **A gate that passes because it was
never asked is not evidence.**

**The rule, not a frozen list** (a hand-maintained list of paths is the artifact whose drift caused
this issue twice): a path is a HOSTED render if it produces a `wrangler.toml` from
`wrangler.toml.example` for a deploy that runs on OUR account or ships to a hosted tenant. Derive
the current members rather than trusting this table; `tests/local-gpu-strip-cf560.test.ts` derives
the workflow half automatically and refuses if a member does not call the shared strip.

| Path | Kind | local-gpu | Mechanism |
|---|---|---|---|
| `.github/workflows/ci.yml` | HOSTED, prod studio deploy | forbidden | calls `scripts/strip-local-gpu.sh`, unconditionally |
| `.github/workflows/studio-release.yml` | HOSTED, the tenant release artifact | forbidden | calls `scripts/strip-local-gpu.sh`, unconditionally |
| `deploy.sh` | SELF-HOST installer | **allowed** | its own strip, kept unless `INSTALL_LOCAL_GPU=1` |
| `deploy/vivijure_deploy.py` (`render_core_toml`) | SELF-HOST installer (python) | allowed | no marker handling at all; see the note below |
| `.dev-modbound/dev-modbound.sh` | LOCAL dev only | n/a | `wrangler dev --local`, never deploys |

Two configs are NOT renders of this template and must not be reasoned about as though they were:
`wrangler.demo.toml.example` builds the separate `vivijure-demo` Worker, and `tail/wrangler.toml.example`
builds `vivijure-tail`.

**The self-host paths are a considered exclusion, not an omission.** The door's own manifest says
self-host is where it belongs, so an unconditional hosted strip bolted onto `deploy.sh` would remove
a door its operator is entitled to run. Note the inversion that was the original defect: the path
that PERMITS the door defaulted it off, and the path that FORBIDS it had no switch at all.

**Open, and deliberately not fixed here (reported on cf#560):** `render_core_toml` in
`deploy/vivijure_deploy.py` strips `[[vpc_services]]`, `tail_consumers`, `[[routes]]` and
`[[migrations]]` on the stated contract that it removes "every binding whose target a base install
does not create", and it has zero occurrences of `LOCAL-GPU`, `SATELLITE` or `SELFHOST-SKIP`. So it
leaves the `MODULE_LOCAL_GPU` service binding in place against its own contract. That is a dangling
binding on a self-host install, a different defect from the hosted invariant, and it belongs in its
own change rather than folded into this one.

### 3d-ter. THE RIGHT DENOMINATOR: hosted STUDIOS, not renders of one template (cf#560)

**Section 3d-bis counts the wrong population, and its heading says so.** It asks how many paths render
`wrangler.toml.example`. The invariant does not mention that file: `scripts/strip-local-gpu.sh` states
it as **the HOSTED studio never binds local-gpu**, which is a claim about STUDIOS. Deriving the
population from one template answers a narrower question and then reads as coverage of the wider one.
That is the cf#560 shape itself, applied to the fix for cf#560.

**The inclusion rule** (derive the members, never trust the table). An artifact is in the population
if it does any of: (a) writes any `wrangler*.toml`; (b) invokes a wrangler publish verb against a
config it or its direct caller produced; (c) builds or publishes a studio, tenant, or module release
artifact or manifest; (d) provisions a live studio surface (installs a module, advances the tenant
release pin). Docs and tests are excluded: they describe, they do not execute. HOSTED = produces or
provisions a studio we or a tenant operate. SELF-HOST = the operator own account (self-host), where this door is
legitimately allowed.

**By UNION across independent axes, never by grepping `local-gpu`.** Grepping the door name selects
only the paths that already handle it, so the broken path drops out of its own population and the
assertion vanishes rather than fails. Axis denominators as measured: tracked `*.toml.example` **5**;
files naming `toml.example` **35**; files containing `envsubst` **9**; workflow files **8 of 8
enumerated and classified, none skipped**.

**The count: 11 HOSTED of 19 render-or-provision sites. 2 of the 11 invoke the shared strip.**

That is not nine gaps. It is nine paths whose control is something other than the strip, and the
point of writing it down is that six of them had never been counted at all:

| Hosted path | What keeps local-gpu out |
|---|---|
| `ci.yml` core render | `scripts/strip-local-gpu.sh`, unconditional |
| `studio-release.yml` core render (and the `--dry-run` bundle it feeds) | the same script, unconditional |
| `scripts/deploy-module-workers.sh` (module workers to our account) | `export EXCLUDE="... local-gpu"` in `ci.yml`, honoured at `deploy-module-workers.sh:57` |
| `scripts/fill-module-placeholders.sh` | runs inside the loop above; inherits its exclusion |
| tenant module bundles in `studio-release.yml` | `scripts/tenant-release-modules.txt`, which does not list the door |
| `ci.yml` MCP render (`wrangler.mcp.toml.example`) | structural: that template carries **0** `MODULE_` lines, so the strip would refuse it at its own floor |
| `scripts/advance-studio-pin.sh` | renders no config; advances a pin |
| `scripts/install-module.ts` | renders no config; installs into a live studio over the dispatch namespace |
| `wrangler.demo.toml.example` + `modules/local-gpu/wrangler.demo.toml.example` | **a named carve-out, see below** |

Until this revision, only the first two were asserted anywhere. The third and fifth now are
(`tests/local-gpu-strip-cf560.test.ts`), including that the deployer actually READS `EXCLUDE` rather
than the caller merely setting it.

**The demo studio is a deliberate carve-out, not a violation, and it is OUT OF SCOPE by ruling.**
`vivijure-demo` is a studio we operate and its template does describe a `MODULE_LOCAL_GPU` binding.
It is the #631 Phase B click-to-render design: in the committed template the binding is COMMENTED OUT
and `DEMO_RENDER_ENABLED = "false"`. It is invisible to every cf#560 control by construction (different
template, no workflow renders it, hand-deployed). Conrad ruled 2026-08-15 that the demo surface is not
a priority and will be rebuilt, so **do not strip it and do not probe it**. It is recorded here so the
next reader finds a decision rather than a hole. What is genuinely undetermined is whether the LIVE
`vivijure-demo` Worker binds it today; `wrangler.demo.toml` is gitignored, so that needs a live
binding read, not a repo read, and nobody should take one on this ruling.

**Two limits of the automated derivation, stated because a named limit is cheaper than a rediscovery:**
`tests/local-gpu-strip-cf560.test.ts` reads only `.github/workflows/*.yml`, non-recursively, so a
hosted render moved into a shell script or a composite action leaves its population; and it selects on
`wrangler.toml.example`, so a second template (the MCP and demo ones) is structurally unreachable to
it. Both classes are live in this repo today. The rule above, not that matcher, is the contract.

### 3e. The deploy gate
The `deploy` job only runs for a pushed version tag:
```yaml
if: startsWith(github.ref, 'refs/tags/v')
```
A bare merge to `main` runs `ci` (typecheck + test) but never deploys -- so a docs merge cannot
redeploy prod or unset F2. Releases are deliberate: `git tag v0.x.y && git push origin v0.x.y`.

---

## 4. Reproduce this for another repo (recipe)
1. `cp wrangler.toml wrangler.toml.example`, then replace each account-specific value with `${NAME}`
   (or a `REPLACE_WITH_*` marker for anything filled by `sed` rather than envsubst). Keep binding
   names / structure literal. Decide value-vs-structure with the section-3a question: "would another
   account need a different value here?"
2. Render locally and **diff until byte-identical** (section 6) -- proves you parameterized exactly
   the values and nothing structural.
3. `echo "/wrangler.toml" >> .gitignore` and `git rm --cached wrangler.toml`.
4. `gh secret set` / `gh variable set` each placeholder (from your encrypted store).
5. Add the render step before `wrangler deploy` in the workflow (copy 3d; drop `apk add` if not Alpine).
6. Commit `wrangler.toml.example`, `.gitignore`, the workflow. The real `wrangler.toml` stays local.

---

## 5. Local development
A fresh clone has no `wrangler.toml`. Render it once (token mode needs no `ACCESS_*`; derive the R2
endpoint from your account id, and fill the Secrets Store id):
```
export AUTH_MODE=token D1_DATABASE_ID=... CLOUDFLARE_ACCOUNT_ID=...
export ACCESS_TEAM_DOMAIN= ACCESS_AUD=
export R2_S3_ENDPOINT="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com" R2_S3_BUCKET=vivijure
VARS='$AUTH_MODE $ACCESS_TEAM_DOMAIN $ACCESS_AUD $D1_DATABASE_ID $VPC_VIDEO_FINISH_ID $VPC_IMAGE_PREP_ID $VPC_AUDIO_BEAT_SYNC_ID $VPC_AUDIO_MIX_ID $SPEND_RATE_LIMITER_NS_ID $R2_S3_ENDPOINT $R2_S3_BUCKET'
envsubst "$VARS" < wrangler.toml.example > wrangler.toml
sed -i "s/REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID/<your-store-id>/g" wrangler.toml
```

(`./deploy.sh` performs exactly this render for you -- including the profile strip, the workers.dev
branch, the store-id fill, and the R2 endpoint derivation -- so the manual export is only for driving
`wrangler dev` against a hand-rendered config.)
`CLOUDFLARE_ACCOUNT_ID` and any `wrangler secret`s go in `.dev.vars` (also gitignored) for
`wrangler dev`. After editing bindings: **edit `wrangler.toml.example`**, then re-render.

---

## 6. Safety checks
- **Byte-identical render** (the proof you parameterized correctly, and that the render reproduces the
  *armed* config -- critical, since a wrong AUD or a dropped F2 var would break Access):
  ```
  envsubst "$VARS" < wrangler.toml.example > /tmp/r.toml
  sed -i "s/REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID/<your-store-id>/g" /tmp/r.toml
  diff wrangler.toml /tmp/r.toml && echo IDENTICAL
  ```
- **Rotation**: change a value in your store -> `gh secret set NAME` -> cut a release tag. The next
  deploy renders the new value. Nothing in git changes.
- **Auth invariant (mode-aware, #423)**: `AUTH_MODE` must render non-empty, and in access mode
  `ACCESS_TEAM_DOMAIN` + `ACCESS_AUD` must render non-empty too, or the worker denies `/api` (503).
  The render step enforces both; the external watchdog (`skyphusion-monitor`) catches a regression
  within ~5 min from outside.

## 7. Gotchas
- Alpine has no `envsubst` -> `apk add gettext`.
- Without the explicit `VARS` list, `envsubst` eats *all* `${...}` -- including the commented WfP block.
- The Secrets Store id is a `sed` fill of a `REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID` marker, NOT a
  `${}` envsubst token; the WfP block is a conditional uncomment, NOT envsubst. Do not "simplify" either
  into a `${}` token, or the committed template stops being free-self-host-safe by default.
- GitHub secrets are write-only -- keep the source of truth in your encrypted store.
- Fork PRs do not get secrets -> the render/deploy only works on trusted (tag) runs, which is why
  deploy is tag-gated.
- Edit the `.example`, never the rendered file -- the rendered one is gitignored and overwritten.
