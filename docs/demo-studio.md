# The Public Demo Studio (`demo.vivijure.com`)

The demo studio is a **browse-first** deployment of the SAME studio Worker (`src/index.ts`), running at
**demo.vivijure.com** so anyone can browse the real catalog and watch finished showcase films without an
account or an operator token. Phase A bills no GPU second at all; Phase B (below) adds a capped
click-to-render and a capped OSS assistant.

It is a separate deploy from the production studio: its own Worker (`vivijure-demo`), its own D1, and
`AUTH_MODE=demo`. It shares NO bindings, secrets, or data with production.

## What "demo mode" is

`AUTH_MODE=demo` (a `[vars]` entry, EXPLICIT -- the gate fails closed on an unknown mode, v0.12.1)
flips four behaviors from ONE normalization (`isDemoMode` in `src/auth-gate.ts`; the structural twin
`isDemoEnv` in `@skyphusion-labs/vivijure-core modules/registry` -- change both together):

- **Reads open, writes denied.** Every `GET`/`HEAD` on `/api/*` is admitted at the gate as an
  anonymous `consumer`-scope visitor (`verifyDemoRequest`), so every `consumer`-scope read route is
  served. Routes declared `scope: "operator"` in `API_ROUTES` (e.g. `GET /api/storage/usage`,
  `GET /api/modules/installed`, `GET /api/modules/:name/config`) still answer
  `403 {"error":"insufficient scope: this credential is not authorized for this route","code":"scope_denied"}`
  (`authorizeRoute`, `src/authz.ts`). Every mutation except the two Phase B demo routes is denied at
  the gate with `403 {"error":"demo studio is read-only: mutations are disabled on this deployment. Run
  your own studio to render."}`. A presented token is ignored -- there is no operator path into a demo
  deploy, so a leaked/guessed token is worthless here.
- **`GET /api/modules` advertises `host.readonly: true`** (alongside `dispatch: false`; Phase B adds
  `render` and `assistant`, and a host missing a capability also carries `hooks_unavailable`). The
  frontend gates every mutation affordance on `host.readonly`, so the UI renders browse-only from the
  registry projection.
- **The catalog comes from the seeded `installed_modules` rows** (`discoverDispatchModules` demo
  exception, read via `discoverModules`), NOT from a dispatch namespace -- the demo binds none. The one
  exception is Phase B: the demo-scoped `MODULE_LOCAL_GPU` service binding is scanned live like any
  `MODULE_*` binding, and on the name collision with the seeded `local-gpu` row the live service
  binding wins (`mergeRegistries`).
- **CSP admits the showcase host.** `applyResponseSecurity` emits `STUDIO_DEMO_CSP`
  (`src/asset-response.ts`): the base studio CSP with `img-src` widened to include
  `https://assets.skyphusion.net` (the seeded cast portraits) plus an appended
  `media-src 'self' https://assets.skyphusion.net` (the seeded showcase MP4s). When `DEMO_ARTIFACT_ORIGIN`
  is set to a DIFFERENT origin, it is appended to that same `media-src` directive (never a wildcard).

The demo root also differs: in demo mode `GET /` (and `/index.html`) serves `planner.html` instead of
the module host (`resolveStudioPage`, `src/index.ts`); the module host stays reachable at `/modules`.

## The binding-absence rule (the zero-spend proof)

A demo deploy binds **ONLY** the demo D1 (`DB`) and the static `ASSETS`. It has **NO** AI, RunPod
secrets, R2 buckets, Secrets Store secrets, `MODULE_*` service bindings, `MODULE_DISPATCH` namespace,
VPC services, tail consumer, cron `[triggers]`, or rate-limit binding. That **absence is the proof**
that the demo cannot spend money: no code path can reach a GPU, an LLM, or storage.

> Every read path the demo exercises tolerates the absent bindings (the catalog is the seeded rows,
> the films are absolute `assets.skyphusion.net` URLs, and every write is denied at the gate before
> any binding is touched). If something at boot or deploy ever demands one of these bindings, that is
> a **BLOCKER to escalate, NOT a binding to add**. Adding a binding to silence a warning would spend
> money and break the promise this deploy exists to keep.

> **Phase B (#631) update:** the demo now also does bounded CLICK-TO-RENDER + a capped OSS assistant, so
> the invariant is no longer pure absence but **bounded spend in two disjoint families** (owned-GPU render
> + gateway-capped OSS tokens), with RunPod + frontier credits STILL zero by absence. See "Phase B" below
> for exactly what opens and what stays absent.

## Config

`wrangler.demo.toml.example` is the committed template (mirrors `wrangler.toml.example`
conventions: `account_id` is NEVER hardcoded, it is read from `CLOUDFLARE_ACCOUNT_ID`). The real
`wrangler.demo.toml` is gitignored and rendered BY HAND from the example: no CI workflow renders or
deploys the demo, so `D1_DEMO_DATABASE_ID` is a name you substitute locally, not a CI variable. Fill the
`${D1_DEMO_DATABASE_ID}` placeholder (the demo D1 id); at Phase B rollout also uncomment the Phase B
blocks and fill `${DEMO_SPEND_RATE_LIMITER_NS_ID}` (the `SPEND_RATE_LIMITER` namespace id) and the
`REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID` store id, e.g.:

```bash
D1_DEMO_DATABASE_ID=<id> envsubst '$D1_DEMO_DATABASE_ID' < wrangler.demo.toml.example > wrangler.demo.toml
```

The Phase B render door is a SECOND, separately deployed Worker, `vivijure-demo-local-gpu`, from
`modules/local-gpu/wrangler.demo.toml.example` (rendered to the gitignored
`modules/local-gpu/wrangler.demo.toml`; fill `REPLACE_WITH_DEMO_DOOR_HOSTNAME`). Its header carries the
deploy + `LOCAL_BACKEND_TOKEN` secret commands; the demo core binds it as `MODULE_LOCAL_GPU`.

## Provision + deploy (start to finish)

All commands run with `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` in the environment.

1. **Create the demo D1** (NEVER touch the prod `vivijure-studio` DB):

   ```bash
   wrangler d1 create vivijure-demo
   # paste the returned database_id into wrangler.demo.toml (the ${D1_DEMO_DATABASE_ID} placeholder)
   ```

2. **Apply the base schema** (every numbered migration at the top level of `migrations/`; the sequence
   skips `0004`):

   ```bash
   wrangler d1 migrations apply vivijure-demo --remote -c wrangler.demo.toml
   ```

3. **Apply the seed EXPLICITLY** (it lives under `migrations/demo/`, a subdirectory `wrangler d1
   migrations apply` does NOT scan, so it can never auto-apply to prod). The seed is idempotent
   (`INSERT OR IGNORE`, high explicit ids `>=9000`):

   ```bash
   wrangler d1 execute vivijure-demo --remote -c wrangler.demo.toml \
     --file=migrations/demo/0001_demo_seed.sql
   # REQUIRED: the Phase B tables every /api/demo/* route reads (demo_renderable, demo_render_queue,
   # demo_counter) + the seeded render menu. Without it GET /api/demo/menu (and the other demo routes)
   # answer 500 "internal error" (no such table). Idempotent (CREATE TABLE IF NOT EXISTS + INSERT OR IGNORE).
   wrangler d1 execute vivijure-demo --remote -c wrangler.demo.toml \
     --file=migrations/demo/0002_demo_render.sql
   # Cast portrait backfill. 0001 seeds portrait_key on a FRESH install, but a LIVE demo D1 that already
   # ran 0001 keeps its NULL portraits (0001 is INSERT OR IGNORE -- it never touches an existing row), so
   # this UPDATE backfills the standing cast rows. Idempotent (guarded by portrait_key IS NULL); a no-op
   # on a fresh install where 0001 already set them.
   wrangler d1 execute vivijure-demo --remote -c wrangler.demo.toml \
     --file=migrations/demo/0003_demo_cast_portraits.sql
   # Drop retired text-overlay catalog row on a LIVE demo D1 that already ran the old 0001 seed
   # (cf#24; 0001 no longer inserts it on fresh installs). Idempotent DELETE.
   wrangler d1 execute vivijure-demo --remote -c wrangler.demo.toml \
     --file=migrations/demo/0004_drop_text_overlay.sql
   ```

   > **Known deviation (#764, DM-2):** `migrations/demo/0005_beat_sync_door_copy.sql` updates column
   > `manifest`, but `installed_modules` has `manifest_json`, so it fails with "no such column"; do NOT
   > run it until it is fixed.

   Seeds: the 25 real module manifests (display-only, `script_name = demo-seed-<name>`, invocable by
   nothing; `text-overlay` retired, cf#24), plus browseable projects, cast (each with an absolute
   `assets.skyphusion.net` portrait image -- still no R2 binding), and COMPLETED render rows whose
   `output_key` is an absolute `assets.skyphusion.net` showcase MP4.

4. **Deploy the Worker** (creates the `demo.vivijure.com` custom domain -- Workers custom domains own
   DNS + the cert; a first-level subdomain under `vivijure.com` gets Universal SSL, NO ACM needed):

   ```bash
   wrangler deploy -c wrangler.demo.toml
   ```

   A green deploy of the committed template prints the Phase A bindings: `DB (vivijure-demo)`, `ASSETS`,
   and the `[vars]` `AUTH_MODE ("demo")`, `DEMO_RENDER_ENABLED ("false")`, `DEMO_ARTIFACT_ORIGIN`, and
   `DEMO_ASSISTANT_MODEL` (the Phase B knobs ship set but inert). Phase B adds exactly the bindings under
   "Binding delta" below. If it prints any other binding, the config drifted -- stop.

## Phase B: click-to-render + assistant (#631)

Phase B turns the read-only demo into a **bounded** click-to-render demo, without reopening the two spend
families the demo exists to keep at zero.

**Render (constraints 1-5).** A visitor picks ONE **seeded** scene from the menu (`GET /api/demo/menu`,
projected from the `demo_renderable` rows) and `POST /api/demo/render {scene}` renders ONE LTX i2v clip on
the standing Vultr vGPU box via a **demo-scoped `local-gpu` door** (`MODULE_LOCAL_GPU`). The render is
SERIAL (one box, global concurrency 1) with an honest FIFO queue: `GET /api/demo/render/:id` reports
`queued` (+ position + wait), `running`, `done` (+ the public clip URL), or `failed`. A depth cap refuses
enqueue past ~10 ("queue is full"); per-IP + global daily caps (`demo_counter`) + the per-IP burst limiter
(`SPEND_RATE_LIMITER`) bound abuse. The box reads the seeded keyframe from an **isolated demo R2 prefix**
and writes the clip there; the demo builds the artifact URL as `DEMO_ARTIFACT_ORIGIN/<clip_key>` and binds
**no** R2 itself. When the box is **unconfigured** (`DEMO_RENDER_ENABLED != "true"` or `MODULE_LOCAL_GPU`
unbound) the demo reports **renders paused** (`host.render.available=false`); browse keeps working and
submit is refused plainly -- the swappable-backend state for the box's ~2026-08-04 credit horizon.
`hDemoRender` runs the fail-closed burst limiter (`enforceSpendLimit`) BEFORE the paused check, so the
`503 {reason:"paused"}` reply is only reachable with `SPEND_RATE_LIMITER` bound; with it unbound (Phase A,
default `SPEND_LIMIT_FAIL_CLOSED`) every submit answers `503 {"error":"spend limiter unavailable
(fail-closed posture); renders are blocked until the limiter binding is fixed"}` with no `reason` field.

> **Open question (#764, DM-14):** the Vultr box and its ~2026-08-04 credit horizon named above are past
> that date; whether the box still stands (and what backs the demo door now) is an owner call.

**Honesty (`host.render.available`, cf#28):** that flag is **configured**, not **live-healthy**. It is
true when the var is set and the door binding exists; it does **not** ping propagandhi (or any door
box). A configured-but-down box still advertises `available=true` and fails honestly at submit. Spend
stays safe (caps before spend, seeded scenes only, no RunPod). Prefer a real door health signal later
if the public shop window needs greyed CTAs; until then, treat `available` as "armed in config".

**CSAM by construction (constraint 4).** The visitor's ENTIRE input is a seeded scene id -- no free text,
no uploads. Every prompt + keyframe is curator-vetted, so the bright line is satisfied structurally, not by
a filter.

**Assistant (constraints 6-9).** `POST /api/demo/chat {message}` runs a demo-scoped OSS model
(`DEMO_ASSISTANT_MODEL`, a Workers-AI llama-3.3-70b class) behind its OWN hard-capped AI Gateway
(`GATEWAY_ID` = the demo gateway, which carries the hard daily budget). Per-IP + global daily caps
(`demo_counter`) are checked BEFORE the model call, so an exhausted visitor spends zero tokens; the cap
reply is plain text and browse keeps working (honest exhaustion). The prompt is demo-scoped with a low
output cap and NO tool/binding reach beyond read-only studio state. `GET /api/modules` projects
`host.assistant = { model: "oss", note: "..." }` so the "free model" note renders wherever the assistant
surfaces (constraint 9).

**Anti-proxy posture (cf#31):** the design rests the "structurally worthless as a free public LLM
proxy" claim on **caps + gateway budget**, not on prompt obedience alone. Soft off-topic still can
elicit an on-topic-to-the-attacker essay when the model ignores the system prompt -- that is
accepted and bounded by economics. Clear jailbreak / free-LLM shapes (e.g. "ignore prior
instructions... write a 500-word essay") are **hard-refused before any counter bump or model call**
so they do not burn the visitor's daily budget; soft off-topic remains prompt-advisory only.

**The write surface** is exactly two routes: `POST /api/demo/render` and `POST /api/demo/chat`
(`DEMO_WRITE_ROUTES` in `src/auth-gate.ts`). Every other mutation -- including the prod render/plan/chat
routes -- stays denied by `verifyDemoRequest`.

### Binding delta (what OPENS vs what STAYS ABSENT)

**Opens** (added to the Phase-A `DB` + `ASSETS`): `MODULE_LOCAL_GPU` (the demo-scoped local-gpu door),
`AI` + `GATEWAY_ID` (the demo gateway), `SPEND_RATE_LIMITER`, and the `DEMO_*` vars; the demo D1 gains the
`0002_demo_render.sql` tables (`demo_renderable`, `demo_render_queue`, `demo_counter`).

**Stays absent** (still the proof): `RUNPOD_*`, every frontier BYOK key, `R2` / `R2_RENDERS` / `R2_S3_*`,
the CPU-container VPCs, `MODULE_DISPATCH` + every other `MODULE_*`, cron `[triggers]`, tail, `STUDIO_API_TOKEN`.

### Rollout (gated through the lead)

The isolated demo R2 prefix creds, the regenerated `LOCAL_BACKEND_TOKEN`, the stable **named** box tunnel,
and the demo AI Gateway id are minted/provisioned by the lead/infra and WIRED into the rendered
`wrangler.demo.toml` + the demo-scoped local-gpu worker (values never in CI, never in a transcript). The
seeded `demo_renderable` rows carry `REPLACE_WITH_*` keyframe placeholders until the curator keyframes are
uploaded to the demo prefix; an unresolved placeholder fails the render honestly, never a silent success.
**A fresh adversarial security pass on the LIVE demo is a Phase B SHIP GATE** (the write surface went from
zero routes to two; the Phase A verdict does not carry over).

## Live verify (assert on JSON/headers, not prose)

| # | Request | Expect |
|---|---------|--------|
| 1 | `GET /api/modules` | `200`, one module per enabled seeded `installed_modules` row (25 as of v1.33.9), `host` contains `dispatch:false, readonly:true` |
| 2 | `POST /api/render/film` | `403` with reason `demo studio is read-only: ...` |
| 2b | `GET /api/modules/installed` (an operator-scope read) | `403`, `code: "scope_denied"` |
| 3 | `GET /planner` | `200` HTML, `content-security-policy` contains `media-src 'self' https://assets.skyphusion.net` |
| 3b | `GET /cast` (or `/planner`) | `200` HTML, `content-security-policy` `img-src` contains `https://assets.skyphusion.net`; the cast list shows all 4 portraits, no CSP violation in the console |
| 4 | a seeded render's `output_key` (an `assets.skyphusion.net` showcase mp4) | `curl -I` -> `200` |
| 4b | a seeded cast `portrait_key` (e.g. `.../vivijure/showcase/cast/kesh.jpg`) | `curl -I` -> `200` |
| 5 | `GET /` (root) | `200`, serves the planner page (`planner.html`), loads unauthenticated (no token prompt) |
| 6 | `GET /api/demo/menu` | `200`, `scenes: [...]` seeded; `available` reflects `DEMO_RENDER_ENABLED` + the door |
| 7 | `POST /api/demo/render {scene:<seeded id>}` when paused | with `SPEND_RATE_LIMITER` bound: `503` reason `paused` (renders paused; browse still 200). With it unbound: `503` `spend limiter unavailable (fail-closed posture)...`, no `reason` (the limiter runs first) |
| 8 | `POST /api/render/film` (a prod write route) | `403` read-only (the carve-out is ONLY the two demo routes) |
| 9 | `GET /api/modules` in Phase B | `host.render.available` present; `host.assistant.{model,note}` present when `aiGatewayReady` (AI + gateway usable) |
| 10 | `GET /api/storyboard/models` | `200` with `{"models":[]}` -- a demo never advertises frontier planning models it cannot invoke |
| 11 | `GET /api/voices` | `200` with `{"voices":[]}` -- the same honesty rule for the TTS voice catalog |

> Note: for the first few seconds after the custom domain provisions, the edge may return a
> transient `500 (error code 1104)` while the cert warms; retry and it clears.
