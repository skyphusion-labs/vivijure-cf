# Changelog

Notable changes per release. SemVer-style (pre-1.0: PATCH for fixes / backend-only tweaks, MINOR
for new features). Newest first.

## Unreleased

### feat(renders): record motion_backend + keyframe_backend on the render library row (cf#393)

A completed render carried no motion backend, so "which backend rendered this film?" was
unanswerable from stored data (searching for `own-gpu` or `seedance` returned zero even when
those backends had run). Clip keys are GPU-assigned and are not a substitute.

- Migration `0018_render_motion_backend.sql`: additive `renders.motion_backend` + `keyframe_backend` TEXT.
- Submit/finalize/from-keyframes/film insert paths pass the resolved module names into `insertRender`.
- Read path is in vivijure-core (companion PR); hosts pin after core publishes.

**Dual-panel:** vivijure-local needs the same SQLite columns later.


**Dual-panel release gate:** every studio feature ships to vivijure-cf and vivijure-local in the
same release wave ([[vivijure-hosted-parity-absolute]] in fleet memory:
`fleet-chezmoi/claude-memory/projects/-home-conrad-dev-vivijure/memory/vivijure-hosted-parity-absolute.md`).

## Unreleased

### chore(deps): pin @skyphusion-labs/vivijure-core ^1.8.0

Brings finish_elapsed_ms read/write path (cf#268), FilmSummary assemble/output_ms,
cast family readiness, install-patch dropped keys, and the untrained-LoRA voice path
copy. **REQUIRES** migration 0017 applied on host D1 before deploy (landed #427).
Fixture: `finish_elapsed_ms: null` on keyframes-only RenderRow; cast-loras message
assertion updated for core#156 wording.


### feat(finish): containers emit elapsedMs for CPU capacity telemetry (cf#268)

All five CPU finish containers return integer `elapsedMs` (wall clock for the
request) on success. Destination column `renders.finish_elapsed_ms` (migration
0017) is ready; core must read `elapsedMs` and write the column (companion PR).
Does NOT reuse `execution_time_ms` (that is GPU job time, live in the panel).
### Docs / honesty
- **runpod_job_log migration comment matches module submit path (cf#315 item 1).** Core no longer submits to RunPod; table exists for module workers. Item 2 (`RUNPOD_ENDPOINT_ID` Env) deliberately untouched -- still live for modules / train path. Item 3 is vivijure-core.
- **preflight handler comment:** envelope is `storyboard` + `castBindings` + `motionBackend`/`quality`; `bundleKey`/`audioKey` are not read (mcp#26).
### Docs
- **`host.render.available` is config-armed, not live door health (cf#28).** Documented in `docs/demo-studio.md` and the `demoRenderEnabled` comment so the public shop window is not read as a health signal.
### docs: Gate 3 instrumentation closeout (cf#279, cf#295)

Evidence disposition: both original defects are shipped (14/14 job-log writers; 26/26 `/ready`).
Residuals are structural (wan-train core seam) or documented (tenant catalog population 4).
See `docs/gate3-instrumentation-closeout.md`.
### docs(verify): R2 same-key A/B must not trust CF API object-GET (cf#300)

The CF account API object-GET can serve a stale body after an overwrite while listing reports the new
object. Documented as a HARD RULE in `docs/r2-verification.md`, linked from `CLAUDE.md` and the
cf#278 harness README. Gate 3 kickoff: instrument defects before metering evidence.
### Docs: `FilmSummary.assemble_ms` + `output_ms` (cf#365)

CONTRACT 2.21 documents the poll-surface content-length fields that vivijure-core projects from
the already-persisted `film_output_seconds` map: assemble-stage (pre-film.finish) vs last-writer
delivered. Closes the observability gap that left a predicted-vs-delivered delta unexplained.
Fields appear on live poll only after the host pins the core release that adds them; this entry
is the wire-contract half. Distinct from `finish_elapsed_ms` (CPU wall-clock, cf#268) and from
plan `duration_seconds`.
- **Docs audit 2026-08-05:** 12 hooks + `image.generate`; core package paths (not host `src/modules/*`); standard module count 21; demo/spend posture honesty; em/en-dash free.

## v1.20.1 -- 2026-08-05

PATCH. Docs, CI, and dependency maintenance on main since v1.20.0. **No product or core pin change** (`@skyphusion-labs/vivijure-core` stays `^1.7.2`; bump hosts only after a deliberate core pin PR). Dual-panel with vivijure-local v1.6.1. Tag-gated Worker deploy.

### CI / process
- **Adversarial audit runs on Dependabot PRs (#418):** remove the Dependabot author skip so dependency PRs get the K2.7 audit; org Dependabot secrets supply the CF tokens. PR-comment step is `continue-on-error` (Dependabot `GITHUB_TOKEN` is read-only).
- **Document exact release/tag ship procedure (#409).**
- **Remove Cursor Cloud `AGENTS.md` (#408).**

### Docs
- Related-repos map and blog write-up links (#411).
- Fix stale currency claims (#416).
- CLAUDE.md refresh for agents (#417).
- Dependabot config: em-dashes replaced with ASCII double-hyphen (#412).

### Dependencies
- postcss 8.5.20 -> 8.5.25 (#414).
- `@cloudflare/workers-types` (cloudflare-toolchain group; #413, #375).
- `@types/node` (npm-minor-patch; #376).

## v1.20.0 -- 2026-08-03

### feat(release): publish the 8 cost-door modules and image-generate as tenant bundles (cf#394, cp#284)

A studio release published SEVEN tenant module bundles. The control plane's `TENANT_MODULE_CATALOG`
reached seven the same day (cp#284 catalogued `finish-rife`), so the two sets became **exactly
equal with zero headroom**: the plane could not provision one further module without a studio
release shipping first, and nothing in either repo said so. Conrad's ruling to catalogue modules
toward parity before phase 1b was, at that moment, not executable at all.

This publishes nine more -- the eight cost-door modules (`alibaba-wan`, `alibaba-wan-lora`,
`google-veo`, `kling`, `minimax-hailuo`, `narration-gen`, `seedance`, `vidu-q3`) and
`image-generate`.

**Publishing is not provisioning, and the gap is deliberate.** A bundle with no catalog row uploads
to nobody, so this changes no tenant's behaviour today; it removes the cross-repo serialisation so
the plane can add rows on its own schedule. `image-generate` is included even though its row is
still blocked on a separate flag question, for the same reason: a published bundle has one obvious
shape and no consumer contract to get wrong.

**Mechanism: one canonical list, `scripts/tenant-release-modules.txt`,** replacing the inline
composition. NOT an addition to `finish-satellite-modules.txt` -- that file has five consumers and
only one of them is publishing; the others narrow an OPERATOR deploy (`FINISH_SATELLITES_ONLY`) and
feed two test denominators. Adding nine non-finish modules there would have silently widened a
`CORE_ONLY_DEPLOY` operator deploy in order to change a publish set. The workflow's own comment
already recorded the precedent, having named `plan-enhance` inline "rather than added to
finish-satellite-modules.txt, which drives a different thing".

The consolidation creates one duplication -- the four satellites now appear in both files -- and
`tests/tenant-release-modules-cf394.test.ts` converts it into a checked invariant (subset, no
duplicates, every named module exists, the workflow actually reads the file, and the old inline
form is gone) rather than leaving it to drift.

**Proved by building, not by parsing.** All nine were run through the two steps a release runs --
`wrangler deploy --dry-run --outdir` then `scripts/build-module-release.ts` -- and each produced a
non-empty bundle and a manifest naming itself. Two already-published modules passed as a positive
control and a nonexistent module refused as a negative one, with a row-count floor so a loop that
ran zero times could not print a clean table.

### fix(docs): correct a cross-repo mirror that a control-plane merge falsified (cp#284)

`tests/module-readiness-denominators-295.test.ts` pins `TENANT_MODULE_CATALOG` as a hand-maintained
constant, because this repo cannot read the control plane. Its own comment says a change there "will
NOT fail this test". That is exactly what happened: vivijure-control-plane#313 catalogued
`finish-rife`, and the mirror sat false for about three hours while every assertion passed, since
they compare the constant against itself. Corrected, and the incident recorded at the constant --
the published table's `finish-rife` row loses its flagged published-not-provisioned asymmetry, which
was real from cf#295 until cp#284 and is now simply gone.

## v1.19.3 -- 2026-08-03

### chore(deps): pick up @skyphusion-labs/vivijure-mcp 1.2.1 -- keyframe_backend + qualityTier on submit_film (vivijure-cf#380, vivijure-cf#382)

PATCH. No behaviour change in the studio itself; the fix lives entirely in the MCP package. Both
route params existed on POST /api/render/film with no schema entry on the MCP side, so an
MCP-submitted film either could not name its keyframe door (silently defaulted to serving[0], the
local-gpu door, live projection order -- cf#380) or could not label its render-history row honestly
(qualityTier recorded "final" on every MCP-submitted film regardless of what ran -- cf#382). An agent
driving the studio through this Worker can now set both explicitly, the same way a human already can
in the panel.

## v1.19.2 -- 2026-08-03

### fix(video-finish): `_put_meta_sidecar` never wrote because `json` was never imported under that name (vivijure-cf#373)

PATCH. `_put_meta_sidecar` (vivijure-core#130, #663) is BEST-EFFORT BY CONTRACT and never raises,
so this shipped invisibly: `containers/video-finish/app.py` imports the stdlib module as `import
json as _json`, and every other use in the file correctly says `_json.*`, but the one call inside
`_put_meta_sidecar` said `json.dumps(payload)`. `json` was unbound. Every call raised `NameError`,
was caught by the function's own `except Exception`, logged as a warning, and returned. The caller
saw `HTTP 200, ok:true`, the film artifact was written correctly, and no sidecar ever existed. Both
call sites (`/film-titles`, `/subtitle`) go through this one function, so every ADOPTED
`film.finish` step has been landing on the pre-fix `output_ms: NULL` this sidecar exists to fix
(vivijure-cf#369 entry 2), regardless of whether the reading half (vivijure-core#131) is deployed.

Fix is the one-name correction: `data=json.dumps(...)` -> `data=_json.dumps(...)`. Confirmed zero
remaining bare `json.` uses in the file.

**Why a status-code test would not have caught this, and did not.** A best-effort function that
swallows every exception cannot fail loudly, so a test asserting the route returned 200 is
satisfied by the broken version -- that is exactly how this shipped. Added `test_meta_sidecar.py`,
which calls `_put_meta_sidecar` directly with `guarded_put` and `validate_fetch_url` swapped for
in-process fakes, and asserts the PUT body actually exists, parses as JSON, and matches the
expected `{duration_seconds, prepend_seconds}` shape -- SECONDS, matching the module contract; the
reading half multiplies by 1000 for `output_ms`, and a units mismatch between the halves is the
next silent failure waiting to happen. Verified both directions: run against the pre-fix line, the
two measurable cases FAIL with the exact swallowed `NameError` in the log and the run exits
non-zero; run against the fix, all twelve assertions pass.

**Not yet gating anything.** `ci.yml`'s pytest step is scoped to `deploy/` only (vivijure-cf#325,
open, not touched here), so no container test in this directory -- old or new -- runs in CI. This
test currently proves the fix locally and against a future in-image run; it is not a merge gate
until #325 lands.

### Changed: `@skyphusion-labs/vivijure-core` 1.7.1 -> 1.7.2 -- the reading half of the finish-measurement sidecar (vivijure-core#130, #131, #132; pairs with vivijure-cf#373 above)

PATCH. This is the READER for the sidecar `vivijure-cf#373` (above) writes. Core 1.7.2's own release
is itself a fix on the ADOPTED completion path: `runFilmFinish` checks R2 for a step's deterministic
artifact before it checks the poll token, and when the container PUTs between polls the next tick
ADOPTS -- advancing past the step's output without ever reading it, which is where the delivered
length and any title-card prepend travel. `readStepMeta` and `metaKeyFor` are the functions that
recover them from the sidecar on that path; core 1.7.1 does not contain `readStepMeta` at all.

**Until this bump, the deployed studio ran core 1.7.1.** An ADOPTED `film.finish` step recorded no
duration regardless of whether the sidecar existed, and `output_ms` stayed NULL on completed, billed
films -- the exact condition vivijure-cf#369 entry 2 exists to close.

The declared range moved to `^1.7.2`. `^1.7.1` would still have installed 1.7.2 once published, but
would have been a lie about the floor: this deploy depends on `readStepMeta` existing, which 1.7.1
does not have.

**Both halves are now live, which is why this ships now and not earlier.** The WRITER
(`vivijure-cf#373`) is deployed as image `de692e3@sha256:1d43a2c3`, converged on all three finishing
nodes. The READER is this bump, `@skyphusion-labs/vivijure-core@1.7.2`, published.

**vivijure-cf#369 entry 2 stays open.** Both halves being live is necessary, not sufficient: settling
that entry needs a film with exactly one `film.finish` step, that step named in
`film_finish.adopted`, and `output_ms` non-NULL on the resulting row. Nothing observed yet proves the
measurement reaches the column it is billed from; that is a live-render verification, not a code
change, and it has not been run.

## v1.19.1 -- 2026-08-02

PATCH. **Ships no new capability. It makes an already-shipped one observable.**

### Fixed: `renders.output_ms` was written in v1.19.0 and readable by nothing

v1.19.0 shipped the capture -- the DELIVERED film length, the metering basis, written on finalize by
the terminal writer of the film artifact. It was added to **no read path**: not the shared render-row
column list, not the raw row type, not the normalizer. So `GET /api/storyboard/renders` returned
`execution_time_ms` and `delay_time_ms` and no `output_ms` at all, and the value could be seen only
by whoever held account credentials and could query D1 directly.

Fixed in `@skyphusion-labs/vivijure-core@1.7.1`, brought in here. The field now reaches clients on
the render row alongside its two sibling durations.

**No new migration.** `0016` shipped in v1.19.0 and the column has been in the database and
correctly populated since that deploy; only the read side was missing. Rows written between the two
releases keep their values and become visible with this one.

**NULL still means NOT MEASURED and must never be read as zero.** A `COALESCE(output_ms, 0)` in a
billing query bills nothing for a real render. A row predating `0016` reads `null`, not `NaN`.

**Why it survived a full suite:** every test written for the capture asserted the WRITE, through a
stubbed database binding. A capture path with no reader passes every test that only exercises
capture -- the stub was the boundary, so the read side was not merely untested, it was out of frame.
The core suite now drives the real read functions and asserts the SQL column list, and it fails on
1.7.0 in all six cases.

## v1.19.0 -- 2026-08-02

MINOR: the studio can now say how long the film it delivered actually is, and which provider job
produced any given piece of it. Both are additive; no existing studio API changes shape.

**This is the metering substrate, not the meter.** Nothing bills, refuses or deducts in this release.
`CREDITS_ENFORCING` unset already means count-everything-refuse-nothing, so capture lands safely
ahead of any enforcement and the rate card gets MEASURED instead of guessed. Ordering per
skyphusion-labs/vivijure#805.

### DEPLOY NOTE: migration `0016` applies on this deploy

`migrations/0016_render_output_ms.sql` adds `renders.output_ms` and rides the normal auto-apply in
`deploy.sh` step 6. It is additive (`ADD COLUMN`, no default, no table rewrite), so it is safe on a
live database and needs no manual window.

Called out explicitly because **a migration is first applied in PRODUCTION at deploy time** -- there
is no CI gate over `migrations/` (cf#358), so the deploy is the first time this file is executed
anywhere except a scratch sqlite run. This is the first release carrying a migration since that was
documented, and the order matters: the migration must land before the Worker that writes the column,
which is what `deploy.sh` already does.

### Added: `renders.output_ms` -- the DELIVERED film length (cf#268, vivijure#805)

Conrad's ruled metering basis is a deduction on the final length of a successfully completed video:
**"we bill on the last writer"** (2026-08-02). That number was stored nowhere. `duration_seconds` in
plan JSON is the REQUESTED duration, a different quantity -- every non-final tier delivers clips
shorter than their planned target, so billing the plan bills for footage nobody received.

Integer milliseconds, not seconds, and a NEW column rather than a reuse. `execution_time_ms` means
GPU JOB TIME and the history panel already renders it to users; overloading it would corrupt a live
number in the least visible way available. Milliseconds because this is a billing input and the
ledger already avoids floats for exactly that reason.

**NULL means NOT MEASURED and must never be read as zero.** A `COALESCE(output_ms, 0)` in a billing
query bills nothing for a real render.

### Added: every RunPod submitter hands the caller its job id (cf#356, closing cf#289 and cf#296)

RunPod cannot enumerate jobs -- the surface is `/run`, `/status`, `/stream`, `/cancel`, `/retry`,
`/purge-queue`, `/health`, and `/status` is by id only -- and async results expire after 30 minutes.
An id the caller is not handed at submit is unreachable PERMANENTLY.

Thirteen of fourteen submitters already carried it; `narration-gen` was the last, and it is the one
where the obvious fix is wrong: `jobId` in its submit scope is the FILM job id, so the one-word
shorthand its thirteen siblings use returns the wrong value AND typechecks clean.

**cf#289's own table was measured wrong and is corrected here:** the population is FOURTEEN RunPod
submitters, not five. It never listed `finish-lipsync` or `finish-rife`, and counted one of the nine
motion backends. The suite derives the population rather than listing it.

### Added: `film-titles` and `subtitle` report the length they wrote (cf#359)

The `video-finish` container has always returned `durationSeconds` on `/film-titles` and `/subtitle`;
it was never carried onto the module contract, so a CARDED film -- precisely the case the
last-writer rule exists for -- had no length to report.

**Gated, because the container returns the field unconditionally.** A subtitle run that only writes a
sidecar leaves it at a `0.0` initialiser, and forwarding that would attach a zero to an artifact the
step never wrote, fail conformance, and soft-degrade a run that succeeded. `subtitle` gates on
`burned` as well as `> 0`; `film-titles` gates on `> 0`.

### Changed: `@skyphusion-labs/vivijure-core` 1.6.0 -> 1.7.0

Brings the writer (`film_output_seconds` keyed by film artifact key, delivered length resolved as a
lookup of the FINAL film key, persisted so a step ADOPTED from R2 still yields a length) and a
**behaviour change for module authors: `film.finish` conformance now REJECTS `duration_seconds` when
present and `<= 0`.** A module that cannot measure its output must OMIT the field.

The declared range moved to `^1.7.0` as well. `^1.6.0` would still have installed, and would have
been a lie: this code depends on behaviour 1.6.0 does not have.

## v1.18.0 -- 2026-08-02

MINOR: an agent can look at motion output. This completes the arc v1.16.0 started.

**This release was held back deliberately for two days' worth of ordering, and the reason is the
feature itself.** `POST /api/render/frames` calls `POST /frames` on the `video-finish` CPU container.
That container route does not exist until its image is rebuilt AND the running service is rolled, and
tagging first would have deployed a Worker route that answers `route-not-served` by name. A route
that exists and refuses is worse than one that does not exist, because the first looks like a bug in
the caller. So the order was: merge, build the image, roll the container, THEN tag.

**The roll is done and verified at the artifact, not at the pipeline.** All three finishing-tier nodes
run `vivijure-cf-video-finish:0434011@sha256:9493c7e9...`, digests read off the RUNNING containers
rather than the service spec, and each answers `POST /frames` with its own `400 videoUrl required`
validation against the `404 Not Found` the same nodes returned beforehand. A real transition against a
real negative control.

Two things the roll turned up, both filed rather than papered over. The stack **could not roll any
image at all** (`order: start-first` with `max_replicas_per_node: 1` and `replicas` equal to the
number of eligible nodes is unschedulable by arithmetic) and while broken it reported `3/3 REPLICAS`
at the new tag over containers running the old build. Fixed to `stop-first`. Then a Pending task left
over from the failed attempt survived the fix and stranded a node, while the service reported
`update=completed` at 2/3: **a completed update is not a converged service.** Full capacity restored
and confirmed per node.

The capacity cost of `stop-first` was measured rather than assumed: **2222 polls across two
independent rolls, zero dropped requests** (roll 1 `1134/1134/0`, roll 2 the forced one `1088/1088/0`),
each roll carrying its own positive and negative controls **re-run rather than inherited**, because a
control that passed against a previous state is not a control for this one. Recorded on
`fleet-chezmoi#1312`: [both totals](https://github.com/skyphusion-labs/fleet-chezmoi/issues/1312#issuecomment-5154130983)
and [the control counts behind them](https://github.com/skyphusion-labs/fleet-chezmoi/issues/1312#issuecomment-5154152816).
Scope stated honestly there: 4/s sampling BOUNDS a blackhole rather than proving zero, at least two
replicas were always live so it says nothing about all-three-down, and it measures the VIP path and
not the hop in front of it.

### Frame extraction: an agent can finally LOOK at motion output (cf#322)

`POST /api/render/frames` samples a rendered clip into ONE jpeg contact sheet (3x3 by default) and
stores it as a normal R2 artifact, returning the key.

**What is proven and what is not, stated next to the feature rather than buried:** the container half
is verified on all three nodes (below). The Worker half is smoked END TO END only AFTER this release
deploys, because the route does not exist in production until then. So the cloudflared / Workers-VPC
hop between the Worker and the container VIP is **one hop further than anything measured so far.** If
that hop is wrong, the route names it (`container-unreachable`) rather than failing vaguely.

The gap it closes: our MCP tool-result content union carries text and images and has no video variant,
so a finished film could only ever be handed over as a LINK. Meanwhile, **across the 200 most recent
render rows** (the library API clamps `limit` to 200, so this is a WINDOW and not a census of the
library), 129 were COMPLETED and **128 of those carry `keyframes: null`** -- the mp4 was the only
artifact that existed for them. The one artifact type we produce was the one the transport cannot
carry, and the one it can carry was the one we almost never produced. A contact sheet is an image, so
it crosses.

Returning a key rather than bytes is deliberate: `view_artifact` fetches `GET /api/artifact/<key>`, so
a key makes the sheet reachable through the panel, the serve route and `/api/artifact-url` with **no
new MCP tool and no vivijure-mcp release behind it**. The derived key inherits the source clip's own
prefix by construction, which is what keeps it inside `ARTIFACT_PREFIXES` and therefore reachable at
all; that property is asserted against the real exported guard with a control.

Extraction runs in the `video-finish` CPU container (`POST /frames`), already the ffmpeg surface,
reached over the private VPC binding. Failures report a STATE rather than a generic error
(`tier-unavailable` / `route-not-served` / `container-unreachable` / `container-error`), because each
implies a different operator action and `route-not-served` is an EXPECTED condition during the rollout
window before the container image is rebuilt and the always-on service rolled.

A contact sheet is evidence about the frames it sampled, not about the clip: it cannot show per-frame
flicker or motion between the samples. The response carries that scope in a `proves` field so the
limitation travels with the evidence.

**Dual-panel gate: NOT waived, OPEN.** This is a studio feature by the gate's own definition, so it
owes a `vivijure-local` counterpart in the same release wave. That counterpart is not in this change
and is not mine to land here; it is called out rather than assumed non-applicable, because the failure
mode of a parity gate is a change quietly deciding it is exempt. Flagged for the release lead.

**Deploy ordering.** The container route ships in the `video-finish` image, so the image must be
rebuilt and the always-on service rolled for this to do anything. Until then the studio route answers
`route-not-served`, honestly and by name.
## v1.17.0 -- 2026-08-02

MINOR: the agent-can-SEE capability becomes REAL, and the GPUless cost door starts recording.

This is the release where cf#317 actually lands for a user. v1.16.0 shipped the plumbing
(`GET /api/artifact-url/*key`); `vivijure-mcp` v1.1.0 published the tools that consume it; this bumps
the dependency, which is the step that moves the deployed surface from 19 tools / 18 curated to
**21 / 20**. Code on `main` in another repo moved nothing here. A published version this repo
resolves does.

Alongside it, the eight GPUless cost-door submitters write `runpod_job_log` rows for the first time.
cf#278 phase 1 has to report per-endpoint outcomes, and against the previous instruments that door
produced no rows at all while an operator querying the table grouped by module saw six healthy lanes
and could not see the eight that never wrote.

**Recording is not classifying, and this release does not claim otherwise.** All eight cost-door
submitters post to THIRD-PARTY public RunPod endpoints, and nobody has measured what any of them puts
in `error` on a fault. The RULE is that `error_type` is populated if and only if the endpoint emits a
structured `error_type` key, and is NULL otherwise; **how often that happens across these eight is
UNKNOWN, and this release does not estimate it.** NULL means "the endpoint did not tell us the class",
never "this was not a refusal", and both directions are pinned by test so a populated column cannot be
misread as a solved classification. What phase 1 gains is that the cost door is COUNTED.

### chore(deps): bump vivijure-mcp to ^1.1.0, and fix what the bump exposed (cf#317)

`view_artifact` and `artifact_url` are now REACHABLE from this repo, which is the last step of the
cf#317 chain: the route shipped in v1.16.0, the package released as v1.1.0, and this bump is what
makes the deployed surface include them. Published parity moves **19 -> 21 tools, 18 -> 20 curated**,
exactly as the doc predicted it would, because the test measures the INSTALLED package.

Three things the bump exposed, all fixed here:

- **The parity matcher could never match a WILDCARD route.** It rewrote a tool's placeholder path to
  `:id` and left the route's `*key` alone, so `view_artifact` and `artifact_url` were reported as
  ORPHANS pointing at routes that do not exist, while both routes exist and both tools work. Every
  artifact route is a wildcard route, so the assertion that exists to catch a renamed or deleted
  route was instead producing a false alarm on a whole class of route. Both sides now go through one
  canonical form.
- **`res.content[0].text` no longer typechecks** at three call sites, because v1.1.0 widened
  `runTool`'s return to `McpContent[]` so a tool can return an image. Narrowed with a type guard
  rather than a cast: a cast would keep compiling on the day `runTool` starts inlining bytes at those
  call sites, which is the exact regression those three tests exist to catch.
- **Nothing was reading `docs/mcp-parity.md`.** The doc says CI fails until it is re-measured; only
  the constants were asserted, against the code, so a bump that updated `PUBLISHED` and forgot the
  document left CI green with a stale published denominator. Now guarded row-for-row and in the
  prose ratio, the same way `docs/module-readiness-coverage.md` already is.

Finding 2 in the parity doc ("artifact parity is ZERO") is marked closed rather than deleted, with
the measurement preserved: the byte-returning class is still 4 route entries, and what closed is the
agent-can-SEE gap, not the whole class.


### feat(telemetry): make the GPUless cost door write a runpod_job_log row (cf#305)

`runpod_job_log` held ZERO rows for the entire cost door. Eight modules submit jobs to RunPod
(seedance, kling, vidu-q3, google-veo, minimax-hailuo, alibaba-wan, alibaba-wan-lora,
narration-gen) and none held a `TELEMETRY_DB` binding or called `recordRunpodJob`. Not the missing
`jobId` of cf#296: that made the id reachable, not the job recorded. All eight now bind the studio
D1, write the five outcomes plus the cf#298 walked-past terminal statuses, and report
`telemetry.job_log` on the `/ready` they already expose.

Render-path behaviour is UNCHANGED on every branch, including the walked-past write, which is
record-only for the reason cf#298 gives: a live CANCELLED job had already written the artifact the
film consumed.

**Recording is not classifying, and this does not claim to be.** These are third-party public RunPod
endpoints, not `vivijure-backend`, so their fault payload shape is unmeasured. `error_type` is
populated from a structured key where one exists and NULL where it does not (migrations/0015): NULL
means "the endpoint did not tell us the class", never "not a refusal". Both directions are pinned by
test so a populated column cannot read as a solved classification.

Population 2 of `docs/module-readiness-coverage.md` moves 6 -> 14. Population 4 ("6 of 26"
provisioned) is a different number and is unchanged.

## v1.16.0 -- 2026-08-02

MINOR: an artifact key stops being a dead end. `GET /api/artifact-url/*key` turns any artifact key
into a short-lived presigned GET plus the object's real content type and size, and the panel/MCP
parity table is published with its denominator so it fails CI rather than going stale.

### feat(api): presign any artifact key, and publish the MCP parity denominator (cf#317)

The launch gate this unblocks is measurement: `cf#278` phase 1 cannot report on artifact QUALITY
because **nobody has looked at the clips.** That was a TOOLING limit, not a credential limit.
`list_renders` hands back `output_key` and `keyframes[].key` for every render in the library and
nothing could turn any of them into something fetchable, so a key was a dead end.

One correction to the issue's premise, kept because it changes what is left to do: `poll_film`
already returns a presigned `download_url` on `phase: "done"`, and still does for a historical film
id. The gap was never "no film is fetchable" -- it was that an arbitrary KEY could not be resolved,
and that nothing is ever *seen*, not even an image, which MCP carries natively.

A presigned URL is a capability credential, and R2 revocation propagates too slowly for
revoke-after-use to be a control, so the guarantees are **expiry and scope, both server-side**: the
signature covers exactly one key and never a prefix or wildcard; the lifetime is clamped to
`[60, 3600]` (default 300) so a caller cannot widen it; the same key guard as the serve route
applies; and existence is checked with `head()`, so a 200 always names a real object.

`content_type` is the **stored** type, deliberately not the remap `/api/artifact` applies to its own
responses. This URL does not pass through that route, so reporting the remapped type would be a claim
about a response we do not produce.

The parity table at `docs/mcp-parity.md` is measured by `tests/mcp-parity-317.test.ts` from the real
route table and the real INSTALLED MCP tool catalog. Its finding: action parity was not the gap.
`studio_request` can send any method to any path, so there is no route an agent cannot invoke, and
18-of-85 measures ERGONOMICS rather than reach. Artifact parity was the real zero.

**The capability is not user-reachable on either door yet, and that is deliberate ordering.** The MCP
tools that consume this route (`view_artifact`, `artifact_url`) ship in `vivijure-mcp`; until that
package is released and this repo's dependency is bumped, the published numbers stay at 19 tools /
18 curated, because the test measures the INSTALLED package and therefore reports the surface
actually deployed.

**Dual-panel parity: the counterpart is `vivijure-local#309`, filed with this release rather than
after it.** This IS a studio feature, so it is not exempt from the gate the way cf#316 and cf#313
were. What this release ships is plumbing that no client can yet reach, so the gate binds at the
`vivijure-mcp` release, not here, and local#309 lands before that point. The local port is not a
copy-paste: its FILESYSTEM presigner ignores the expiry argument and embeds the studio bearer in the
URL, which is the exact inverse of the two guarantees above. Written down rather than left silent,
because an unexplained absence under a parity gate reads as an oversight to the next person, and the
next person cannot tell the two apart.

## v1.15.0 -- 2026-08-01

MINOR: the pooled-endpoint release. A tenant's per-job R2 credential now rides the invoke envelope
to the two modules that submit to `vivijure-backend`, which is what lets that endpoint be SHARED
across tenants instead of one dedicated endpoint per customer. Alongside it, the module-readiness
denominator is published and guarded, so a surface that speaks for six of twenty-six modules has to
say which six.

**No `vivijure-local` counterpart in this wave, deliberately, and this is not the gate being
skipped.** The dual-panel gate above covers studio FEATURES. Neither change is one. cf#316 is hosted
multi-tenant plumbing: it exists because a pooled backend endpoint serves more than one tenant, and
the credential is what puts a job in the right tenant's bucket. `vivijure-local` is a single-tenant
self-host door: no tenant concept, no pooled endpoint, nothing to mirror. cf#313 publishes a
denominator about this repo's modules and the hosted control plane's provisioned set, which likewise
has no self-host analogue. Written down rather than left silent, because an unexplained absence under
a parity gate reads as an oversight to the next person, and the next person cannot tell the two
apart.

### feat(modules): forward the tenant per-job R2 credential to the pooled backend endpoint (cp#270 / cf#316)

Step 3 of the pooled-shared-tier chain, and the consumer half of vivijure-core 1.5.0.

`keyframe` and `own-gpu` are the only two modules that submit to the `vivijure-backend` endpoint,
which may be POOLED across tenants. Both now declare `needs_tenant_r2` on their manifest, call
`takeTenantR2(req)` at the parse boundary, and forward the block INSIDE the RunPod `input` object
where `vivijure-backend/docs/contract.md` specifies it. No other module is touched: declaring the
field hands a live tenant credential to a worker with no use for one.

`needs_tenant_r2` is declared on the module MANIFEST rather than decided in core. Which modules ride
a pooled endpoint is a property of the module, and core must not branch on module identity.

STRIP AT THE BOUNDARY, not inside `submit()`. The guarantee is about the REQUEST object, so
`takeTenantR2(req)` reads and removes the credential in one call at the parse site and it travels
onward as a value. Every line after that point is unable to leak it even by accident, because
nothing after that line holds an object that still contains it.

THE RULE THAT BREAKS THE FAR END, held in one shared helper rather than spelled out twice: the
backend REFUSES an explicit `"r2": null` rather than reading it as absent, because a silent
fallback would run a tenant's job against the wrong bucket under the wrong credential. So
`withTenantR2Body` returns the body UNCHANGED when there is nothing to attach. It does not set the
key to undefined and rely on `JSON.stringify` dropping it, which works today by a property of the
serialiser rather than by intent. **A producer that helpfully emitted `null` would fail every job on
every dedicated endpoint, which is the entire installed base.**

THE DRIFT GUARD is the half that has to survive future edits. The credential rides the invoke
request, so serialising that request into a console line is what would put it in Workers Logs
`Logs` and from there into the tail worker and Loki. `tests/tenant-r2-forward.test.ts` scans every
module source and fails on that pattern, with a positive-evidence floor (the scan must find
modules at all), a control proving the matcher fires on a constructed offender, and a control
asserting a non-pooled module declares neither field. It was proved by planting
`console.warn(JSON.stringify(req))` in `keyframe` and watching it go red.

The matcher's scope was NARROWED by a real false positive on its first run rather than guessed:
`local-gpu`'s `encodePoll` does `btoa(JSON.stringify(payload))` on a `PollState` to build a poll
token, which is not a leak of anything. Bare-stringify now flags `req` only -- the invoke-request
variable by convention, with no legitimate reason to serialise -- while the console patterns still
cover every name. Scoping by meaning beats an exemption list that grows with every local named
`payload`.

The core dependency moves `^1.3.0` -> `^1.5.0`. The RANGE bump is deliberate and not cosmetic: the
modules now import `@skyphusion-labs/vivijure-core/modules/tenant-r2`, which does not exist before
1.5.0, so `^1.3.0` would have been a compatibility claim that is no longer true.

### docs(modules): publish the readiness denominator and guard it against drift (cf#295 / cf#313)

The original cf#295 defect is REMEDIED, and was re-measured at this head rather than carried forward
from the issue's sha: all 26 modules implement an anchored `/ready` today, against the 6 of 26 the
issue recorded, with a matcher controlled in both directions.

The coverage gap did not close, it MOVED, and it got harder to see. `module-readiness` on the
control plane iterates `TENANT_MODULE_CATALOG`, which is six entries. Every one of those now answers
200, so the route looks COMPLETE while speaking for six of twenty-six. Before, an unimplemented
sweep 404'd and the hole was visible in the result; a route that reports a subset without saying so
is the same defect one layer up.

So `docs/module-readiness-coverage.md` publishes the denominator. There are FOUR populations of "the
modules" and confusing any two is how this class of error happens: 26 modules in the repo, 6 writing
`runpod_job_log` rows, 7 published as tenant bundles by a studio release, and 6 provisioned to a
tenant, which is all `module-readiness` can report on.

The two asymmetries are the ones that get misread, so they are named rather than counted.
`finish-rife` writes job-log rows and IS published but is NOT provisioned, so on the hosted door its
jobs do not exist rather than going unrecorded. `plan-enhance` IS provisioned but writes no job-log
row: it is not endpoint-backed, so null credentials and a null job_log are the correct result, not a
fault.

A published table that can go stale would be the same defect the page warns about, so the table is
asserted against source row for row, and the guard was proved by re-introducing the defect three
ways -- claiming `finish-rife` is provisioned, dropping a module row entirely, and softening the
"6 of 26" denominator out of the prose -- each failing with the specific row named. Three of the
four populations are derived from this repo and really checked; the fourth lives in
`vivijure-control-plane` and is DECLARED here, not verified, which the test says in those words
rather than implying coverage it does not have.

**cf#295 stays OPEN after this**, and stays open on the same terms v1.14.0 left it: none of this is
verified against a deployed worker, which is a separate claim someone still has to make.

## v1.14.0 -- 2026-08-01

MINOR: the instrumentation release. The job log can now say what actually happened to a job, `/ready`
covers every module instead of a quarter of them, and the render panel can tell a stalled render from
one that is merely starting up. **Nothing here changes the render path.** Every change is telemetry,
readiness or presentation, and the one live counter-example is documented below.

Shipped alongside `vivijure-local` (parity per the dual-panel gate): the `error_type` column and the
`cancelled` outcome landed on the self-host door in the same wave, in a shape that fits that door
rather than a verbatim copy of this one.

### fix(telemetry): runpod_job_log can say refusal, cancel, and which job (cf#286 / cf#288 / cf#298 / cf#289)

`outcome = failed` absorbed three different things a reader could not separate: a deliberate refusal,
a handler fault, and genuine infra. All three arrive from RunPod as `FAILED`, and only the exception
class tells them apart.

**Why the old arrangement was fragile, measured rather than asserted:** that class survived only
inside `detail`, and only because `error_type` happens to be the FIRST key RunPod emits. On a real
refusal the raw error string is 1071 chars, the class name ends at char 73, and `detail` is bounded
to 160. **Eighty-seven characters of headroom against a vendor reordering its own JSON** -- with a
silent failure mode, because the numbers would not break, they would quietly stop meaning what they
say.

`migrations/0015` adds a bounded `error_type`, extracted at WRITE time from the structured key and
normalised. It NEVER reads the message: classifying by matching English error sentences is a parser
only as fresh as the sample it was built from, and those strings are ordinary prose someone will
reword without knowing a classification depends on them.

`cancelled` joins the outcome vocabulary. `CANCELLED` and `TIMED_OUT` are terminal, but the poll
paths tested only `COMPLETED`/`FAILED`, so for those two **no terminal write was ever attempted** and
the row stayed `submitted` permanently. It also has a denominator consequence: endpoint health
counters exclude `CANCELLED`, and the modules produce it deliberately, so a cancelled job was neither
a success nor a failure nor an open job -- it was missing from the arithmetic. `TIMED_OUT` records as
`failed` rather than getting its own value, because it has not been observed on our endpoints and a
vocabulary member added on speculation is harder to remove later than one added on evidence.

**`cancelled` is NOT the home for a refusal**, and the earlier decision refusing it for that purpose
stands: a refusal raises inside the handler and the SDK books it `FAILED`, so the value would never
have fired for the case it would have been added for.

Three limits, stated rather than papered over:

- **`NULL` means the endpoint did not tell us, never "this was not a refusal."**
- `vivijure-backend` emits `error_type`; the three satellite containers do not. **One endpoint of
  four is classifiable.** A column that looked like it had solved classification while covering a
  quarter of the surface would be worse than the honest absence.
- **Historical rows are not backfilled and not reinterpreted.** Mining a class out of a truncated
  `detail` blob would manufacture exactly the confidence that data cannot support.

**The render path is deliberately unchanged**, and there is a live counter-example for why: a
CANCELLED job had already written the artifact the film went on to consume, so failing a shot on
`CANCELLED` would break a path that works today.

cf#298 is **narrowed, not closed** -- a lost terminal write is only narrowed by the added retry; the
reconciler is the real fix and carries a hard ~30-minute RunPod result-retention constraint.

### fix(modules): GET /ready covers all 26 modules, not 6 (cf#295)

Twenty modules had no `/ready` at all and answered **404** -- which is not a failure verdict, it is
the ABSENCE of one. A caller sweeping readiness could not distinguish "this module is not ready" from
"this module has no readiness endpoint", and answered as though it could.

Each module's real hard-fail guards were read before deciding gating, because the twenty are not
uniform. Modules whose credential only unlocks an optional better path -- with a genuine fallback in
the code -- report `ok: true` and surface the credential informationally, following the precedent
`telemetry.job_log` already set. Templating one shape across all twenty would have gated `ok` on
credentials several modules' own code treats as optional, and would have failed in the safe-looking
direction.

`bindings` is now reported alongside `credentials`, kept separate because a binding has no value to
leak.

**Not yet verified against a deployed worker.** This is proven against the real fetch handlers in
unit tests; hitting `/ready` on deployed workers is a separate claim and cf#295 stays open until
someone does it.

### feat(planner): explain the render startup wait instead of showing a bare 0% (cf#303)

Measured on the pre-change build rather than argued: a render **queued**, a render in **keyframe with
nothing drawn**, and a **genuinely stalled** render were byte-identical in the panel -- same bar, same
"computing...", same label. So the defect was larger than "cold start is invisible": **a stalled
render and a healthy one that is merely starting up looked exactly the same.**

Now the panel says what is happening and why -- GPUs are not kept running idle, which keeps costs
down -- with curated phase labels, unknown phases passing through raw, and the pre-submit window no
longer blank.

**The server's `stalled` verdict is surfaced in the live panel**, where it never was before, though it
was already in the envelope and already shown in the history list. Without it the startup note would
reassure the user straight through a real stall, masking the exact failure this work exists to reveal.
The two are mutually exclusive by construction: there is one note element, so both messages cannot
coexist.

The bar still sits at the band floor and the ETA is still withheld until it can be honest. **This does
not invent progress motion**, and it does not claim a queue state we cannot observe -- the module
`/poll` contract cannot express queued-versus-running at all, which is filed as cf#307 and deliberately
not started.

### fix(tail): render vivijure-tail's config from its committed example (cf#294)

`tail/wrangler.toml.example` was committed with nothing rendering from it, so `vivijure-tail` was
still deployed by hand. Adds `scripts/deploy-tail.sh`, run by hand rather than wired into CI:
`vivijure-tail` is our-fleet-only (SELFHOST-SKIPped, and stripped again for tenants) and changes
rarely, so it fits neither `deploy.sh` nor the tag-gated release job -- and wiring it into the release
job would have required a secret that could not be provisioned or exercised, shipping a CI path that
looked wired while being unproven.

### fix(modules): finish-rife exposes GET /ready, and a guard so the next one cannot be missed (cf#291)

`finish-rife` writes `runpod_job_log` rows and exposed no `/ready` at all, from 2026-07-18 until
now. The module was never broken (it recorded a `completed` outcome on the prod door during the
cf#278 run); nothing could ASK it whether its telemetry worked.

**Established as an omission rather than a decision before fixing it:** finish-rife already existed
when `/ready` shipped, it is in the tenant release set
(`scripts/finish-satellite-modules.txt`), and it carries the identical bindings the probe reports on
(`TELEMETRY_DB`, `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID`). The original commit says "all five tenant
modules"; the tenant release set is seven.

**The durable half is the guard.** This gap survived four months because of its shape: an audit built
by sweeping readiness endpoints returns a clean result across the modules that have one and never
mentions the module that does not. The absence removes the module from the census that would report
it. So a test now fails when any module importing `recordRunpodJob` exposes no `/ready`.

The guard deliberately does NOT require `/ready` of every tenant module. The invariant is keyed on
RECORDING, because recording is what creates the question an operator needs answered.

**Corrected before release by cf#295, below.** This entry originally said `plan-enhance` has no
`/ready` "and that is correct, since it holds no RunPod credentials and writes no job log, so the
probe would have nothing to report." That premise was wrong: `plan-enhance` reads `GATEWAY_ID` and
`CF_AIG_TOKEN`, which select the provider, and that IS something a credential-visibility probe can
report. It now has a `/ready` and still writes no job-log row, so the invariant is a strict SUBSET
(every job-log writer is askable) rather than an equality.

### fix(ready): report whether the job log can RECORD, not whether a binding is attached (cf#284)

`GET /ready` on every polling module reported `telemetry: { job_log: <bool> }` from
`Boolean(env.TELEMETRY_DB)`, which is the presence of the BINDING. A worker bound to a database
where `runpod_job_log` does not exist answered `true` while being structurally incapable of writing
a row. Observed in the v1.13.0 pre-tag smoke: a real job ran to completion through such a worker
while both the submit and terminal writes failed.

The field is now three states, and the third one is the point:

| state | meaning |
|---|---|
| `ok` | a read against the table succeeded |
| `unavailable` | definitively cannot record: no binding, or no table |
| `unknown` | the probe could not answer (read threw, or outran its 1.5s bound) |

A boolean has nowhere to put "I could not tell", so it answered that as `true`. `unknown` is not
`ok`, and the shape of the field now forces a reader to notice the difference.

The probe is a READ against `sqlite_master`, never a write: a readiness check that inserted would
put fabricated jobs in the table operators query for real ones. Table existence is decided by DATA
(a row or no row), never by matching vendor error text. It costs one round trip on a path that was
previously free; taken deliberately, since `/ready` is called before flipping a tenant live.

Honest limit, stated in the code: this proves the table is READABLE, not that an INSERT would
succeed. A read-only replica would still report `ok`. It closes the observed hole and no more.

**Wire change:** `telemetry.job_log` is a string, not a boolean. No consumer in this repo or in
vivijure-control-plane read the boolean; the only readers were this repo tests and docs, both updated.


## v1.13.0 -- 2026-08-01

MINOR: every RunPod-polling module now writes a durable job log (cf#279), plus a module-render
isolation fix (cf#281).

### feat(modules): record every RunPod job a polling module submits (cf#279)

- New **`runpod_job_log`** D1 table (**migration `0014_runpod_job_log.sql`**), upserted per
  `job_id`, written by the six RunPod-polling modules (`keyframe`, `own-gpu`, `finish-rife`,
  `finish-upscale`, `finish-lipsync`, `speech-upscale`) at SUBMIT and again at every terminal
  outcome (`completed` / `backend-error` / `failed` / `gone`). It exists because RunPod cannot
  enumerate jobs (the whole surface is `/run`, `/status`, `/stream`, `/cancel`, `/retry`,
  `/purge-queue`, `/health`, and `/status` is by id only), so a job id not captured at submit time
  is unreachable permanently, and the window to write it closes as the job finishes.
- **Written at submit as well as terminal, on purpose:** a failure RATE needs a denominator, and
  the endpoint health counters cannot supply one, since `completed + failed` excludes `CANCELLED`,
  which these modules produce deliberately (the F17 spend-leak cancel).
- **Content-free:** ids, a compile-time module name, a closed-set outcome, timestamps, and a
  backend-error string bounded to 160 chars. The RunPod endpoint id is deliberately NOT a column;
  it stays Secrets-Store-only, and the module name is a sufficient substitute since the
  module-to-endpoint mapping is fixed and public in this repo.
- **Best-effort by contract:** the write never throws, never rejects its caller, and never delays a
  response past its own timeout; an absent `TELEMETRY_DB` binding warns rather than fails. Every
  polling module now reports `telemetry.job_log` (boolean) on `GET /ready`, so an operator can ask
  a deployed module whether it can record at all, with no render and no GPU spend.
- **Operators: this ships a schema change.** `migrations/0014_runpod_job_log.sql` must apply before
  a module can write to it; an unfilled `database_id` placeholder fails the module deploy loudly
  rather than shipping a worker that silently records nothing.
- Full detail: `docs/runpod-job-log.md`.
- vivijure-local parity tracked separately: vivijure-local#294.

### fix(deploy): give module renders the isolation pass they never had (cf#281)

- **`DEPLOY_PREFIX` installs only.** An isolated install bound the core to `<prefix>-vivijure`, but
  module workers stayed bound to the unprefixed `vivijure` R2 bucket and `[[workflows]]` name, so a
  staging install read and wrote the production bucket while every other resource in the install
  correctly carried the prefix.
- `render_module_toml` now rewrites every bucket in `R2_BUCKETS` and the in-block `[[workflows]]`
  name (never the top-level worker name, which is already prefixed via `--name`). Every module toml
  now goes through the render; it previously ran only for a toml carrying a `[[vpc_services]]`
  block, which none of the thirteen module tomls naming the shared bucket do.
- **A non-prefixed install (empty `DEPLOY_PREFIX`) is unchanged byte for byte, and the tag-gated CI
  deploy (`scripts/deploy-module-workers.sh`) does not use this installer at all.** Production is
  untouched.

## v1.12.0

### ci(release): publish plan-enhance as a tenant module bundle (cf#56)

MINOR. Adds `plan-enhance` to the tenant module set the release publishes, so
`studio-releases/<tag>/modules/plan-enhance/` exists in the release artifact and the hosted
provisioner can fetch it. Without it, `moduleBundle.fetch(release, "plan-enhance")` had nothing to
fetch at any tag.

Recorded retroactively (cf#272): v1.12.0 was tagged without a version-bump commit, so this release
shipped declaring `1.11.0` in `package.json` and left no changelog entry. The artifact itself is
correct -- the release manifest carries `tag: v1.12.0` and provisioning is unaffected -- so the tag
is NOT being re-cut. The declared version is corrected here and a tag-vs-version guard now runs in
`studio-release.yml` so it cannot recur.

## v1.11.0

### feat(quota): the storage ceiling, R2_STORAGE_QUOTA_BYTES (vivijure-core#52, lane cf#56)

MINOR. Ships in the same parity wave as vivijure-core v1.3.0 and vivijure-local; the knob, the
accounting, and the reconcile all live in core, and this panel wires them. Hosted sets the var per
tenant; a self-hoster caps their own R2 bill with the identical feature.

- **`R2_STORAGE_QUOTA_BYTES`** -- unset / `0` / non-integer = OFF (a no-op that never touches D1). A
  positive integer = a byte ceiling enforced at SUBMIT, before the spend, with an honest **507**
  carrying the real numbers (`N bytes stored of the M-byte ceiling`). Never a truncation, never a
  partial render, never a quota discovered halfway through a film. Reads, deletes, the planner and
  chat keep working, so the operator can go delete something.
- **Fail CLOSED on a broken check (503):** a quota that is SET but cannot be read (no DB, query
  throws) denies rather than allows. Same posture as `SPEND_DAILY_CEILING`, for the same reason: a
  novice self-funds the bill.
- **Usage is accounted at write time in D1** (migration `0013_storage_usage.sql`, carrying core's
  `STORAGE_USAGE_DDL` verbatim), never read from the R2 usage API. That read is Cloudflare-specific
  and would break the Node/MinIO host, which is a parity break for a parity feature.
- **One seam:** `studioEnv` wraps `R2_RENDERS` in core's metering proxy, so every write in this
  Worker (route handlers and core orchestration alike) is accounted without touching ~30 call sites.
  The wrap is idempotent, which matters because `studioEnv` runs per request against the same
  isolate-level env object.
- **Operator surface:** `GET /api/storage/usage` (used, objects, quota, over) and
  `POST /api/storage/reconcile`, which rebuilds the ledger from the bucket. The reconcile is the
  one-time backfill for a studio that predates accounting (artifact sizes are not derivable from D1,
  so the counter starts at 0 and the docs say so) and the repair for lifecycle-expiry drift.
- `R2_STORAGE_QUOTA_BYTES` joins `ORCHESTRATOR_VAR_KEYS`, so it lands in the release manifest's
  `required_vars` census and the hosted control plane can bind it per tenant. A knob hosted cannot
  set is a knob hosted does not have.
- Tests assert the PRODUCTION wiring, not just the logic: the real `studioEnv` seam meters the real
  binding (with a negative control that the raw binding is not metered), a second `studioEnv` call
  does not double count, migration 0013 still matches core's DDL byte for byte, and every gated
  pattern still matches a POST route this Worker serves.

### fix(spend): the planner and chat routes are metered paid AI now, not an open faucet (cf#256)

- `SPEND_PATTERNS` (src/rate-limit.ts) declared itself "the POST routes that submit GPU jobs or paid
  AI work" and listed only the GPU/render/train/music routes. Every route that dispatches the
  `plan.enhance` hook sat outside the burst limiter AND outside `SPEND_DAILY_CEILING`.
- **What that meant:** the planner takes a caller-supplied `system_message` + `message` and runs it
  on the module model enum default (a frontier model, 4096 max_tokens per call, keyless on Unified
  Billing through the AI Gateway). Unmetered, a studio token was a general-purpose AI proxy billed
  to the operator. Auth-gated is not the same thing as metered.
- **Now metered:** `POST /api/storyboard/plan`, `/api/storyboard/refine`, `/api/storyboard/enhance`,
  and `/api/chat`. The four were enumerated from the route table (hPlan, hRefine, hEnhance, hChat),
  not from the report. `/api/chat` covers both of its branches, the text planner and the image
  branch, which is paid image generation and belongs on the meter just as much.
- **Same audit closed three more holes:** `renders/:id/regen-shot` (a keyframe GPU submit),
  `renders/:id/finalize` (the same submit path as `animate-cloud` / `animate-hybrid`, both already
  metered), and `renders/:id/add-narration` (the same path as `score-bed` / `music-generate`, both
  already metered). Two of the three were the unmetered sibling of a route already on the list.
- **Deliberately still free:** `/api/demo/chat` runs a Workers AI OSS model behind its own per-IP and
  global D1 caps and holds no gateway credential; `renders/:id/add-audio` muxes an artifact that
  already exists and dispatches nothing. Both are asserted as controls, not left implicit.
- No new machinery and no new operator knob: these routes ride the existing fail-closed middleware,
  so a broken limiter denies them 503 exactly as it denies a render. Sizing note for operators, the
  daily ceiling counts SUBMISSIONS, so planner calls and renders now share one budget.
- Tests pin the pattern and the WIRING separately, because a route can match a regex the middleware
  never consults: the new middleware suite drives the real `worker.fetch` entrypoint per route. Every
  guard was watched FAILING against the pre-fix file, with the two free-route controls green in the
  same run.
- **Parity disposition (no vivijure-local twin):** the self-host panel has no spend-limit surface at
  all to extend, and the primitive this rides (the Cloudflare native Rate Limiting binding) does not
  exist off Workers. A local operator spends their own GPU, which is the whole shape of that door.
  Inventing a second limiter there was out of scope for this fix; recorded here so the absence is a
  stated call and not an oversight.

## v1.10.1 -- 2026-07-26

- **fix(spend): meter the planner and chat routes (cf#256).** They were unmetered paid AI, which
  made any token holder an Opus proxy at our expense.
- **fix(panel): gate the module-host stage projection on what the host can actually serve
  (cf#234).**
- (The GitHub release for this tag reads only "Studio release artifact", so this row is reconstructed
  from the commits it carries.)

## v1.10.0 -- 2026-07-26

MINOR: the abuse-report link (control-plane#130) and the unreachable-studio sentence that can finally be READ (cf#229 / cf#234). Twin: vivijure-local v1.4.0 (same window, per the parity promise).

### feat(abuse): the studio panel can carry an abuse-report link, projected not hardcoded (control-plane#130)

- Enforcement on the hosted tier is report-driven by ruling, so a findable intake path is part of
  the product and the panel is where a render is actually seen. The hosted front door got a public
  report page (control-plane#138); this is the studio half.
- **`ABUSE_REPORT_URL` is an optional operator var**, surfaced as `host.abuse_report_url` on
  `GET /api/modules` and rendered by `public/abuse-link.js` as a quiet footer link. Absent var means
  absent field, no link, and no address anywhere in the shipped bundle.
- **That absence is the point, not a default.** This bundle is what a self-hoster installs, and we
  are not the provider for a self-hosted studio: we cannot see it and cannot switch it off, so
  advertising our address inside it would send a reporter to someone who can do nothing. There is
  deliberately NO fallback address and NO "am I hosted" branch; a self-hoster who wants their own
  contact published sets the same var and the panel shows theirs.
- **Refuses rather than passes through, in both places, defending different things.** The host side
  drops a value that is not an absolute http(s) URL and logs why (a silent no-op is how an operator
  concludes a feature is broken). The panel side refuses it again on the way into an `href`, because
  a payload string reaching an `href` is a DOM boundary and a panel can talk to an older core.
- Tests include a PARITY guard: no shipped studio asset may contain our abuse address or the hosted
  report URL, with a control asserting the asset sweep is non-empty, plus a guard that the gate has
  no fallback address to fall back to. Both watched FAILING against a planted default before being
  trusted.
- **Inert until a studio is actually provisioned with the var set,** and that is stated rather than
  left to be discovered: no studio sets it today, so this ships reaching nobody. The hosted front
  door page (control-plane#138) is the reachable path in the meantime.

### fix(hosted): the unreachable-studio sentence stops promising "not yet" (cf#229 / cf#234, swap)

> **Shipped, but not yet reachable.** The sentence is in the tree; the STATE it belongs to is not
> reachable, because nothing writes `VIDEO_FINISH_TIER_STATE` (control-plane#136) and the only live
> tenant runs a bundle that predates the reader. No studio can display it today, so do not count
> this as a change any tenant will see.


- v1.9.0 shipped the three-state resolver with the copy PINNED: `provisionable` and
  `unprovisionable` resolved to the same sentence, because cp#112 was open and a re-upload path
  would collapse one state into the other. cp#112 then shipped that path
  (`refresh-studio-bindings`, control plane v1.8.0), so the swap is now decidable and this is it.
- `VIDEO_FINISH_UNPROVISIONABLE_REASON` now reads "Video finishing is not available for this studio
  and cannot be turned on for it; finished renders deliver as per-shot clips." It drops the promise
  ("not yet" is a promise of future availability, and nobody can keep it for a studio no operator
  action reaches), it does not send the reader to an operator who cannot act either, and it keeps
  the half that matters mid-render: what they DO get. The `provisionable` sentence is unchanged.
- **What `unprovisionable` means now:** not "an old studio" (cp#112 reaches those), but a studio the
  PLANE declares unreachable. Only the plane can say that, and nothing writes
  `VIDEO_FINISH_TIER_STATE` yet, so the state is not reachable in production at all until it does.
- **This reaches ZERO live tenants today, and does not claim otherwise.** Census 2026-07-25, taken
  two ways that agree (CF-side through a third credential, D1-side through the admin surface):
  binding+channel 0, channel-only 0, neither 1, and that one is the `rollins-e2e` testbed, whose
  bindings were refreshed and whose studio bytes move separately. The estate becomes honest through
  that refresh and that bytes move; this constant is correctness for future tenants and for after
  the move.
- Tests assert the two sentences DIVERGE, that only the keepable promise carries "not yet", and that
  every studio still resolves to `provisionable` today (so the new sentence is unreachable, not
  merely unused). The property guard from #239 (never name a host env var, always say what they get)
  covers both sentences unchanged.
- **No vivijure-local twin, deliberately:** local has no third state by design (the reader IS the
  operator, every absent tier there is one they can configure), which its own module records.
  Parity is the SET and the BIAS, never the bytes (local#226).

## v1.9.0 -- 2026-07-25

MINOR: hooks truthfulness bundle (cf#229 + cf#234), third-state mechanism. Twin: vivijure-local v1.3.0 (same window).

### fix(hosted): name the capability that is absent, not four hooks that depend on it (cf#229)

- `score` was in the `hooks_unavailable` set for a VPC-less studio, which claims more than the
  truth. Bed GENERATION (`POST /api/storyboard/score-bed`, `src/score-bed.ts`) references no VPC
  binding and the film path never calls the score hook at all; only the MUX, which lays that bed
  onto a finished MP4, needs the video-finish container. Reporting the hook unservable would have
  greyed out a working generator the moment anyone correctly declared the hook it drives -- cf#98's
  own defect, pointed the other way (under-promising instead of over-promising).
- The set is now `capability:video-finish` plus `master`, `film.finish`, `notify`, read off the
  execution paths: `enterMasterOrMux` runs after an assemble that degrades, and film.finish/notify
  are driven from `transitionToDone`, which the degrade bypasses. Those three genuinely never run.
- `capability:video-finish` names the BINDING. The colon namespace is deliberate: hook names use
  dots, so a capability key can never collide with one or be read as something a module provides.
  No core contract change: `hooks_unavailable` is `Record<string,string>` on the wire and the panel
  has always treated its keys as opaque.
- The two mux buttons ("add audio", "narrate") now declare that capability instead of `score`
  (supersedes the declaration recorded in the cf#118 entry below). Same behaviour, honest reason.

### feat(planner): declare what a control NEEDS versus what it cannot DELIVER (cf#229, cf#234)

- The shared cf#98 gate grew two relationships beside the existing required one, so per-feature
  judgement stays in one attribute per control and none of it leaks into the gate:
  - `data-hook-advisory="<key>"` -- the control RUNS; its product cannot be delivered here. Noted,
    never disabled, never dimmed. The music and narration bed blocks declare this: on a studio with
    no video-finish tier they produce a real bed that simply cannot reach a film.
  - `data-hook-scope="container"` -- a required declaration on a SECTION: disables every form
    control inside it and states the reason ONCE (cf#234 option (b); tagging each generated field
    buried the panel in repeated sentences).
- `renderModuleSection` now tags each projected module panel with the hook it was rendered under,
  in container scope, so `master`, `film.finish`, and any hook added later gate generically with
  zero per-feature branches. The panel stays a projection of the registry.
- **The notification TOGGLE stays ungated, deliberately** (cf#234). `#planner-notify-toggle` is the
  browser Notification API and works perfectly with no video-finish tier; the `notify` HOOK never
  firing there is a separate, true fact. A guard test forbids a `data-hook` on that element so the
  grep-and-tag reflex cannot quietly break a working feature.
- Third state, MECHANISM ONLY (cf#240 lane D, input cp#112): `videoFinishState` resolves
  available / provisionable / unprovisionable, with the copy swap gated on the cp#112 re-upload
  path landing. Both absent-states resolve to the same shipped sentence today; the swap is one
  documented constant. Reason guards stay property-based (never names a host env var, always says
  what the tenant DOES get), so they survive the rewrite instead of blocking it.
- Tests: exact key set both directions with a positive control, the advisory/required pair proven
  opposite on the SAME key, container disabling proven over the real shipped IIFE, and declaration
  guards over the shipped assets. Every new guard was failed on purpose first (score folded back
  into the set; the advisory path made to disable) and each was caught by the intended assertion.

### fix(planner): gate the audio-mux controls on the hook they drive (cf#118)

- "add audio" and "narrate" on a completed render both end in the video-finish container
  (`muxAudioOntoRender`). On a hosted tenant with no video-finish tier the backend refused
  honestly with a 422, and the panel rendered both buttons unconditionally anyway. Clicking them
  was the only way to find out: the exact broken-button shape cf#98 was built to kill, on a
  different capability.
- Both controls now declare `data-hook="score"`, so the existing cf#98 gate disables them and
  prints the host reason. ONE attribute is the whole contract; nothing in the planner learns what
  the hook means, and the set of unavailable hooks is never hardcoded here, so a backend change to
  the reported set cannot break this.
- **The gate was INERT for every dynamically-built control, and that is the load-bearing half of
  this fix.** `hook-availability.js` applies on load and on DOMContentLoaded only; every history
  row is built after that. The gate documents the remedy in its own header ("controls rendered
  later just call apply() again") and no caller ever did. `renderHistoryList` now re-applies it
  over the rows it just built. Proven load-bearing: with the attributes declared and the host
  reporting the hook unservable, removing ONLY the re-apply leaves both buttons fully clickable
  with no note.
- Verified in a real browser against the shipped assets, both directions: host reports the hook
  unservable -> both controls disabled, `aria-disabled`, reason rendered VERBATIM, and sibling
  row controls (view / re-render / delete) untouched; host omits the key -> both enabled, no note,
  hand-written titles preserved.

## v1.8.0 -- 2026-07-25

MINOR: the cf#98 honest-hooks projection is feature-class (#221 feat + #222 fix ship together).
Also: honest measured Wan LoRA train cost estimate (#218, cf#214); docs: tier-honest
narration-gen manifest label + knobs (#219, cf#211), vivijure-tail wrangler config
committed (#220, cf#148).

### fix(planner): the host reports hooks it cannot serve (cf#98)

- `GET /api/modules` now emits `host.hooks_unavailable` (core 1.2.14) naming any hook this deploy
  cannot serve, with a tenant-readable reason the panel prints verbatim. First entry:
  `plan.enhance`, when the AI Gateway is not configured.
- **The AI gate is HOISTED, not duplicated.** `aiGatewayReady()` is one answer to "can this host
  serve an AI-Gateway hook", consumed by both the hook report and the demo `assistant` emission.
  That gating already existed but only inside the demo branch, so a non-demo deploy missing the
  gateway advertised capability it could not serve.
- It RESOLVES `GATEWAY_ID` rather than checking the binding exists: a bound-but-empty gateway id
  fails at call time exactly like an absent one, and the old `env.AI`-only test said yes to it.
- Core pin `^1.2.14`.

### fix(planner): the panel discloses a finishing degrade instead of a green "completed" (cf#118)

- When the video-finish tier is unavailable (`VIDEO_FINISH_VPC` unbound, the hosted-tenant case) the
  orchestrator degrades honestly: per-shot clips at assemble, the silent film at mux, with a reason.
  The poll payload has carried all of it since the degrade shipped (`output.finish_unavailable`
  plus `output.clips`, core `film-render-bridge.js`) and the panel dropped it on the floor. The
  render read `completed`, in green, with the fact buried in a JSON blob.
- The panel now reads `completed with limits`, states structurally what was handed over, prints the
  studio reason **VERBATIM** (never reworded or softened, same rule as the cf#98 hook gate), and
  lists the delivered per-shot clips as real download links, because those clips ARE the render.
- **Correctness, not cosmetics: the stale download link is fixed.** The assemble degrade leaves
  `output_key` UNDEFINED (core `film-output-key.js`), and the old completed-branch only ever
  ASSIGNED the anchors, inside `if (typeof out.output_key === "string")`. Nothing reset them, so a
  degraded render following a good one in the same session left "download silent MP4" pointing at
  the PREVIOUS render: the wrong film, handed over as this one. Reproduced in a real browser on the
  pre-fix asset, then re-run against the fix. Every branch now writes the anchors, including the
  empty case, which is why `deliverable()` returns `film` / `clips` / `none` rather than a boolean.
- New `public/finish-degrade.js`: pure, DOM-free, unit-tested under Node, same UMD-ish house shape
  as `hook-availability-checks.js`. Junk resolves to "no degrade", never to a scary banner on a
  render that is fine, the mirror of the cf#98 gate's bias.
- Parity: the identical change rides vivijure-local in the same window (`finalizeRenderPoll` was
  byte-identical across both panels).

## v1.7.16 -- 2026-07-24

PATCH: honest Wan LoRA train-time copy (measured). #213 set the Wan train-time copy to
~1h45m-2h, measured on the pre-fix image (train-0.1.2); #216 corrects it to ~35-45 min after a
worker-side fix shipped and was output-verified on the prod endpoint (dev-2, job
`e142243d-23db-4de4-b1ed-c1a9f38af1d5-e1`, executionTime 2356038 ms / 39.3 min, 2000 steps / 10
refs, image `train-0.1.3`). Pins `@skyphusion-labs/vivijure-core` to `^1.2.13` (core#92 reconciler
observability fix; pairs with local v1.2.0).

Known deferred: cf#211, tracked open, low priority. The canonical `narration-gen.json` manifest
still describes MiniMax-only knobs following the local#202 two-tier engine split (MiniMax-HD on
RunPod opt-in vs Deepgram Aura-1 creds-free default); the local panel runtime-overrides the served
module.json to stay honest in the meantime. No behavior change intended when it lands.

## v1.7.15 -- 2026-07-24

PATCH: finish satellite deploy parity (cf#197). On every studio tag, CI deploys
`finish-rife`, `finish-upscale`, `finish-lipsync`, and `speech-upscale` even when
`CORE_ONLY_DEPLOY=1`; canonical list in `scripts/finish-satellite-modules.txt`. Tenant release
bundles now include `finish-rife`.

## v1.7.14 -- 2026-07-23

PATCH: dual-panel with vivijure-local **v1.1.16** (K3 security closeout). Pins
`@skyphusion-labs/vivijure-core` to `^1.2.12`.

## v1.7.13 -- 2026-07-23

- **fix(security): K3 medium and low close-out** -- cast key bind, and the demo cap peek.
- **docs(security): the K3 verify medium/low false-positive disposition (#203)**, and the `cast.js`
  train-lora K2.7 false positives (KF3), recorded rather than dismissed in a chat.
- **chore(deps): pin `@skyphusion-labs/vivijure-core` to `^1.2.11` (#201).**
- (The GitHub release for this tag reads only "Studio release artifact", so this row is reconstructed
  from the commits it carries.)

## v1.7.12 -- 2026-07-23

PATCH: Wan cast train default (cf#29 Phase E). Bumps `@skyphusion-labs/vivijure-core` to `^1.2.8`.
Cast UI: Wan button POSTs `/train-lora` (core defaults to Wan train EP); SDXL escape hatch sends
`model_family:"sdxl"`.

## v1.7.11 -- 2026-07-22

PATCH: dual-panel with vivijure-local **v1.1.12** -- local-GPU film keyframes (#153). Pins
`@skyphusion-labs/vivijure-core` to `^1.2.7`.

- **feat(local-gpu):** dual-hook `local-gpu` v0.2.0 (`motion.backend` + `keyframe`) so local-motion
  films render keyframes on the door (`action: preview`) instead of RunPod (#195)
- **fix(security):** scope poll/cancel tokens by hook kind; validate jobIds; normalize backend URL
- Pair with door images `vivijure-local-{12,16}gb:1.0.3`

## v1.7.10 -- 2026-07-22

PATCH: dual-panel with vivijure-local **v1.1.11**. Core pin unchanged (`^1.2.5`).

- **fix(security):** validate cast image MIME on import/JSON media paths; sniff magic bytes; force safe content-type, `nosniff`, and `Content-Disposition: attachment` on `/api/artifact` (#193)
- **ci:** adversarial security audit workflow

## v1.7.9 -- 2026-07-22

PATCH: dual-panel with vivijure-local **v1.1.10** -- pin `@skyphusion-labs/vivijure-core` to `^1.2.5`
(cf#110 film phase `from` recovery + core#54 `HookCatalogEntry.order`), and sort Stages / planner
render panels by `catalog[].order` (drop hardcoded HOOK_ORDER / PANEL_ORDER).

- **docs(release):** top-level PIN digest is studio-only; module bundles stay self-anchored (cf#147).
- **ci:** `tsc -p tsconfig.tests.json` in `npm run typecheck` so tests/ cannot silently drift (cf#107).
- **ci:** CodeQL now extracts `public/` (studio front-door JS); dropped from `paths-ignore` (cf#128).
- **ci:** adversarial security audit workflow on a schedule (`ADVERSARIAL_AUDIT_CF_API_TOKEN`).

## v1.7.8 -- 2026-07-22

PATCH: re-list `alibaba-wan-lora` in IaC after 2x2 Wan LoRA sign-off (cf#29 follow-up), and bump
`sharp` to 0.35.3 (GHSA-f88m-g3jw-g9cj / cf#178 Dependabot residue). Uncomments
`MODULE_ALIBABA_WAN_LORA` in `wrangler.toml.example` and clears the CI deploy `EXCLUDE` so the next
tag deploy keeps the live binding. Local panel already carries the module via compose profile.

## v1.7.7 -- 2026-07-22

MINOR: pre-submit RunPod idle workersMax reconcile (cf#61). Bumps `@skyphusion-labs/vivijure-core`
to `^1.2.4`. All RunPod module workers (`own-gpu`, `keyframe`, finish satellites, `speech-upscale`)
reconcile `workersMax` via REST PATCH before `/run` when `RUNPOD_WORKERS_MAX` is set; operator batch
script `scripts/reconcile-runpod-endpoints.ts` for management keys. Scoped invoke keys get honest
idle-scale-down guidance instead of cryptic cold-start failures.

## v1.7.6 -- 2026-07-21

PATCH: bump `@skyphusion-labs/vivijure-core` to `^1.2.3` (#53 advanceFilmJob wedge fix, local#99
`output_key` honesty). Ships core#64 + core#65.

## v1.7.5 -- 2026-07-21

PATCH: fix tag deploy CI (fc#859 follow-up). Removes duplicate ancestry guard from the deploy job
(`node:22-alpine` checkout has no `.git`, so `git fetch` always failed). The `assert-on-main` job
already gates tag deploys on ubuntu-latest. **Redeploy vehicle for v1.7.4** (core 1.2.2 legacy finish
order); prod did not deploy on v1.7.4 tag push.

## v1.7.4 -- 2026-07-21

PATCH: MuseTalk finish-order fix (cf#29). Bumps `@skyphusion-labs/vivijure-core` to `^1.2.2` so
dialogue shots default to legacy finish order (RIFE -> lipsync -> upscale). #584 reorder
(lipsync -> RIFE -> upscale) is opt-in via `finish_config["finish-order"].dialogue_reorder`.
Ships cf#179 + core#62.

## v1.7.3 -- 2026-07-21

PATCH: Wan LoRA UI + planner preflight parity (cf#29 follow-up). Implements existing dual-panel
doctrine: Cast page trains Wan via `POST /train-wan-lora`; planner `lora-preflight.js` is
motion-backend-aware (`wan_lora_key_high/low` on `alibaba-wan-lora`). Paired with vivijure-local
v1.1.3; Laura test + propagandhi redeploy remain gated until both PRs merge + ops CR apply.

## v1.7.2 -- 2026-07-20

PATCH: Wan cast LoRA harvest writeback (cf#29). Bumps `@skyphusion-labs/vivijure-core` to ^1.2.1 so
`/api/cast/:id/lora-status` polls the dedicated Wan train endpoint (`RUNPOD_WAN_TRAIN_ENDPOINT_ID`)
before the render endpoint, harvesting dual expert keys on COMPLETED. R2 reconcile backfills Wren-style
rows when RunPod retention drops the job but both experts exist under `loras/lora-{slug}-*/A/`.

Ship tag `v1.7.2` on merge `9c0c3c9` (#171). The `v1.7.1` git tag was already consumed by image-prep
rembg (#158); this release aligns the package version with the deployed tag.

Requires vivijure-core [PR #59](https://github.com/skyphusion-labs/vivijure-core/pull/59) published as
`1.2.1` before deploy.

## v1.7.1 -- 2026-07-20

PATCH: image-prep rembg 2.0.76 → 2.0.77 (#158). GHCR image-prep rebuilt; tag `v1.7.1` points at this
commit, not the Wan writeback release (see v1.7.2).

## v1.7.0 -- 2026-07-20

MINOR: Wan cast LoRA train + render projection (cf#29 Phase B/C). Unblocks D2c e2e against the
dedicated train endpoint.

- **Phase B (#153):** migration `0012` adds cast Wan LoRA expert-key columns.
- **Phase C Part 2 (#154):** Wan cast LoRA projection across render paths; studio route
  `POST /api/cast/:id/train-wan-lora`; Secrets Store binding `RUNPOD_WAN_TRAIN_ENDPOINT_ID`
  ← `BACKEND_RUNPOD_WAN_TRAIN_ENDPOINT_ID` (fail-closed; never falls back to the render EP).
- **Deps / CI hygiene** since v1.6.0: dependabot bumps + `assert-on-main` deploy guard (#151).

Requires a live Secrets Store seed of `BACKEND_RUNPOD_WAN_TRAIN_ENDPOINT_ID` (D2: `zqb7tougbqfkqa`)
before Wan train submits succeed. Cast UI still posts `/train-lora` (SDXL); Wan path is API-only
until `public/cast.js` is wired.

## v1.6.0 -- 2026-07-18

MINOR: the module contract gains a credential-readiness endpoint, and stops lying about a credential
that is configured but not yet served (cf#114, a launch gate under cf#40).

- **New module-contract endpoint `GET /ready`** on all five tenant modules (`keyframe`, `own-gpu`,
  `finish-upscale`, `finish-lipsync`, `speech-upscale`): `{ ok, module, credentials: { ... } }`,
  **booleans only, never values**. It answers a question nothing outside the module can: whether the
  version the edge is ACTUALLY SERVING can read its credentials. The platform API can only report
  that a secret NAME exists, which was true during the live failure this fixes.
- **Honest credential text.** The endpoint id is bound at module upload; the API key is written
  later as a secret. Endpoint-present + key-absent is therefore diagnostic of PROPAGATION, and now
  reads `credential not yet visible on this worker version (retry shortly)` instead of the previous
  `not configured` -- which sent a real tenant chasing a correctly-configured credential during the
  cf#99 finale. Both absent stays a genuine `not configured`.
- **The soft-degrade path carries the same distinction**: the polish modules degrade with
  `runpod-key-not-yet-visible` rather than `no-runpod-secrets`, so the honest-degrade record does
  not itself carry the lie. No polish step changed its fail/degrade behaviour.
- Contract documented in `docs/module-api.md`; module manifest versions bumped (a new endpoint is a
  surface change). Tenants pick this up on re-provision against the new pin.

## v1.5.0 -- 2026-07-18

MINOR: the chat/image surface becomes module territory (cf#129). The studio now hardcodes NO model
names at all; full record on the closed issue (completion contract).

- **New core hook `image.generate`** (core 1.1.0): modules declare image models in
  `config_schema.model` and return image BYTES; the core persists them. A module holds no bucket
  binding, so a write/serve split (cf#140's class) is structurally unrepresentable. First-party
  `modules/image-generate` carries the 11 image models with every learned per-model quirk.
- **Canonical `GET /api/models`** on both hosts: the full projected catalog (planning + image rows)
  from one generalized projection; `/api/storyboard/models` stays as a filtered view with an
  agreement test. Empty catalog = `200` + honest empty array, never 404, never backfill.
- **BREAKING (response shape): rows no longer carry a `provider` field.** The studio no longer has
  that knowledge -- dispatch belongs to the declaring module. Consumers wanting provenance read the
  declaring module via `GET /api/modules`.
- **Cast image pickers are catalog-fed.** All three project the served image rows through the shared
  render path with visible honest-fail states; the hardcoded silent flag-retry fallback model is
  removed (exhaustion now fails visibly, naming the model).
- **cf#140 fixed:** chat artifacts write the SERVED bucket; the portrait-gen preview renders. Fixed
  on main here; prod carries the fix from this tag (live-verify closes the issue).
- **Module deployability:** deploy ships `image-generate` (wrangler.toml + README + service binding
  were absent -- the module could never have deployed); the operator store secret
  `IMAGE_GENERATE_OPENAI_API_KEY` is OPTIONAL (absent = opaque instead of transparent PNG), and the
  installer placeholder is treated as absent so an unreplaced optional key degrades honestly instead
  of hard-failing.
- **Billing guard pinned by test:** plan-enhance's Anthropic call must emit `cf-aig-authorization`
  and must NEVER emit `x-api-key`, whatever is in env (recording proxy + positive control).
- Dead catalog rows (55), dead `streaming`/`byok_alias` flags, and the 11-file orphaned
  provider/parser island removed (cf#133).

## v1.4.0 -- 2026-07-18

MINOR: the bare-skeleton port (cf#62). The studio stops providing model names; plan.enhance modules
do. Full record on the closed issue (completion contract) and in docs/module-api.md.

- **Planning models are module-declared.** `modules/plan-enhance` carries its models in
  `config_schema.model` (including `anthropic/claude-sonnet-5`); `GET /api/storyboard/models` is a
  projection of EVERY installed plan.enhance module's enum -- no hardcoded list anywhere in core. A
  module with no model enum is listed under its own name and label. Third-party modules are honored
  per the contract with no special-casing of ours (proven live: routing asserted by which module
  answered).
- **The planner is a module invoker.** plan/refine/chat route through the installed module
  (`config.mode`), provider dispatch left core, and `planner-catalog.ts` plus the hardcoded
  Anthropic rows in `models.ts` are deleted. Plan/refine responses carry `provider: "module"` +
  `module` (vivijure-local's shape exactly; the shared panel stays byte-identical).
- **`POST /api/chat` text path routes through the plan.enhance module** and fails honestly when no
  planning module is installed. Its image path and the rest of MODELS are unchanged (cf#129 tracks
  that catalog).
- **Panel stops inventing core-owned values.** The quality-tier fallback (which had ALREADY drifted
  from what core serves) and five hardcoded tier literals are gone; stale saved models/tiers now
  drop visibly with an honest message instead of blanking or silently persisting invented state.
- **Restore paths hardened.** Saved model/tier restores go through one guarded pending-value
  mechanism; two live-found defects (post-load stale id leaving the picker blank+silent; tier
  control blanking on stale tier) fixed and re-verified live.
- **Dev: modbound scenario harness** (`SCENARIO=default|empty|thirdparty|staleid`, `DRY_RUN=1`) for
  gate runs against real module absence; planner AI mock moved into the module (its dev wiring fix
  rode #134); teardown runbook documents the orphaned-worker hazard.
- Parity gate: cf and local panels verified functionally identical live in a browser, both hosts,
  per-surface evidence; local synced via vivijure-local#102.

## v1.3.1 -- 2026-07-18

**The v1.3.0 release artifact never published; this is the tag that ships it.** PATCH: a build-script
import fix plus the CI guard that makes this class fail on a PR instead of on a tag.

- **v1.3.0 built nothing.** The tag fired, the studio deployed (inert), the D1 migrate was a no-op --
  and then the release-artifact job died in 14 seconds with `ERR_MODULE_NOT_FOUND`. Nothing reached
  the GitHub release or the R2 mirror. The v1.3.0 tag is left exactly where it is; tags never move.
- **The cause.** `scripts/build-studio-release.ts` imported
  `../src/platform/orchestrator-vars.js`. The release workflow runs it as
  `node scripts/build-studio-release.ts`, and Node type-stripping does not rewrite relative
  specifiers: the literal `.js` path must exist on disk, and only the `.ts` does. Fixed by importing
  the `.ts` extension directly.
- **Why every gate said green.** `tsc --noEmit` accepts the `.js` specifier because
  `moduleResolution` is `bundler`, which maps it to the `.ts` source. The test suite never executed
  the script. And the pre-merge end-to-end run of the builder went through a resolver that also maps
  `.js` to `.ts`, rather than the bare `node` the workflow actually uses. Three green signals, one
  dead runtime, and the only place it could surface was a tag.
- **The guard: `tests/release-builder-runs.test.ts`.** It invokes the builder under bare `node` and
  asserts it reaches its own `missing --bundle` argument check, which proves the whole import graph
  resolved. About a second, no wrangler bundle required, and it runs in normal CI -- so a broken
  release builder now fails on the pull request. It carries a positive control, so it cannot pass by
  the script dying earlier for an unrelated reason.
- **CONSUMER NOTE, the `vivijure-control-plane` pin floor is v1.3.1, not v1.3.0.** v1.3.0 exists as a
  tag but published no artifact, so a floor pointing at it would resolve to an empty mirror slot:
  it would fail honestly, but confusingly. The manifest shape is unchanged from what v1.3.0
  described (`migrations` + `required_vars`); only the tag that actually carries it has moved on.

## v1.3.0 -- 2026-07-18

**The studio release artifact carries its own schema and its own env contract (cf#85).** MINOR: a new
manifest capability, added so the hosted control plane can be extracted into its own repository
without reaching back into this one.

- **`manifest.json` gains `migrations` and `required_vars`.** The release artifact now ships the
  tenant D1 schema (every top-level `migrations/*.sql`, in apply order, each with its own `sha256`
  and `size`) and the studio env var contract (`ORCHESTRATOR_VAR_KEYS`, projected at build time).
  `studio-release.yml` uploads `migrations/` to the R2 release mirror alongside `worker.js` and
  `assets/`.
- **Why: the hosted control plane was reaching into this repo at build time.** It imported
  `../../migrations/*.sql` and `ORCHESTRATOR_VAR_KEYS` directly. The extraction contract (cf#85)
  forbids source-level imports across the repo seam, since the control plane consumes the studio ONLY
  as a published artifact, so the two things it legitimately needs had to move INTO the artifact.
  Copying them into the new repo was rejected: a copy plus a guard test that validates the copy is a
  drift factory with a green light on it, and drift in exactly these two lists is what caused two
  live provision failures.
- **This closes the versioning caveat that `studio-migrations.ts` documented against itself.** The
  migrations used to ride the CONTROL PLANE deploy commit while the worker was a pinned RELEASE, so
  a tenant could get its schema from one version of the studio and its worker from another. Tenant
  schema and tenant worker now come from ONE pinned artifact and that skew cannot exist.
- **Migrations are named, not content-addressed.** The runner records each by FILENAME in the tenant
  `schema_migrations` table, so the name is load-bearing state rather than a label.
- **The builder refuses a zero-migration set.** A silent empty set would give every new tenant a
  blank D1 and report success, the worst failure mode available. Both refusal paths (empty directory,
  missing `--migrations`) are negative-tested with a positive control on the same command.
- **`ORCHESTRATOR_VAR_KEYS` moved to a leaf module** (`src/platform/orchestrator-vars.ts`, zero
  imports); `cf-platform.ts` re-exports it, so every consumer is unchanged and there is still exactly
  ONE source of truth. It is a leaf because the consumer is a plain node build script, which has no
  business dragging the Worker runtime graph (Env, presigner, secret store, module transport, R2
  store) in behind a list of strings.
- **CONSUMER NOTE, the `vivijure-control-plane` pin floor is v1.3.0.** The extracted control plane
  reads migrations and the bind census from the pinned bundle and FAILS LOUD below this tag, with no
  baked-in fallback. `tests/release-manifest-contract.test.ts` guards the shape: the manifest is now
  an interface consumed by another repository, so removing a field is a breaking change.
- **Test-side fix (cf#107).** `orch()` in `tests/orchestrator-env.ts` attached `PRESIGNER` and then
  declared its return type as plain `T`, discarding the type it had just added. Invisible because
  `tsconfig` never typechecked `tests/` and vitest transpiles without checking. Type-level only; no
  behaviour change.

## v1.2.6 -- 2026-07-18

**The tenant studio gets the env its own code requires (#116).** PATCH: the fifth and last defect of
the "a value known at provision time never reaches one of its consumers" family.

- **`R2_S3_ENDPOINT` is bound on the tenant studio (cf#116).** `r2-presign.ts` requires all four of
  `R2_S3_{ACCESS_KEY_ID,SECRET_ACCESS_KEY,ENDPOINT,BUCKET}` and throws without them. Three were
  bound. So a tenant provisioned 9/9 green, came up live, rendered its keyframe (a real 1MB PNG,
  in R2), and then threw inside the keyframe -> clips handoff on EVERY poll, forever, surfacing as an
  opaque 500. Deterministic, no race. The value is an identifier, not a credential: constructed as
  `https://<account>.r2.cloudflarestorage.com`, the same endpoint already handed to the RunPod
  templates.
- **Parity break, not just a missing var.** Self-host derives `R2_S3_ENDPOINT` from
  `CLOUDFLARE_ACCOUNT_ID` at deploy, so a self-hosted studio could presign and a hosted tenant could
  not, on identical code.
- **All 18 platform vars now carry a deliberate disposition.** `tenant-studio-env.ts` records, for
  every key in the studio's `ORCHESTRATOR_VAR_KEYS`, whether it is `provisioned`, `conditional`,
  `default` (deliberately absent, with the safe behaviour named), or `not-hosted` -- each with its
  reason, verified against the reading code rather than guessed from the name. Three "absent is
  fine" claims were checked directly: `ALLOW_UNAUTHENTICATED` allows only on the literal `"true"`
  (absent = deny), `SPEND_LIMIT_FAIL_CLOSED` is `!== "false"` (absent = fail-closed), and
  `FILM_CLIP_DURATION_FLOOR` falls back to the core default.
- **The two lists are now linked in CI.** The studio's contract and the provisioner's bindings were
  hand-maintained separately with nothing connecting them, which is the actual defect class: they
  drifted silently and surfaced only at a first render. A gate now asserts the disposition map is
  exhaustive in BOTH directions against `ORCHESTRATOR_VAR_KEYS`, and that every `provisioned` var
  appears in the RECORDED UPLOAD rather than merely in a source array.
- **The verify census covers the contract.** It previously checked a remembered subset, which is why
  provisioning reported green over a studio that could not presign: a var nobody listed is a var
  nobody checks.

## v1.2.5 -- 2026-07-18

Five control-plane provisioning fixes, all of the same family: provisioning that reported success
without having reached a state the next step depends on.

- **fix(control-plane): drive provisioning across invocations instead of one `waitUntil` (#112).**
- **fix(control-plane): wait for the studio to serve the uploaded token before installing modules
  (#108).**
- **fix(control-plane): track tenant D1 migrations instead of replaying them (#105).**
- **fix(control-plane): write the minted R2 credential to adopted RunPod templates (#83).**
- **fix(control-plane): bind `R2_S3_ENDPOINT`, and link the tenant studio env contract to CI
  (#116).**
- (The GitHub release for this tag reads only "Studio release artifact", so this row is reconstructed
  from the commits it carries.)

## v1.2.4 -- 2026-07-18

**Provisioning survives its own execution budget (#112).** PATCH: a provision no longer has to fit in
one invocation, and a lost driver can no longer strand a tenant forever.

- **Poll-driven continuation (cf#112).** A provision job ran under a single `waitUntil`, whose
  extension window is on the order of 30 seconds. Run 4 of the cf#99 finale spent ~22 of those
  seconds before the module install even began; the runtime then cancelled the invocation mid-step.
  Nothing wrote a terminal state, because the `catch` that writes one only runs if the function is
  still running, so the job row said `running` forever and the tenant sat at `provisioning` with no
  error and no retry path. `runProvisionJob` now works until a per-invocation budget (15s) is spent,
  persists progress, and YIELDS. The poll route drives any unfinished job forward under its own fresh
  invocation, so the client's normal polling cadence walks the provision to completion. Shortening
  individual waits was rejected as a fix: it buys headroom, not correctness, and the next slow step
  puts us back in the same hole.
- **A yield is not a failure.** Progress is persisted and the job stays `running` with no error;
  only a real fault writes a terminal failure.
- **Continuation is bounded by credential custody, deliberately.** Key A is transient by design and a
  poll-driven driver does not have it, so continuation can only complete a job that already reached
  the studio upload (it needs just `endpoints_json` and the encrypted studio token). A job interrupted
  earlier now fails honestly telling the tenant to provision again, rather than waiting forever for a
  driver that could never succeed.
- **Lease-guarded, because polls overlap.** Several polls are in flight at once; without arbitration
  each would start its own driver and two drivers would double-mint credentials. `claimJob` is a
  conditional UPDATE, so exactly one poll wins and the rest do nothing. The lease also stopped being
  pushed 10 minutes into the future on every step, which under continuation would have kept a dead
  job un-drivable for ten minutes -- the same bug wearing a lease.
- **Lost invocations are declared, not tolerated.** A non-terminal job with no progress for over ten
  minutes is marked `failed` with `invocation lost: no progress for over 10 minutes`. An eternal
  spinner is a lie of omission: the tenant can neither wait it out nor retry.
- **Every studio dispatch is time-bounded.** `AbortSignal.timeout` on `callTenantStudio` (probe and
  installs alike): bounding a retry loop does nothing if one request inside it can hang forever.
  The module-install probe deadline drops from 60s to 15s, sized against the invocation budget it
  actually runs in rather than against wall-clock optimism.

## v1.2.3 -- 2026-07-18

**Provision survives an adopted RunPod template (#83).** PATCH: the third and last adopt-path defect
the hosted-tier finale surfaced. An adopted tenant now renders instead of dying on R2 auth.

- **Adopted templates get the freshly minted R2 credential (cf#83).** `createTenantEndpoints` is
  idempotent-by-name, but an adopted ENDPOINT short-circuited the whole iteration and an adopted
  TEMPLATE was reused as-is, so the newly minted R2 credential only ever reached a template we
  CREATED. Every provision mints a new bucket-scoped credential, so an adopted tenant provisioned
  green (9/9 steps) and then died at its first render with
  `botocore ClientError (401) HeadObject: Unauthorized`, because the container was authenticating
  with the credential baked in on an earlier run. The template is now refreshed via
  `PATCH /templates/{id}` on every provision, BEFORE the endpoint is touched, so the fresh credential
  reaches every consumer before anything can invalidate the old one.
- **An endpoint with no matching template is now a refusal, not a silent pass.** That is the one
  shape where the minted credential has nowhere to go; reporting the endpoint as ready would be the
  same lie in a new costume, so it fails loudly instead.
- **The env asymmetry survives the refresh path.** The backend reads `R2_ENDPOINT` +
  `HF_HUB_OFFLINE`, satellites read `R2_ENDPOINT_URL` (finding F17). Getting that wrong on refresh
  would only surface at a tenant first render, so it is asserted directly.
- **Gated by a state-reading test, not a call-counting one.**
  `tests/control-plane/adopted-template-cred.test.ts` uses a RunPod fake that STORES template env and
  asserts the adopted template OBJECT ends up carrying the minted credential. Asserting that an
  updater was called would pass against an updater that wrote nothing, which is the stub class that
  let this ship broken. Mutation-checked: skipping the refresh reproduces the live stale-credential
  shape (`expected 'STALE_AK_revoked' to be 'FRESH_AK_minted_this_run'`).

## v1.2.2 -- 2026-07-18

**Provision survives an adopted studio script (#108).** PATCH: the second adopt-path defect the
hosted-tier finale surfaced. `modules_install` no longer races the token it just uploaded.

- **`modules_install` waits for the studio to actually serve the new token (cf#108).** The
  provisioner mints a fresh `STUDIO_API_TOKEN`, rides it into the tenant studio upload as a
  `secret_text` binding, then immediately drives that studio for each module. The studio script name
  is slug-based, so a re-provision ADOPTS the existing script object, and the edge can still be
  serving the PREVIOUS version, which carries the PREVIOUS token. The install 403d and the whole
  provision failed at step 7 of 8. A brand-new script has no previous version, which is why the
  earlier fresh-slug run passed this step and the first adopt run did not. There is now a bounded
  pre-install liveness probe: one authenticated read, retried with backoff until the studio answers
  200 or a 60s deadline expires, run once before the per-module loop.
- **The retry cannot launder a bad credential.** 403 is retryable ONLY inside the probe window,
  because 403 is exactly what a stale serving version looks like. Any non-403 fails immediately
  rather than burning the window on a real error. A genuinely wrong token exhausts the deadline and
  fails loudly with attempt count and elapsed time. Per-module installs stay single-attempt: the
  probe did not turn the install loop into a retry loop.
- **Gated by test, including the negative half.** `tests/control-plane/studio-token-probe.test.ts`
  models a stale version that rejects every path, not just the probe. Mutation-checked twice:
  removing the probe reproduces the live `install keyframe (...) -> 403: {"error":"bad API token"}`,
  and making the probe succeed on exhaustion instead of failing turns the negative tests red.
- **Recorded on #108: `modified_on` is not a freshness signal.** On a Workers-for-Platforms
  dispatch-namespace script it tracks creation and matches the namespace `created_on`; it does not
  move on re-upload. It nearly produced a wrong diagnosis here. Check bindings, or another
  content-derived fact, to decide whether an upload landed.

## v1.2.1 -- 2026-07-18

**Provision survives an adopted D1 (#105).** PATCH: the hosted-tier finale hit a hard failure on
the first provision that adopted an EXISTING tenant database; `d1_migrate` is now tracked rather
than replayed.

- **`d1_migrate` no longer replays every migration (cf#105).** `d1_create` is adopt-on-exists, but
  the migration step applied the whole bundled set unconditionally, on the stated assumption that
  the files are all `CREATE TABLE IF NOT EXISTS` and therefore safe to re-run. That assumption was
  false: four of the ten bundled migrations are `ALTER TABLE ... ADD COLUMN`, which SQLite has no
  `IF NOT EXISTS` form for. Provisioning against an already-migrated database failed at step 2 of 7
  with `duplicate column name: voice_id: SQLITE_ERROR`, deterministically, blocking every retry and
  re-provision. The tenant D1 now carries a `schema_migrations` table and the runner applies only
  what is missing, recording each migration by filename as it goes.
- **Adopted pre-tracking databases are reconciled, not re-migrated.** If the tracking table is
  absent or empty but the database already carries studio tables (structural probe on
  `cast_members`, created in `0001_init.sql`), the full bundled set is seeded as applied and
  nothing is run. KNOWN LIMITATION, stated rather than hidden: a database sitting at an OLDER
  migration level than the current release is mis-seeded as current. Acceptable today because every
  adoptable database is at the current level, and self-healing for all future migrations now that
  tracking exists. Tracked on #105 / #84.
- **Replay safety is now gated by test.** `tests/control-plane/migrate.test.ts` runs the REAL
  shipped migration set through a D1 fake that refuses a duplicate `ADD COLUMN` exactly as SQLite
  does, including a control assertion that the fake can actually fail. Mutation-checked: with the
  skip-check removed the gate reproduces the live `duplicate column name: voice_id` error. The old
  step-machine tests faked `queryD1` as a no-op, which is why they proved ordering and custody but
  never replay safety.

## v1.2.0 -- 2026-07-18

**The hosted render bridge (#99).** MINOR: the last gap from the hosted-tier e2e burn -- a
provisioned tenant now comes up with working render modules, not an empty catalog.

- **Tenant render-module provisioning (cf#99): the studio-to-endpoint bridge.** A provisioned
  tenant came up live but with ZERO render modules (`/api/modules/installed` empty, renders
  503'd): the spec built the studio and the GPU endpoints but not the module workers that read
  the endpoint ids. The provisioner now, per tenant, uploads tenant-configured copies of the
  module workers (`keyframe`, `own-gpu`, `finish-upscale`, `finish-lipsync`, `speech-upscale`)
  into a shared `TENANT_MODULE_NAMESPACE` (tenant-id-prefixed script names), binds
  `MODULE_DISPATCH` on the tenant studio (upload metadata only -- the studio bundle stays
  byte-identical to self-host), and installs each through the studio's OWN conformance-gated
  `/api/modules/install` route. Key B lands on the studio + every module script in
  `installInvokeKey`. Teardown prefix-sweeps the module scripts and censuses zero remain. Module
  bundles ship in the SAME release artifact (`studio-releases/<tag>/modules/<name>/`), built by
  `scripts/build-module-release.ts` and fetched + integrity-checked by `r2ModuleBundleSource`.
  New required var: `TENANT_MODULE_NAMESPACE` (provisioner-created if missing).

## v1.1.0 -- 2026-07-17

**The hosted-tier train lands (#63-#82).** MINOR: hosted control plane, studio release
pipeline, provisioner wiring. This is the first tag intended to produce a published studio
release artifact (the v1.0.0 GitHub release carries no assets and predates the #77/#78/#79
asset fixes).

- **Hosted control-plane worker** (`wrangler.control-plane.toml`): accounts + magic-link
  sign-in, AUP acceptance gate at signup, and the tenant provisioner over Workers for
  Platforms dispatch (per-tenant D1, R2 bucket, RunPod endpoints). With no studio release
  pinned or no provisioner token configured, provisioning refuses honestly with a 503
  before writing any rows.
- **Studio release pipeline** (`.github/workflows/studio-release.yml`): a `v*` tag builds
  the per-tag tenant studio artifact, attaches it to the GitHub release, and mirrors it to
  the R2 release bucket with a tag + sha256 manifest. The manifest carries `assets_config`
  so tenants get the tested asset shape (#78); `run_worker_first` is set so tenant
  hostnames never fall through to static assets (#77); tenants get the release's own
  asset handling (#79).
- **Provisioner wiring (#82):** `runProvisionJob` dispatched via `waitUntil`; real
  invoke-key install via per-script secrets; provisioning exempt from the signups gate;
  production `StudioBundleSource` reads the R2 release mirror; migrations ship as wrangler
  Text modules with a disk-parity guard.
- **Container revert:** module containers back on py3.11 (#71).
- **Installer default:** `UPSCALE_IMAGE_TAG` `1.0.0` → `1.0.1` (matches vivijure-upscale v1.0.1 GHCR). Live RunPod endpoint retag remains operator-opt-in / spend-gated.
- **deploy:** bump installer `*_IMAGE_TAG` defaults to the current promoted constellation
  line (`BACKEND_IMAGE_TAG` `1.0.2`; upscale / musetalk / audio-upscale `1.0.0`). Live RunPod retag
  remains operator-opt-in (no spend from this bump). Closes #41.

## v1.0.0 -- 2026-07-16

**Vivijure Cloudflare host leaves pre-1.0.** Aligns the CF control panel with the constellation
stable line (vivijure / doors / finish modules at v1.0.0).

- **Homelab MCP wrangler:** `wrangler.mcp.flatliners.toml` -> `wrangler.mcp.propagandhi.toml`.
  Custom domain is `studio-mcp-propagandhi.skyphusion.org` (`studio-mcp-flatliners` dropped).
  Cloudflare Worker *script* name stays `vivijure-studio-mcp-flatliners` until a deliberate rename
  migration (non-destructive).
- Includes all v0.21.x fleet restore and media-container fixes shipped on main since the last tag.

## v0.21.4 -- 2026-07-15

- **Restore the module fleet to IaC: re-vendor all 25 `modules/*/wrangler.toml` and turn
  `CORE_ONLY_DEPLOY` off.** The #774 studio move carried module SOURCE into this repo but not the
  deploy configs, so the fleet was orphaned from CI and last shipped by hand (2026-07-13). The
  authoritative tomls are restored from the pre-split history (placeholder store/service ids, injected
  in CI from repo vars/secrets exactly like the core), so a tag now deploys the whole fleet + core
  from source with no manual `wrangler deploy`. `CORE_ONLY_DEPLOY` is kept as an opt-in core-only
  safety valve but defaults off. Nothing is hand-deployed unless it genuinely cannot be IaC'd.
- **`local-gpu` v0.1.2 honors the active door's declared duration grid at submit time.** A fixed-grid
  door now supplies both `fps` and the selected tier's frame count instead of inheriting
  `seconds * fps` from the shared module defaults. This prevents CogVideoX-5B-I2V from accepting
  off-grid 25/41-frame jobs that report success but decode as latent tile noise. Flexible LTX doors
  omit `duration_grid` and retain the existing duration-derived behavior. This release is what ships
  it live (the module worker deploys via the restored fleet pipeline above).

## v0.21.3 -- 2026-07-13

**Bump `@skyphusion-labs/vivijure-core` to `^0.9.5`: the #29 advance-lease idempotency fix.** PATCH.

- **#29 (film-advance lease is now idempotent under retry).** The core lease (migration 0007) stored only
  `advance_lease`, the winner's expiry (unix ms) -- NOT a unique leaseholder identity. On Cloudflare
  `Date.now()` is coarsened + frozen per-invocation, so two drivers racing in the same millisecond compute
  the identical expiry; that made `claimFilmAdvance` non-idempotent under `withD1Retry`: a committed-but-lost
  UPDATE response, when retried, no longer matched the `advance_lease < now` predicate (the lease is now
  future), so the true holder wrongly read `{ won: false }` and wedged the film up to a full TTL (300s).
  Core `^0.9.5` writes a per-claim UUID into a new `advance_lease_token` column (generated ONCE, so every
  retry re-binds the same token) and adds `OR advance_lease_token = ?` to the claim predicate: a
  lost-response retry matches its own committed token (a real win, no stall), a same-ms loser carries a
  different token (correctly loses), and release clears by token (a stale release can never free another
  driver's live lease).
- **Migration 0011 (`0011_advance_lease_token.sql`).** Additive-only (`ALTER TABLE renders ADD COLUMN
  advance_lease_token TEXT`) -> rides the normal auto-apply, applied before the core deploy so the column
  exists when the `^0.9.5` code references it. Backward compatible: NULL = unleased / a legacy row; a fresh
  UUID never equals NULL.

- **Core-only deploy switch (`CORE_ONLY_DEPLOY`).** vivijure-cf is the stripped host on the PUBLISHED
  core: it owns the core worker + registry wiring, and the module workers are deployed and managed
  independently (they stay live and are bound by service name). The tag-deploy module step now honours a
  `CORE_ONLY_DEPLOY=1` repo variable: when set it deploys the core worker only (+ applies D1 migrations),
  skipping the module fleet with an explicit log (and a loud drift warning if module configs are present
  anyway). Unset preserves the full monolith-style co-deploy. This lets a core-only change (like this #29
  bump) ship without redeploying 25 live module workers.

**Retire the `text-overlay` finish module (dead code; superseded by `subtitle` + `film-titles`).** PATCH.

- **`text-overlay` retired, not fixed.** The module read its content from `req.config.overlays` (an
  array), but `overlays` was never a declared `config_schema` field (schema types are only int / float /
  bool / enum / string; there is no array type). The core `validateConfig` (`src/modules/registry.ts`)
  builds a module's validated config ONLY from declared schema keys, so `overlays` was always stripped
  before the module saw it: it could never receive overlay content through any path (config or derived),
  and always took the clean no-overlays passthrough. Captions and title / credit cards are already covered
  by the working, output-verified `subtitle` and `film-titles` modules. Removed: the
  `modules/text-overlay/` worker, its `MODULE_TEXT_OVERLAY` service binding in `wrangler.toml.example`,
  the CI + deploy-doc references, and `tests/text-overlay.test.ts`. The `film-orchestrator` chain-advance
  fixtures that used it as a generic unmodeled finish step now use a neutral `MODULE_FINISH_STUB`. The
  core auto-discovers modules via the `MODULE_*` service-binding scan, so dropping the binding delists it
  after the next core deploy.

**Delist `alibaba-wan-lora` from the v1.0 distribution (unverified, not retired).** PATCH.

- **`alibaba-wan-lora` delisted pending verification (#771).** Its distinguishing feature -- injecting
  custom operator LoRAs into the Wan 2.2 cloud i2v path (`high_noise_loras` / `low_noise_loras`) -- is
  UNVERIFIED: exercising it needs a hosted Wan2.2 i2v LoRA artifact, and the cast LoRAs on hand are SDXL
  keyframe LoRAs (wrong architecture), so a render with empty LoRA arrays only duplicates the already
  output-verified `alibaba-wan` backend. Rather than ship an advertised-but-unverified feature in v1.0, the
  module is DELISTED, not retired: the `MODULE_ALIBABA_WAN_LORA` core binding is commented in
  `wrangler.toml.example`, the module DIR is added to the CI deploy-loop `EXCLUDE`, and it is dropped from
  `deploy.sh` `STANDARD_MODULES`. The module SOURCE and its tests stay intact; re-enable the binding + drop
  it from `EXCLUDE` once the custom-LoRA path is output-verified with a real Wan LoRA.

## v0.21.2

**Stop the full-film route from retraining already-ready cast LoRAs, and record the honest quality tier (#762).** PATCH.

- **#762 (Bug 1, the LoRA-retrain regression):** the full-film submit route (`hStartFilm`) resolved a
  ready cast's banked adapters (`resolveCastLoras` -> `pretrained`) but then **dropped `pretrained_loras`**
  when handing off to `startFilmJob`, forwarding only `cast_loras` (the write-back ids). The GPU worker
  therefore got no adapter to reuse and **retrained each LoRA from scratch** -- the ~20-minute, no-signal
  inline retrain the storyboard/scatter routes were already fixed against, but the film route never was
  (hit live 2026-07-12: a film with two `lora_status: ready` characters sat 23 min "in keyframe"
  retraining them). The film route now forwards `pretrained_loras` exactly like `hSubmitRender`, so the
  worker reuses the banked adapter. A regression test now asserts every submit path forwards
  `pretrained_loras` for a ready cast, so this class cannot silently regress again.
- **#762 (Bug 2, tier row-label honesty):** `filmRowFromJob` hardcoded `qualityTier: "final"`, so a draft
  film was mislabeled `final` in the renders-history row. The ACTUAL render already honored the requested
  tier via the baked `keyframe_config.quality_tier` + `motion_config` (the hardcode never reached the
  GPU), but the recorded row lied. `hStartFilm` now reads an optional top-level `qualityTier`, threads it
  onto the job, and `filmRowFromJob` records `job.quality_tier` (defaulting `final` when absent).
  Documented in `docs/CONTRACT.md` 2.20; slate wires its film submit to send the field separately.

## v0.21.1

**Fix a bundle-key collision that corrupted concurrent same-title renders (#759).** PATCH.

- **#759:** `assembleBundle` derived the bundle R2 key from the project title alone
  (`bundles/<projectName>.tar.gz`), so two renders sharing a title -- trivially the default "Untitled",
  or the same project rendered twice concurrently -- resolved to the **same key** and overwrote each
  other's tarball mid-render, corrupting whichever render read the bundle after the other's PUT (hit
  live 2026-07-12: two slate films, both "Untitled", both pointing at `bundles/Untitled.tar.gz`). The
  key is now content-addressed -- `bundles/<projectName>-<sha256(tar)[:16]>.tar.gz` -- so distinct
  bundles never collide, while a byte-identical re-render still dedupes to the same key (idempotent).
  Same content-addressed pattern already used for the `cast-clean/<sha256>` portraits. The returned
  key is persisted on the job, so all downstream reads are unaffected; no API/contract change.

## v0.21.0

**Cancel any in-flight render from the history list (#757).** MINOR (new planner capability, additive).

- **#757:** the render-history list now shows a **cancel** button on every non-terminal row
  (`IN_QUEUE` / `IN_PROGRESS` / `SUBMITTED` / `SCATTERING`), wired to the existing
  `DELETE /api/storyboard/render/:jobId` route. Previously the only cancel control was the render
  panel's own button, which appears solely for a render the panel itself launched -- so a render
  started out-of-band (the slate bot, a direct API call, the Studio MCP) was in-flight and burning GPU
  with no way to stop it from the UI (found live 2026-07-12: two slate renders had to be cancelled by
  hand via curl). Now if a job is visible on the list, it can be cancelled there, whoever launched it.
  Terminal rows never show the button; on a readonly/demo deploy the mutation fetch shim blocks the
  `DELETE`, so no extra gate is needed. No backend change -- pure frontend over routes that already
  existed.

## v0.20.3

**The S40 tail: surface the real per-shot error on a zero-clip film.** PATCH (fix-class, no new
features, contract unchanged). Ships the #755 fix that was merged after the v0.20.2 train.

- **#754 (PR #755):** when every clip failed, a film died with the bare generic "no clips rendered to
  assemble", discarding the per-shot reasons already on `clipJob.shots[].error`. A door / backend's
  real error (e.g. the clip-upload `Unauthorized` behind `vivijure-local-12gb#99`) never reached the
  operator, turning a config issue into a long hunt. New pure `describeClipFailures(job)` aggregates
  each failed shot's `shot_id: <reason>` so the zero-clip failure now reads "no clips rendered to
  assemble -- shot_01: <real error>; ...", falling back to "unknown error" for a reasonless shot and
  to the bare generic when nothing failed with a reason. Honest-failure doctrine (#245/#249): a
  failure must name WHY. The rarer post-finish "no clips to assemble" site (no per-shot job in scope)
  is left as a follow-up.

## v0.20.2

**The S40 total-shakedown fix batch.** PATCH (all fix-class; every documented feature, knob, error
path, and event was exercised live against prod and the doors, and every divergence from the
S39-truthed docs was fixed). No new features; the contract is unchanged except where a route was made
MORE honest.

Honest-failure fixes (the #245/#249 doctrine, pushed to every path):
- **#738 (PR #742):** `POST /api/render/film` now `400`s a bound-but-untrained `cast_loras` (the
  untrained-cast message), symmetric with `/api/storyboard/render` -- it no longer silently dropped
  the binding and shipped generic characters. This is the direct-API + Slate bot path.
- **#739 (PR #745):** `castLoras` is now OPTIONAL on the scatter path (absent/empty -> generic
  shards, like the film/render siblings); the old hard "castLoras required for scatter" was unintended
  coupling from the v0.2.0 bulk ship. A PRESENT-but-untrained binding still `400`s, so the relax never
  reopens the silent-drop class.
- **#751 (PR #752):** the #707 preflight clamp warning now ESCALATES to a submit-blocking `error` when
  the clamp would land below the `FILM_CLIP_DURATION_FLOOR` gate (a guaranteed hard-fail), instead of
  telling the user the render is "unblocked". A within-floor clamp stays a warning.

Correctness / honesty-in-errors:
- **#731 (PR #734):** `/api/storyboard/yaml` and `/api/storyboard/markers` return `400` on bad input
  instead of `500` (yaml validated a raw storyboard before serializing; markers checks its format enum).
- **#737:** `/api/upload` returns `size` (was `bytes`), matching its two sibling upload routes and
  CONTRACT 2.10; plus four stale CONTRACT lines trued up (UUID ids, renders default limit 50, fixed
  `whoami`).
- **#740 (PR #741):** the planner project picker now syncs to the active project after a create (was
  stuck on "(no project)").
- **#743 (PR #744):** the YAML preview tab is no longer blank after plan/refine (fetches the preview
  the same way scene-edit does, and the dead `data.yaml` read is gone).

Docs-truth (fixes to what the contract claimed, not behavior):
- **#730 (PR #736):** the `bundle_key` path-format guard is now documented in CONTRACT 2.18/2.20/2.23;
  the #696 config-map array message reads "not an array".
- **#746 (PR #748):** the `quality_tiers` blurbs are scoped to the reference cloud backend (the frame
  counts are backend-specific; delivered truth is always `clip_deliveries`).

Deploy / infra:
- **#686 (PR #747):** `down --delete-data` now empties a non-empty R2 bucket (paginated) before
  deleting it, so a teardown of an install that actually rendered no longer dies at the bucket step.
- **#725 (PR #733), #726 (PR #732), #657 (PR #735):** stale `constellation.sh` profile comments fixed;
  dead `EMAIL` binding removed; the Python installer's media-provisioning path documented.
- **#729:** the straggler path-scoped Cloudflare Access app on `/health` (created after the v0.12.0
  Access drop) was deleted; `/health` is public again, matching CONTRACT 2.2 and SECURITY.md.

Banked for post-shakedown (filed, not in this release): #749 (deploy/ pytest not gated in CI), #750
(demo `render.available` is a config flag, not a door healthcheck). Backend pin alignment to `0.4.9`
(#728) shipped in `vivijure-backend` (PR #251).

Release-prep files: package.json, CHANGELOG.md (the code landed in PRs #732/#733/#734/#735/#736/#737/
#741/#742/#744/#745/#747/#748/#752, already on `main`).

## v0.20.1

**Clip polls tolerate transient errors (#719, PR #720).** PATCH (fix class). The standing-door
verify killed a healthy render at ~2min: the local door's `/status` stalls up to ~5s mid-sampler-step
(GIL hold under model offload), one poll landed in the stall, and `applyPoll` stickily failed the
shot on that single transport blip. The finish chain has had the right contract since #141; the clip
poll now gets it: `classifyTransientFailure` (the shared transient-vs-deterministic classifier;
`classifyFinishFailure` delegates to it) + a `CLIP_POLL_MAX_ATTEMPTS` (3) CONSECUTIVE-blip budget --
a transient error holds the shot pending, a healthy round-trip resets the streak, exhaustion fails
loud citing the real error, and a deterministic module-reported reject still fails immediately.
Studio prong of the two-pronged #719 fix; the door-side root cause (sub-second `/status` under
render load) ships in vivijure-local-16gb v0.3.2 / -12gb v0.4.2.

Files: package.json, CHANGELOG.md, src/render-orchestrator.ts, src/film-model.ts,
tests/render-orchestrator.test.ts.

## v0.20.0

**The S37 fix queue: the S36 e2e findings landed.** MINOR (new features: duration honesty
surfacing + the duration-grid contract field). Everything follows the honest-failures doctrine.

- The 90min hard ceiling tracks real progress on per-shot phases (#704, PR #708): clips/speech/
  finish measure `PHASE_HARD_DEADLINE_SECONDS` against `last_progress_at` (re-stamped on every
  finished shot, #136) instead of `phase_started_at`, so a slow local-gpu card landing one clip
  every few minutes never hard-fails a healthy big film mid-progress, while 90min since the LAST
  landed shot still fails loud. The batch keyframe phase keeps phase-age semantics.
- The `distilled` tier-honesty flag flows end to end (#705, PRs #710 + #712): the local-gpu module
  passes the backend's `distilled` through (thanks @skyphusion-albini), the canonical contract
  carries it (`MotionBackendOutput.distilled?`, additive), `applyPoll` retains it per shot, and the
  film summary + poll view surface it. Absence stays absent, never a fabricated false.
- Duration honesty for fixed-grid backends (#707, PRs #709 #711 #713 #715 #714; the issue stays
  open for the door-side /health declaration):
  - `clip_deliveries` on the film summary AND the planner poll view: per done shot,
    `planned_seconds` vs `delivered_seconds` (+ fps/frames/distilled), absent until a backend
    reports numbers.
  - Contract: `ModuleManifest.duration_grid` (additive, no MODULE_API bump) -- a fixed-grid
    motion backend's pinned fps + per-tier frame caps; documented in docs/module-api.md.
  - Preflight warns per shot that would be clamped (`motionBackend` + `quality` optional on the
    /api/storyboard/preflight envelope); warning, never a submit-blocking error.
  - The local-gpu module RELAYS a door-declared grid from the door's /health into its manifest
    (best-effort, 1.5s timeout, 5min pos/neg cache so module discovery never hangs on a down door).
  - Panel: per-shot "delivered / planned" honesty line with an amber clamp flag and a
    "(distilled)" marker; preflight re-runs on backend/tier change.

Files: package.json, CHANGELOG.md, src/film-model.ts, src/film-orchestrator.ts,
src/render-orchestrator.ts, src/film-render-bridge.ts, src/preflight.ts, src/index.ts,
src/modules/types.ts, modules/local-gpu/src/{contract,i2v,index}.ts, public/planner-preflight.js,
public/planner-init.js, public/planner-history-row.js, public/styles.css, docs/module-api.md,
tests/*.

## v0.19.5

**The honesty batch: the four S31 GPU-proof findings fixed.** PATCH (fix class; no new features).
All four were live-hit during the 2026-07-11 v0.19.4 proof renders and every fix follows the
honest-failures doctrine: a degrade is never silent, garbage bounces loud before spend.

- Per-shot duration honesty gate at assemble (#697, PR #700): the video-finish container probes
  each normalized clip's ACTUAL assembled seconds and returns `clipDurations`; the core (single-film
  AND scatter paths) compares each clip against its planned seconds and fails the render LOUD when a
  clip lands below the floor (`FILM_CLIP_DURATION_FLOOR` [vars] knob, default 0.5, clamped [0,1],
  "0" disables) -- a 0.085s clip for a 4s speaking shot can no longer ship as a green film. The gate
  fires on evidence only: an older container reporting no durations logs and no-ops, never a false
  failure. Root cause of the truncation itself (an outlived/retried encode race adopting a partial
  write, the #600 family) is class-proven; the exact site needs satellite job correlation and the
  gate closes the class regardless. NOTE: arms in prod once the media-stack video-finish image rolls.
- Caption cues timed to the ACTUAL cut (#698, PR #700): burn + .srt cue timelines now build from
  the probed per-clip durations (bundle plan only fills unreported shots), so cues track the real
  film on every tier instead of drifting past EOF on standard/draft.
- A started film never 500s (#695, PR #699): post-start bookkeeping (history-row insert,
  download-url presign) is best-effort after `startFilmJob` returns -- a transient D1 timeout logs
  `render.bookkeeping_deferred` and the 201 ships, instead of baiting a retry-on-5xx client into a
  second film. Poll insert-if-missing heals the row. Same window closed in `hSubmitRender` and
  `hRenderFromKeyframes`; polls stay throwing (idempotent).
- Config maps 400 at the door (#696, PR #699): every render/film config map
  (`keyframe_config`/`motion_config` top-level; `finish_config`/`speech_config`/
  `film_finish_config`/`master_config` top-level AND per-module entry, plus `renderOverrides` and
  its per-module config entries) bounces `badRequest` naming the offending (dotted) field when
  present but not a plain JSON object -- a mis-encoded map can no longer clamp to defaults and
  silently degrade a film that completes "done".

Files: package.json, CHANGELOG.md, src/index.ts, src/env.ts, src/film-model.ts,
src/film-orchestrator.ts, src/scatter-orchestrator.ts, src/scatter-orchestrator-types.ts,
containers/video-finish/app.py, containers/video-finish/README.md, docs/observability.md,
wrangler.toml.example, tests/render-submit-honesty.test.ts, tests/duration-honesty.test.ts,
tests/film-orchestrator.test.ts.

## v0.19.4

**The demo-studio first-impression train, folded into a tag, plus two honest-surface fixes.** PATCH
(demo-gated or prod-inert changes; prod runtime behavior is unchanged except where noted).

- Demo studio (all demo-gated, live at demo.vivijure.com since 2026-07-11): real cast portraits
  from the showcase asset host (#688), honest capability catalogs -- a demo serves empty
  planning-model + voice lists instead of advertising backends it cannot invoke (#689), the
  visitor steer panel -- render-a-free-clip scene menu, capped OSS assistant, honest
  queue/cap/paused copy, demo root lands on the planner (#690), and a control-free
  finished-films gallery (#691). Favicons shipped for every studio page (#679).
- Studio MCP: `submit_film` now exposes `speech_config`, `film_finish_config`, and `master_config`
  and forwards them verbatim, so subtitle mode (`burn`/`sidecar`/`both`) and the master-chain knobs
  are reachable from an agent; previously they were silently unreachable via MCP (#674, PR #693).
- `/api/artifact/*` on a deploy with no render bucket bound (the demo) serves an honest 404 with
  steer language instead of throwing a 500 (#646, PR #692). Deploys with the binding are
  byte-identical.

Files: package.json, CHANGELOG.md (release commit; feature files landed in PRs #688-#693)

## v0.19.3

**The installer actually works: nine live-proving findings fixed.** PATCH (deploy tooling only; no
runtime behavior change). The S29 proving pass ran `deploy/vivijure_deploy.py` end-to-end on live
accounts for the first time (free -> teardown -> paid -> teardown) and filed a findings ledger; this
release fixes all of it (PRs #683, #685):

- RunPod provisioning correctness: templates are SERVERLESS (#677 -- endpoint create could never
  succeed before), each satellite endpoint runs its OWN image via a per-endpoint manifest + tag knobs
  and audio-upscale is a first-class endpoint (#678), and the pre-bake network volume is GONE (#676 --
  baked images ship weights in-layer; no more DATACENTER_ID, no DC-pinned workers, no ~$7/mo/endpoint
  dead storage).
- State honesty: every successful create persists to state IMMEDIATELY, and a create that errors
  after server-side success (RunPod's intermittent 500 flake) is recovered by re-list instead of
  orphaning the resource and footgunning the next run (#675). State is bound to the Cloudflare
  account that created it -- a second-account run dies loud instead of silently reusing ids (#684).
- Secret map: the store seed list is the UNION of every secret_name the workers actually bind
  (unit-asserted against the tomls); per-satellite endpoint ids seed under their real names, and
  operator-supplied secrets seed as marked placeholders with a post-install checklist (#658 -- the
  old seed set left the core + satellites failing 10182 at deploy).
- R2 mint-lost heal: a run that died between the R2 token mint and the seed no longer perma-fails
  every later deploy; the installer revokes the stale token and re-mints (#680), tolerating tokens
  already revoked out-of-band.
- `down` is idempotent (#682): state entries clear as resources delete, delete-on-missing is
  already-gone (RunPod 404 OR 500), worker-delete WARNs are gated on API reality (no more 27 false
  "delete failed" on a clean teardown), and the documented `--delete-data` re-run works.
- `--noninteractive` writes the operator token to a 0600 file beside the state file instead of
  printing it into CI logs (#681).

Files: deploy/vivijure_deploy.py, deploy/README.md, deploy/test_runpod_provision.py,
deploy/test_secret_map.py, deploy/test_adopt_provenance.py, package.json, CHANGELOG.md

## v0.19.2

**Two follow-up fixes: the renders-list default limit + a soft `.srt` download affordance.** PATCH.

- **`GET /api/storyboard/renders` default limit was unreachable for an absent `?limit` (#670).** The route
  coerced `Number(url.searchParams.get("limit"))` FIRST; an absent param is `null` and `Number(null)` is
  `0` (finite), so the `Number.isFinite` guard passed and `limit=0` flowed through, making the intended
  default dead code for the absent case -- `listRendersForUser` then clamped 0 up to 1, so a headless /
  API / MCP consumer calling without a limit silently got ONE render row and could conclude there was one
  render (the frontend always sends `limit=25`, so zero UI impact). Fix: resolve an absent/empty param to
  the default BEFORE coercing (a garbage string still falls back to the default), and align the two
  mismatched defaults (route 100, function signature 50) on one exported `DEFAULT_RENDERS_LIMIT` (50) so
  they cannot drift again.
- **Soft `.srt` subtitle sidecar surfaced as a download in render history (#669).** After #663 the core
  re-times the subtitle sidecar for the title-card prepend, but it was reachable only by R2 key
  convention. `filmJobToPollView` now carries `film_finish.sidecar_key` on the done output ONLY when a
  sidecar was produced, so it persists on the render row and the history list returns it (absent stays
  absent -- no null noise on legacy rows); the frontend projects it into the action row as a
  "subtitles (.srt)" download next to the film download (registry-projection, no extra fetch). The
  poll-view output shape in `docs/CONTRACT.md` documents `sidecar_key`.

## v0.19.1

**Fix sprint: four adoption / delivery correctness fixes across the render + deploy paths.** PATCH.

- **R2 adoption guarded by object freshness -- reusing a project name can no longer ship stale content
  (#661).** Keyframe/clip adoption matched candidates by (project prefix, shot_id) name only, so reusing
  a project name (the planner always emits `shot_01..NN`) let a prior render's leftover keyframes/clips at
  the identical paths look like a complete set: the pending-poll fast path adopted the stale set on tick
  one, cancelled the live producer (#327), and the film completed silently with wrong content (the
  #245/#249 silent-wrong-delivery class; prod repro film-f7453b84). Adoption candidates are now filtered
  by R2 object age -- any object uploaded before the job's `created_at` is skipped -- in the shared listers
  (`listProjectKeyframes`, `listClipsByShotId`), so every caller (keyframe fast path, stall backstop,
  ceiling path, `listProjectClips`, clip reclaim) inherits it. This-run orphans always upload after the
  job starts, so all legitimate recovery semantics survive.
- **Adopted finish-shot ledger reconciled 1:1 to its chain (#662).** Audit verdict: a bookkeeping
  channel-split, not a skip. A shot counted in `finish.adopted` showed `applied[]` missing exactly the one
  chain-module tag that was ADOPTED (RIFE for a no-dialogue chain, LIPSYNC for a dialogue chain) -- the
  step's RunPod job was GC'd or froze after writing its output, so a later tick recovered it via the #583
  hash-gated adopt path (the transform genuinely ran and is present in the delivered clip; a dialogue shot
  is NOT unsynced). The tag was correctly routed to the `adopted` channel, so reading `applied[]` in
  isolation under-reported by one. Adds a per-step honesty ledger (`FinishShot.ledger`) that reconciles
  1:1 to the chain (a reused step is PRESENT, `reused:true`, never dropped) and logs loud if a done shot
  fails to reconcile, keeping the disjoint applied/adopted channels intact. No silent wrong delivery.
- **Subtitle `.srt` sidecar re-timed for the title-card prepend (#663).** The subtitle module (film.finish
  `ui.order` 5) writes its soft `.srt` sidecar against the pre-card, 0-based assembled film; film-titles
  (`ui.order` 10) then prepends a title card, so every sidecar cue ran early against the final film (the
  burned captions were correct -- they ride the video through the prepend). film-titles now reports the
  prepend as `prepend_seconds` (OPTIONAL + additive on `FilmFinishOutput`, no `MODULE_API` bump; the
  subtitle module is unchanged); after the chain completes the core reads the raw per-step sidecar, shifts
  every cue by that offset, and writes the final `.srt` next to the final film, surfaced on the summary as
  `film_finish.sidecar_key` (previously discoverable only by key convention). The offset is persisted per
  step so it survives cross-tick adoption of the prepending step. The film-titles module needs this tag's
  redeploy to emit `prepend_seconds`.
- **`deploy.py` records adopt provenance and skips adopted resources on `down` (#659).** State entries
  from `up --adopt` carry `adopted: true` (legacy plain-string entries stay treated as created); `down`
  skips adopted CF/RunPod resources by default, with `--include-adopted` to force deletion with a warning.

## v0.19.0

**film.finish survives a single step over budget: async job+poll for the video-finish container
(#602).** MINOR. v0.15.x's #600 made a film.finish CHAIN survivable (per-step deterministic keys +
R2-presence adoption across ticks), but a SINGLE step whose encode alone exceeds one request budget
re-dispatched forever: a synchronous module has no poll token, and its output key never appears
because the encode dies with the request. Three layers, no contract bump: the video-finish container
gains an async mode (`POST /async/{route}` -> 202 + jobId, background ffmpeg, PUT on completion;
`GET /async/status/{jobId}`) with the sync routes unchanged; the film-titles + subtitle modules
(v0.2.0) go async-first, returning the existing generic `{pending, poll}` variant and FALLING BACK to
the sync route on a pre-#602 container; the core's `runFilmFinish` becomes a true submit+poll-per-tick
phase on persisted tokens (`film_finish_polls`/`_attempts`), handling both shapes, threaded through
single-film AND scatter. R2 presence stays authoritative on completion and the #190 fail-safe holds:
a genuinely failed step retries bounded then soft-degrades RECORDED (ships uncarded, never silently,
never failing the render). Core deploys safely ahead of the container: the sync fallback carries prod
until the media stack rolls the new image (#634).

Also in this release (shipped on main since v0.18.1, deploys with this tag):
- **Demo studio Phase A foundation (#625):** `AUTH_MODE=demo` read-only gate (GET/HEAD open to
  everyone, every mutation 403, no credential honored) + `host.readonly` registry projection (#628);
  the frontend read-only gate as a pure projection of that one flag (#629); the registry's ONE
  deliberate demo-mode exception reading seeded `installed_modules` without a dispatch namespace,
  display-only by construction (#630). No effect on any non-demo deploy (pinned by tests).

## v0.18.1

**advanceToClips loud-degrades a partial keyframe set, no silent half-film (#622).** PATCH. The
normal-completion sibling of the v0.17.5 (#619) stall fix. `advanceToClips` failed the film ONLY when
a keyframe module matched none of the requested shots; a PARTIAL set (some matched, some missing)
advanced to clips built from the matched shots alone, silently rebasing every downstream counter to
the smaller total so the film reported a clean `complete` over a half-set -- reachable whenever a
keyframe module honestly returns fewer keyframes than scenes (e.g. a per-shot content refusal). A
partial set is not a schema violation (a module can legitimately complete short), so the fix mirrors
the #619 keyframe-ceiling contract: it now delivers the scenes that rendered but LOUDLY, recording the
drop on the existing `keyframes_incomplete` field ({adopted, expected, dropped}), emitting the
`film.keyframes_incomplete` structured event, and surfacing the degrade on `summarizeFilm` + the poll
view, so the film never reports a clean complete over the rebased total. The all-missing case still
hard-fails loud; the record is guarded so the ceiling-recovery path never double-records. Scope:
only the module-completion path (`advanceToClips`); `startFilmFromKeyframes` (a caller-supplied
keyframe subset = explicit intent) is unchanged. Ships via tag deploy.

## v0.18.0

**Welcome/marketing page moves off the Worker to vivijure.com (#617).** MINOR. The public marketing
landing page (`public/welcome.html`) no longer ships inside the Worker bundle: it used to deploy with
every self-hosted studio, dragging our marketing surface, the Umami analytics inject, and the
`/welcome` CSP special-casing along with it. The storefront now lives solely at `https://vivijure.com/`
(already the richer, canonical marketing site), and `/welcome` (+ `/welcome/`, `/welcome.html`) on the
studio host is now a clean **301 redirect** there for link equity. Removed from the Worker:
`welcome.html`, the `welcomeCsp` / `injectWelcomeUmami` / `WELCOME_PATHS` machinery, and the
`UMAMI_WEBSITE_ID` env, across `src/asset-response.ts`, `src/env.ts`, `wrangler.toml.example`,
`deploy.sh`, CI, and `.dev-modbound`. The response-security chokepoint now streams every body
unchanged (the per-request welcome rewrite was its only body-mutating path). Docs updated (SECURITY,
PRIVACY, legal, deploy-config). Two operational notes: the `/welcome` public Access bypass MUST stay
so the 301 resolves for anonymous visitors, and the post-deploy edge purge still flushes the stale
page on the cutover deploy. Ship via tag deploy to make the redirect live.

## v0.17.5

**Keyframe stall recovery: no more silent half-films (#619).** PATCH. A stale keyframe poll with
only a PARTIAL keyframe set in R2 no longer cancels the still-running keyframe job and advances
with the subset (which shipped a film missing scenes while reporting `complete: true`). The
recovery now mirrors the clips recovery (#143): a partial set below the phase ceiling HOLDS (no
cancel, re-fires each stalled sweep as late keyframes land), a full set advances as before, and
the ceiling delivers what rendered LOUDLY -- new `keyframes_incomplete` job field
({adopted, expected, dropped}), a `film.keyframes_incomplete` structured event, and the degrade
surfaced on every poll view. Found by the S26 exercise render (film-8b47feb1 delivered 2 of 4
scenes as a clean green). PR #620.

## v0.17.4

**Welcome page SEO: canonical storefront defers to vivijure.com (#604).** PATCH. `/welcome` now
declares `rel=canonical` and `og:url` at `https://vivijure.com/`, uses the branded
`vivijure.com/og-image.png` for OG/Twitter cards, adds `twitter:site` / `twitter:creator`
(`@skyphusion`), reciprocal `rel=me` identity links, and footer cross-links to the Skyphusion
property mesh. Static HTML only; no Worker logic or schema changes. Ship via tag deploy to refresh
the bundled assets and run the post-deploy `/welcome` edge purge.

## v0.17.3

**film.finish survives films bigger than one invocation budget (#600).** PATCH. The second S25
exercise find: a 1440p48 film's title/caption passes (~8 min CPU each) exceed any single
invocation budget, and the chain minted a RANDOM output key per attempt -- so the every-minute
cron re-encoded the subtitle pass forever (the #122 presence self-heal could never find a prior
success) and film-374268a2 wedged in assemble. Now each film.finish step writes a DETERMINISTIC
key (`<film>-ff<n>.mp4`) and is HEAD-adopted from R2 on re-entry (adoption recorded in the honest
`adopted` channel, #583 discipline); a persisted per-step dispatch marker (in-flight window
1200s) prevents duplicate encodes while one is still running, since the advance-lease TTL (300s)
expires mid-encode and the claim fails open; a step's `curKey` follows the MODULE's reported
film_key, so a noop (subtitle with no dialogue) threads the real film forward instead of a
never-written key. The chain finalizes only on `complete`; an in-flight stop resumes on the next
tick. Fixes the single-film AND scatter paths; the wedged film self-heals on deploy with no
intervention. Follow-up #602: async job+poll for a single step that alone exceeds the budget
(bounded today by the 90-min phase deadline).

## v0.17.2

**The upscale default reverts to animevideov3; x4plus is opt-in until the handler tiles.** PATCH.
The first S25 exercise render (film-01bfda9c) failed honestly: every shot CUDA-OOM at
MODULE_UPSCALE ("tried to allocate 45.7 GiB"), because the v0.17.0 default flip to
RealESRGAN_x4plus (a natively-4x model the container runs untiled) cannot fit a 48fps rife'd 720p
clip's 4x output on even a 96GB GPU. The default follows the handler's proven memory envelope
(finish-upscale 0.1.3); the photoreal-texture goal of #585 stands and the default re-flips after
vivijure-upscale ships tiled x4plus inference (v0.2.9) and it proves out on a real render.
Validation win worth recording: the failure surfaced END TO END with the real per-shot error (the
#245/#249 honest-failure doctrine), and the dialogue shots demonstrably ran lipsync BEFORE
interpolation (#584's order live in prod) before dying at the innocent-bystander upscale step.

## v0.17.1

**The #583 adoption gate flips: an R2 finish artifact is reused ONLY on a matching provenance
sidecar.** PATCH (the final step of the #583 fix; the write-side shipped in v0.17.0). Both adoption
paths (`adoptFinishStepFromR2` and the reclaim scan) now require the artifact's `<outputKey>.hash`
sidecar to equal the core-computed `finishStepInputHash` for the CURRENT inputs; a missing sidecar
(legacy artifact) or a mismatch (different clip / audio / config -- including a prior film's
abandoned artifact at the shared key, the original #583 race) re-runs the step instead of adopting
stale output. Same-job #141/#166 recovery still adopts (inputs unchanged -> hash matches). Deployed
in order: stamped producers first (musetalk :0.1.4, upscale :0.2.8, backend :0.4.8, all
fresh-worker-verified in prod), core write-side (v0.17.0), then this gate. #583 closed.

## v0.17.0

**Finish provenance write-side ships, and the last two S23 showcase finds are fixed.** MINOR (the
module contract gains an additive field, and the #583 provenance machinery is new surface).

- **Core-computed provenance hash + producer-stamped sidecar (#583, steps 2-3).** The core computes
  `finishStepInputHash(clipEtag, audioEtag, config)` at invoke time (ONE exported symbol, golden-
  vectored in CONTRACT.md 3.3.1) and passes the opaque value as `FinishInput.output_hash`; the
  producer containers (musetalk :0.1.4, upscale :0.2.8, backend :0.4.8) write it verbatim to the
  `<outputKey>.hash` sidecar, artifact FIRST, sidecar LAST. Write-side only: the adoption GATE
  (require a matching sidecar before reusing an R2 artifact) flips in the next release, after the
  stamped producers are verified in prod (correctness order: producers first, then the gate).
- **Dialogue shots lip-sync the native-fps clip (#584).** A finish module may declare the additive
  manifest field `finish_consumes_audio` (lip-sync does, 0.1.4); for a shot WITH a dialogue line the
  core stable-partitions the finish chain so audio-consuming modules run FIRST -- lipsync -> rife ->
  upscale -- because a lip-sync model's audio->mouth mapping is calibrated to the source frame rate
  and smears across interpolated frames (the breathy look). Non-dialogue shots keep plain ui.order.
  The companion container fix (vivijure-musetalk#32) stops the audio mux from silently re-encoding
  the CRF-18 video at ~2 Mbps (`-c:v copy`). Both #584 mechanisms are dead.
- **Photoreal upscale default (#585, first lever).** finish-upscale (0.1.2) defaults to
  RealESRGAN_x4plus; the anime-tuned realesr-animevideov3 (which imposed an illustration-ish texture
  on photoreal shots, visible at cuts) becomes the explicit anime opt-in. Deeper cross-shot style
  locking is filed as #594.

## v0.16.5

**The S24 sweep burn: every open S23 showcase find fixed in core.** PATCH. Four fixes:

- **Bad clip config bounces BEFORE keyframe spend (#577).** The seedance manifest advertised
  `resolution: 1080p` while the provider accepts only 480p/720p, so a schema-legal value passed the
  clamp and failed every shot after ~17 min of final-tier keyframes. The enum now builds from a
  provider-accepted single source of truth (seedance 0.2.2, pinned by a manifest test), and all
  three keyframe-burning submit doors (film / storyboard render / scatter) judge the RAW caller
  motion_config strictly against the module schema -- unknown key, out-of-set enum, out-of-range
  number, wrong type -- and 400 naming what IS allowed, before any GPU dispatch.
- **Preflight accepts the cast id the API actually gave you (#576).** `castBindings` values resolve
  from the public UUID, the numeric row id, or a numeric string; unresolved values get errors that
  distinguish unknown-id from wrong-id-kind (the misleading "which no longer exists" is gone).
- **Cast voices reach explicit dialogue_lines (#582).** A line without a `voice_id` now resolves
  shot -> speaking slot (bundle storyboard) -> cast voice (cast_loras); an explicit voice_id always
  wins; the default applies only when nothing maps. `cast_loras` joined the MCP submit_film schema,
  and the voicing precedence is documented once (CONTRACT.md 2.20 + docs/mcp.md).
- **The finish record stops claiming adopted work ran (#583, step 1 of the fix).** A finish step
  reused from a prior same-project render's R2 artifact is now recorded in a new `adopted` channel,
  never as a fake `applied`-run tag; the poll summary exposes an `adopted` count. CONTRACT.md 3.3.1
  specifies the producer-written `<outputKey>.hash` param-hash sidecar contract (backend #112
  template) that the satellites/backend implement next; the core adoption gate flips only after
  those producers ship (correctness order: producers first, then the gate).

## v0.16.4

**Keyframe adoption stops feeding the motion backend a hash file (#578), and the MCP escape hatch
works from real clients (#575).** PATCH. Both found live in the S23 showcase component sweep.
The backend's `.hash` param-hash sidecars (backend #112) sort before `.png` in R2, so every ADOPTED
keyframe set (recovery / same-project reuse) handed the motion backend the 16-byte sidecar as its
start image and the whole film failed with a provider image-parse error; `listProjectKeyframes` now
filters to image extensions before shot-id extraction. `studio_request`'s untyped `body` param made
schema-validating MCP clients send a JSON-quoted string (every body-carrying escape-hatch call
400'd); the param is now typed `[object, string]` and a string body is unwrapped before forwarding.
Also this sweep, docs/mcp.md was rewritten to the house docs standard (#570) and the seedance
schema-vs-provider 1080p mismatch was filed (#577, open).

## v0.16.3

**The lipsync degrade reason survives the new backend envelope (#569), and tag deploys stop
tripping on their own guard (#568).** PATCH. musetalk v0.1.2/v0.1.3 (satellite #24: the full
faceless taxonomy -- import-path regression, false-positive bboxes, zero-detection crashes) returns
soft-degrades as `{ok:false, detail}`; finish-lipsync (0.1.3) now records that detail, with `error`
kept as the legacy fallback. CI placeholder guards are comment-aware and use fixed-string grep (the
regex form silently matched nothing on GNU grep).

## v0.16.2

**Voiced films on faceless shots stop hard-failing at lip-sync (#565).** PATCH. RunPod lifts the
musetalk handler's soft-degrade return ({ok:false, error}) into a job-level FAILED envelope, so the
finish-lipsync passthrough branch was unreachable: a legitimate no-face shot failed the whole film
after full keyframe + i2v spend. The module now recognizes the handler's structured ok:false inside
a FAILED envelope (a genuine crash leaves none) and passes the original clip through, recorded as
passthrough:backend-soft-degrade per #77; a real crash still fails loud. Module 0.1.2; first
dedicated finish-lipsync test file. Satellite envelope + early no-face exit tracked in
vivijure-musetalk#24.

## v0.16.1

**The Studio MCP driver ships, and API dialogue actually reaches the film (#563).** PATCH
(retro-added entry; tagged 2026-07-06). `src/mcp.ts` exposes the studio as MCP tools
(projects / cast / storyboard / bundle / preflight / submit + poll film). startFilmJob now remaps
`dialogue_lines` shot ids through the same positional coercion as the scenes (#564), so an API
caller with its own id scheme (s1/s2: Slate, the Studio MCP) no longer ships a silent, uncaptioned
film after paying for TTS.

## v0.16.0

**The studio stops trusting its clips: output validation lands at both layers (#523).** MINOR.
A render engine that returns a structurally broken file, or a "valid" mp4 full of pure noise, is
now caught at the gate instead of being polished and shipped. Layer 1 rejects broken files at
motion-clip intake; Layer 2 rejects garbage pixels at the film finish boundary; both fail the shot
BEFORE any finish/upscale GPU spend, with the real error on the shot. Plus the S20 planner/provision
fix batch.

- **Layer 1: structural mp4 validation at motion-clip intake (#556, #523).** Every adopted clip's
  mp4 box tree is parsed in-Worker from bounded R2 ranged reads (no full download): ftyp/moov
  present, duration/dimension sanity, minimum size. A structurally broken clip fails its shot at
  intake with a `clip.validate` structured event; the fail is sticky (R2 reclaim never re-adopts a
  known-bad clip). Engine-agnostic: applies to own-gpu, cloud i2v, and local-door clips alike.
- **Layer 2: pixel-content validation at the film finish boundary (#558, #557, #523).** The
  video-finish container grows `POST /inspect`: keyframe-vs-first-frame similarity is the primary
  corrupt signal (a noise clip scores ~0.0 against its own keyframe), chroma/structure ratio is the
  warn-only fallback (empirically tuned on real fixtures: noise 5.6-5.7 vs good <= 2.5, threshold
  4.0). Verdicts: `corrupt` fails the shot pre-spend, `suspect` completes the film flagged
  `content_degraded`, an unreachable/older container degrades to `skip` -- content validation never
  hard-fails a render by being absent. Emits `clip.content_validate` structured events.
- **video-finish image fix (#559).** The #558 image build omitted `inspect_core.py` from the
  Dockerfile COPY list (crash-loop on import at container start); one-line fix. Ships as
  `vj-video-finish` 0.2.1; the 0.2.0 image tag is known-broken, never deploy it.
- **Provisioning hardening (#551, #553, #555).** `runpod-provision.py` pins the backend image tag
  by default and rejects bare `:latest`; finish satellites provision with their correct per-service
  R2 env; the upscale satellite pins to its first current-main release `vivijure-upscale:0.2.7`.
- **Planner fixes (#550, #554).** Numeric override fields get bounds hints and the render button
  gates on out-of-bounds values (#544 / #546); the pre-jobId window can no longer re-enable the
  render button mid-submit and double-fire a film (#552).
- **Deploy fixes (#541, #549).** `INSTALL_LOCAL_GPU=1` seeds the local-gpu door secrets so a fresh
  install stops failing with code 10182; deploy.sh surfaces the real planner-mint failure reason
  and validates a reused token before reporting ARMED.
- **Misc (#542, #547).** compose.yaml drops explicit `container_name` so two projects can coexist
  (#533); alibaba-wan-lora pins its seed `config_schema` floor at `min: -1`.
- **Docs (#543, #548).** The free-plan hedge flips to the proven S18 verdict (install free, render
  free, Workers Paid only for the 3 GPU satellites) plus the local-GPU door move recipe; R2 token
  scoping on a first install documented (bucket does not exist yet).

## v0.15.0

**The media stack becomes part of the standard install, and the whole studio is proven live on a
$0 Cloudflare account.** MINOR. The S18 payload: the finish/media containers stop being an optional
tier (the pre-local-door privacy rationale is gone), deploy.sh automates the entire tunnel + VPC
leg, a film that loses its finish container still delivers clips, and the free-plan gate PASSED on
a fresh free-plan account -- full standard install E2E and all THREE render routes (own-gpu
serverless, cloud i2v, local-gpu door) shipped assembled 1080p24 films. The #521 verdict: install
free, render free (pay only usage), Workers Paid ($5/mo) buys ONLY the 3-GPU-satellite suite; a
plan flip needs a core redeploy.

- **Media stack promoted to the standard install; tunnel + VPC fully automated (#519 / #520 /
  #513, #527).** The 5 CPU media containers + cloudflared tunnel + 5 Workers VPC services are now
  part of the default `deploy.sh` run: profiles collapse to `standard` / `satellites`
  (`minimal` / `full` become warn-aliases), `INSTALL_LOCAL_GPU=1` is the separate local-door
  opt-in, and the new `scripts/setup-media-vpc.py` creates/adopts the tunnel, creates the VPC
  services, injects the service ids, and emits a `0600` `tunnel.env`. Only the 3 GPU satellites
  (upscale / lipsync / speech-upscale) remain optional.
- **Degrade to completed-with-clips when video-finish is unavailable (#519, #524).** If
  `VIDEO_FINISH_VPC` is unbound or unreachable after bounded retry at assemble, the film now
  COMPLETES with a loud `finish_unavailable` block (`delivered: "clips"` + presigned clip URLs)
  instead of hard-failing; at mux the degrade delivers a `silent_film`. You can close your laptop
  and still get your clips. A GENUINE container error still fails the render loud with the real
  per-shot error (the #245 / #249 honest-failure guards are untouched).
- **Free-plan subrequest scoping (#521 / #535, #526 + #538).** Root cause of the free-tier
  `Too many subrequests` failures was scan-count, not module-count (a trimmed 18-module install
  still failed): the film tick discovered the registry per interested-module scan, and the
  keyframe->clips transition tick ran TWO full discovery fan-outs (46/50 subrequests before any
  work). Discovery now runs once per film tick (#526) and is threaded request-scoped through the
  clip-job path (#538). Post-fix, all three render routes complete on the free plan's 50-subrequest
  cap.
- **Zombie GPU-job cancel (#536, #538).** The clip orchestrator persists the backend job id per
  shot and best-effort-cancels it on shot failure / job teardown, gated so it fires once; R2
  reclaim runs FIRST, so a clip that already landed is adopted, never cancelled. Kills the class
  where the studio gives up but an H200 keeps burning.
- **Media tunnel adoption + named token scopes (#528 / #531, #532).** `setup-media-vpc.py` now
  adopts an existing `vivijure-media` tunnel instead of creating a split-brain second one, and
  hard-stops if it detects a split (services pointing at a tunnel it did not adopt). Deploy-time
  scope errors now name the exact missing token scope (e.g. `Cloudflare Tunnel:Edit`,
  `Connectivity Directory:Admin`) instead of a bare CF `10000`.
- **Serverless provisioning defaults to datacenter GPUs (#517, #530).** `runpod-provision.py`
  defaults new endpoints to the H200 / B200 pool (the baked-image sm target), not the consumer
  pool a fresh account would otherwise land on.
- **Docs swept to the standard/satellites shape (#529)**; quickstart, DEPLOYMENT, opt-in-tiers,
  CONTRACT and the runbook all describe the post-#519 install (Joan). **Node diagnostic reports
  gitignored (#525)** after a near-miss: a `--report-on-fatalerror` OOM dump (full env, creds
  included) landed in a working tree and was caught by push protection; `report.[0-9]*.json` can
  never be committed again.

## v0.14.3

**S16 backlog burn-down: retire two dead modules, harden the tag deploy, finish the Secrets Store
migration.** PATCH. No new feature surface; three footgun/parity fixes ahead of announce.

- **Retire openai-sora + alibaba-wan25; deploy `EXCLUDE` empty (#306 / #509).** Both were never
  core-bound and never live: openai-sora's un-exclude was gated on the parked Sora build (#184) and still
  carried an unresolved CF `workers.dev/subdomain` first-deploy blocker; alibaba-wan25 was a redundant
  OLDER sibling (Wan 2.5) of the shipped alibaba-wan (Wan 2.6). Deleted both module dirs + their tests,
  swept the two names from 7 sibling `motion.backend` READMEs + the deploy-runbook, and cleared the
  retired plan-enhance-py (#469) leftovers. The CI `EXCLUDE` list goes to empty (the skip-list MECHANISM
  is kept for the next not-ready module). The code is recoverable from git history if #184 revives Sora.
- **Bounded transient-retry in the module-deploy loop (#492 / #510).** The tag-deploy "Deploy module
  workers" step ran `wrangler deploy` per module with no retry, so a single transient Cloudflare API
  hiccup (e.g. the Workflows trigger registration that failed the v0.13.0 deploy) aborted the whole
  ordered deploy under `set -eu`, skipping the core render, D1 migrations, core deploy, and the
  post-deploy gate. Ported deploy.sh's pattern: an `until` retry, up to 3 attempts with a 3s backoff; a
  persistent (non-transient) failure still fails the step loud after the attempts are exhausted. POSIX sh
  / BusyBox ash, now at parity with deploy.sh.
- **speech-upscale bound from the Secrets Store (#238 / #511).** The last secret-bearing module still on
  imperative `wrangler secret put`. Because it deploys via the CI glob loop but CI never runs
  `wrangler secret put`, a CI/fresh deploy shipped it credless -> silent `no-runpod-secrets` passthrough
  (the v0.2.2 finish-upscale class #237 exists to kill). It now binds `RUNPOD_API_KEY` (shared) +
  `RUNPOD_ENDPOINT_ID` (store secret `AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID`, the vivijure-audio-upscale
  endpoint) from the account Secrets Store via the string-tolerant `secretValue()` resolver; deploy.sh +
  docs updated. This finishes the #238 migration (the core worker and every other secret-bearing module
  were already done).

## v0.14.2

**Every full-render submit path now bounces an unresolved motion backend at the door.** PATCH. Extends
the v0.14.1 / #500 novice-first hardening (a full render with no resolvable motion backend rejects at
submit, not deep at assemble with `no clips rendered to assemble`) to the remaining submit paths, and
closes the planner's default-pick hole.

- **Core preflight on the last two submit paths (#504).** The reusable `motionBackendPreflightError`
  (`src/modules/registry.ts`) is now wired into `hStartFilm` (`POST /api/render/film`) and
  `hScatterRender` (`POST /api/storyboard/render/scatter`), resolving the EXPLICIT `motion_backend` (the
  top-level field or `render_overrides.motion_backend`, NEVER the `serving[0]`/door default) exactly as
  `hSubmitRender` does. Neither endpoint has a keyframes-only mode, so the check is unconditional; both
  reject with a 400 listing the serving `motion.backend` names before any keyframe/shard GPU work. With
  Slate now always sending an explicit backend (slate v0.2.1, `skyphusion-labs/slate#58`), every
  full-render submit path is covered and the `serving[0]`/door default is unreachable for a full render.
- **Planner no-default-force-pick (#501).** With 2+ serving `motion.backend` modules the planner used to
  preselect the order-first door (locality-blind), so a novice clicking straight to submit sent a
  possibly-non-operational door EXPLICITLY -- passing the new submit preflight, then failing downstream.
  Every door radio now starts unchecked and submit blocks with a novice cue, `pick a render backend
  before rendering (Label A, Label B)`, until a door is chosen (or `motion_backend` is supplied via the
  expert JSON). Single-backend and zero-backend cases are unchanged, and a keyframes-only preview is
  exempt (no motion leg). Stays a projection of the registry; no module manifest touched. (Authored by
  Joan, #506.)

## v0.14.1

**Novice-first: a full render with no resolvable motion backend bounces at the door, not deep at assemble.**
PATCH. A full (non-`keyframesOnly`) film render whose effective `motion_backend` did not resolve to an
installed, serving `motion.backend` module used to burn the keyframe phase and then fail with the opaque
`no clips rendered to assemble` (an assemble-leg symptom of a submit-leg cause). It now rejects with a
400 at submit, naming the problem and listing the installed backends, before any keyframe GPU work.

- **Core submit preflight (#500 / #503).** `hSubmitRender` resolves the EXPLICIT `motion_backend` (the
  top-level field or `render_overrides.motion_backend`, NEVER the `serving[0]` default) and returns 400
  with the serving `motion.backend` module names when it does not resolve; `keyframesOnly` renders are
  unaffected (they have no motion leg). New reusable `motionBackendPreflightError(modules, choice)`
  helper (`src/modules/registry.ts`). Root cause confirmed against the live registry: an omitted backend
  defaulted (via `pickOneForHook`) to `serving[0]` = the `local-gpu` door (`ui.order` 4), not
  `alibaba-wan` (order 70), and the door has no seeded backend URL server-side, so the motion phase
  produced zero clips.
- **Planner caller side (#502).** The planner now ALWAYS sends an explicit `motion_backend` when at
  least one serving backend is installed; it previously OMITTED it in the single-backend case (relying
  on the core `serving[0]` default), which the new preflight would have rejected. The pre-existing
  render surface already renders the 400 `{error}` string verbatim, so the novice sees the full backend
  list when a pick is genuinely needed.
- **Follow-ups noted (next-sprint triage, not in this release):** planner default motion-backend pick
  (#501); extend the same preflight to `hStartFilm` + `hScatterRender` once Slate sends an explicit
  backend (#504); the Slate caller-side fix (`skyphusion-labs/slate#58`).

## v0.14.0

**The local-consumer door goes live in production.** The `local-gpu` module (the 12GB LTX "local"
door) is now deployed and bound into the core registry, so the studio routes renders to a
self-hosted GPU backend. MINOR: a new module binds into prod.

- **`local-gpu` deployed + core-bound (#383 / #384).** Flip 1 (#383) dropped `local-gpu` from the CI
  deploy `EXCLUDE` so `vivijure-module-local-gpu` ships on this tag; flip 2 (#384) added the core
  `[[services]]` `MODULE_LOCAL_GPU` binding so the registry discovers the door. The tag lane deploys
  modules BEFORE the core, so the module ships first and the core binds an existing service (no
  dangling-binding failure). The `local-gpu` door slice of #306 is now live.
- **Backend = a disposable RunPod SECURE pod behind a trycloudflare quick tunnel.**
  `LOCAL_BACKEND_URL` + `LOCAL_BACKEND_TOKEN` live in the Cloudflare Secrets Store (freshly seeded,
  verified live through the tunnel), so the module no longer `10182`s on an unseeded binding (the
  v0.7.6 failure). `LOCAL_BACKEND_URL` is re-seeded per pod, and the door FAILS LOUD when no pod is
  attached; it never silently degrades. The old "once the homelab box is up" condition is void (the
  door runs on a RunPod pod, not local hardware).
- **`deploy.sh` is store-first; the planner token is a fail-closed deploy prerequisite (#479 / #498).**
  The one-script self-host deploy now fills the core `store_id`, seeds every core store secret (incl.
  `R2_S3_*`) before the deploys that bind them, and resolves + seeds `CF_AIG_TOKEN` +
  `PLAN_ENHANCE_CF_AIG_TOKEN` up front. A `[[secrets_store_secrets]]` binding to an unseeded store
  secret hard-fails `wrangler deploy` (code `10182`), so the planner token can no longer be an
  "arm-later" step: if it is neither pasted nor auto-mintable the deploy stops early with the exact
  fix, before anything ships. Only `STUDIO_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` stay direct worker
  secrets.

## v0.13.2

**Re-includes `dialogue-gen` + `music-gen` in the module deploy loop now that the Cloudflare
Workflows write path has recovered.** The v0.13.1 re-cut held these two modules (the only ones that
bind a Cloudflare Workflow) on their live versions because `PUT /accounts/{id}/workflows/{name}` was
returning `10001 workflows.api.error.internal_server` (Cloudflare Durable Objects incident in ENAM,
CF support case 02220294, ongoing since 2026-07-02). Their workers stayed live/healthy throughout;
only re-registration on a new tag was blocked, so there was zero functional loss.

- **Cloudflare resolved the incident and closed case 02220294 (2026-07-03).** Verified
  evidence-grade against the live API, not the status email: a throwaway single-`[[workflows]]`
  probe worker deployed clean (the exact `PUT .../workflows/{name}` succeeded, no `10001`), then was
  deleted. The write path is genuinely back.
- **`dialogue-gen` + `music-gen` dropped from the CI `EXCLUDE` and the temp why-comment removed**
  (#493 / #495), mirroring the plan-enhance un-exclude (#476). This tag re-deploys both through the
  loop; no repo/code/config change to the modules themselves.

## v0.13.1

**Same S9 hardening payload as v0.13.0, re-cut so it actually reaches production. The v0.13.0 tag
deploy was blocked by an active Cloudflare Workflows API outage (`10001 internal_server` on the
Workflows write path, ongoing since 2026-07-02), which fails `wrangler deploy` when it re-registers
a module's Workflow trigger. No repo/code/config change; a Cloudflare-side incident.**

- **dialogue-gen + music-gen held on their live versions (temporary).** These are the only two
  modules that bind a Cloudflare Workflow. Both were UNCHANGED in S9 and their workers + workflows
  are already live and healthy, so holding them back re-deploys nothing functional -- the
  re-registration Cloudflare is rejecting is a no-op. They are excluded from the deploy loop until
  the Cloudflare Workflows write path recovers. Tracked in #493 (revert = drop both from the CI
  `EXCLUDE` and re-run the deploy once Cloudflare closes the incident).
- **Everything else in v0.13.0 ships:** the core worker, D1 migration `0010` (opaque `public_id`
  backfill), and the post-deploy gate self-check all deploy normally (the core binds no Workflow).

The full S9 changeset is unchanged from the v0.13.0 entry below (opaque ids F13, spend fail-closed
F7, deploy self-check W3, ALLOW_UNAUTHENTICATED loudness W4, single-user docs W5). v0.13.0 stays in
history as the Cloudflare-blocked attempt.

## v0.13.0

**S9 strict security hardening: the single-user studio becomes bulletproof-by-default without
Cloudflare Access. Externally-addressable ids are now unguessable, the spend limiter and the deploy
path fail CLOSED, and the docs lean into single-user. BEHAVIOR CHANGES (MINOR): a bare sequential
`:id` no longer resolves, and a broken spend limiter now denies instead of allowing.**

- **Opaque public ids on cast / projects / renders (F13, #487).** `storyboard_projects`,
  `cast_members` and `renders` now expose a UUID-class `public_id` (122 bits) as their ONLY external
  id; the internal INTEGER PK and every internal FK are unchanged. Every `:id` route resolves
  `public_id` -> row, so a bare enumerable integer (`/api/cast/export/1`) now 404s instead of walking
  the library. **Hard cut, no dual-accept window** (pre-announce, prod=dev). Migration `0010_public_ids`
  adds the column and backfills existing rows with a per-row v4 UUID in pure SQL (additive; applied by
  the deploy lane BEFORE the new worker goes live). New rows get `crypto.randomUUID()` on insert.
- **UI consumes the opaque ids (F13 / #489).** The planner frontend routes, fetches and any
  sort/lookup-by-id move off the numeric id onto `public_id`; vanilla JS, still projected from the
  registry.
- **Spend limiter fails CLOSED by default (F7, #488).** A broken or unbound rate/spend limiter now
  DENIES (503) instead of allowing; `SPEND_LIMIT_FAIL_CLOSED="false"` is the documented opt-out. A
  novice self-funding their own GPU has the money path fail closed like everything else.
- **Post-deploy gate self-check (W3, #485).** `deploy.sh` and the tag-deploy CI lane now curl the live
  worker with NO bearer on `/api/*` after deploy and REQUIRE 403; anything else fails LOUDLY (a 200 is
  flagged "your studio may be OPEN"). Automates the v0.12.0 live-matrix proof so an open studio cannot
  ship silently. Bounded ~60s retry absorbs edge-propagation lag; no new secrets.
- **Loud ALLOW_UNAUTHENTICATED signalling (W4, #486).** `deploy.sh` prints an unmissable banner when
  the auth opt-out is present in the rendered config or environment (honest that it is inert under a
  set `AUTH_MODE`), and the in-Worker allow branch emits a structured `{"ev":"auth.allow_unauthenticated"}`
  event so an accidentally-open deploy is queryable in the tail/Loki channel.
- **Honest single-user framing (W5, #490).** `SECURITY.md` stops apologizing for missing
  multi-tenancy and states the model plainly: one operator, one token set, all data is yours; a named
  token is a rotation handle, not an isolation boundary. Updated to match the landed F13/F7 hardening.

## v0.12.1

**The #238 Secrets Store migration completes on the core worker, the R2 S3 presign identifiers
become `[vars]`, and plan-enhance rejoins the deploy loop. Config + deploy only; no behavior change.**

- **Core Secrets Store migration deploys (#238 / #473).** The studio worker's `CF_AIG_TOKEN`,
  `GATEWAY_ID`, `RUNPOD_API_KEY`, `RUNPOD_ENDPOINT_ID` (store `secret_name` `BACKEND_RUNPOD_ENDPOINT_ID`),
  `R2_S3_ACCESS_KEY_ID` and `R2_S3_SECRET_ACCESS_KEY` move from `wrangler secret put` to declarative
  `[[secrets_store_secrets]]` bindings; the tag deploy replaces the stale `secret_text` in place.
  `STUDIO_API_TOKEN` stays an operator-minted worker secret. Values are seeded once in the crew
  Secrets Store and never touch CI/GitHub.
- **R2 S3 presign identifiers -> `[vars]` (#475).** `R2_S3_ENDPOINT` + `R2_S3_BUCKET` are identifiers,
  not secrets, so they render into `wrangler.toml` `[vars]` at deploy from `CLOUDFLARE_ACCOUNT_ID`
  (no wrangler secret, no new CI variable).
- **plan-enhance un-excluded (#476).** Its `PLAN_ENHANCE_CF_AIG_TOKEN` store secret is now seeded, so
  the module rejoins the CI module deploy loop.
- **AUTH_MODE render fails loud when unset.** The core render no longer defaults an unset `AUTH_MODE`
  to `access`; it errors instead (mirroring `deploy.sh`). Since the whole-hostname Access app was
  removed, a silent `access` default would mis-posture prod. `vars.AUTH_MODE` must be set explicitly.

## v0.12.0

**The module-api/1 deprecation window closes and the Secrets Store migration lands, and prod edge auth
flips from Cloudflare Access to the built-in token gate. Config + release only; no behavior regressions.**

- **module-api/1 deprecation window closed (#294).** The first-party modules are migrated
  vivijure-module/1 -> /2 (batches #461-#466, plus #468 for the excluded sora/wan25), closing the #293
  window. Conformance green per module.
- **Secrets Store migration, module half (part of #238).** The non-looped module workers (#462) and the
  plan-enhance module (#470) move their credentials from `wrangler secret put` to declarative
  `[[secrets_store_secrets]]` bindings (GATEWAY_ID, CF_AIG_TOKEN, per-endpoint RunPod ids). Values are
  seeded once in the crew Secrets Store and never touch CI/GitHub.
- **Token-mode edge auth (prod flip).** The studio worker moves AUTH_MODE access -> token: the built-in
  bearer gate (operator token + D1 named per-consumer tokens, #446) becomes the enforced door and the
  Cloudflare Access application is removed from vivijure.skyphusion.org. Drops the Zero-Trust
  prerequisite for self-host; the browser UI supplies the operator bearer via the existing token shim.
- **plan-enhance store migration ships config-complete but deploy-deferred.** Its per-function token
  PLAN_ENHANCE_CF_AIG_TOKEN is not seeded yet, so plan-enhance is temporarily in the CI EXCLUDE list; the
  currently-live worker keeps running untouched and it un-excludes in the #238 core-migration release
  once the token is seeded.
- **plan-enhance-py proof module retired (#306 / #469).** The Python variant is deleted; the TS
  plan-enhance module is the shipped path.
- **planner + data hygiene (#467, #454/#459/#460, #457, #458/#406).** History-list diffability restored
  and keyframe-stage labels genericized/registry-projected; renders-db raw-row shapes typed; the
  speech-upscale RunPod endpoint id genericized in docs.

## v0.11.0

**The structural-debt sprint: per-consumer API tokens, locality-driven classification, contract-carried
finish conventions, and the god-files split -- 21 PRs across the constellation, zero behavior regressions
(1233 tests green throughout).**

- **Named per-consumer bearer tokens (#445 -> #446).** The studio auth-gate now accepts named tokens
  beside the operator login: D1 `api_tokens` (migration 0009) stores SHA-256 hashes only; a match
  authenticates as `api-token:<name>`; deny reasons are identical across credential classes (no oracle).
  `scripts/studio-consumer-token.sh` mints (plaintext lands ONLY in a chmod-600 file), revokes, lists.
  A bot or satellite gets its own independently revocable credential instead of the operator login.
- **Locality-driven motion classification (#448).** The core classifies motion.backend modules by their
  declared `ui.locality`, never by module name. Fixes a live mislabel: a local door serving
  motion.backend passed the old name filter and could become the default "cloud" model. Missing door
  classes now fail honestly, naming the missing locality.
- **Contract-carried finish conventions (#450).** Finish modules declare `finish_artifacts` in the
  manifest (output-key convention + applied-tag rules); the core's R2-authoritative recovery reads the
  declaration instead of regexing binding names. Third-party finish modules can now opt into recovery.
- **God-files split (#451, #453).** `validateStoryboard` decomposed into section validators;
  the pure film model (shapes, summaries, retry/adoption logic, stall math) extracted to
  `src/film-model.ts` with a re-export barrel -- zero test edits either time. `public/planner.js`
  (7224 lines) split into 16 modules with byte-identical-slice proof (#447), i2v labels project
  through the registry (#455).
- **Installer parity (#452).** `vivijure_deploy.py` learns AUTH_MODE token/access: token mode mints
  the operator secret via the same path as deploy.sh (F18-lite keep-unless-rotate) and skips the
  Access app; consumer tokens point at studio-consumer-token.sh, never a second mint.
- **Constellation (same sprint, other repos):** satellite CI unified on semver-tagged immutable images
  (no :latest); musetalk loads models once per warm worker (~5GB reload per job eliminated); the finish
  stage NVENC-encodes with honest CPU fallback and streams interpolation (bounded RAM); the local doors
  share a byte-identical `vivijure_local/core/`; the backend gains a live SECURE-only RunPod pod client,
  proven by a paid smoke that caught two real bugs before any gate depended on it.

## v0.10.0

**Deploy ratification + the fix-it-all sprint: a cold deploy provisions everything (planner armed,
gateway created, tokens minted once), renders fail honestly instead of masking or leaking spend, and
concurrency/spend safety get real guards.**

- **One-script cold deploy, ratified end to end.** deploy.sh now arms the storyboard planner cold
  (auto-mints the AI-Gateway Run token when the deploy token can, with a paste fallback; #434),
  script-creates the AI Gateway itself with authentication + cache-invalidate-on-update ON at birth
  (#442), serves on workers.dev hostnames (#433), preflights npm ci (#432), and STOPS reminting
  `STUDIO_API_TOKEN` on re-runs -- saved logins survive; `--rotate-token` mints fresh (#442). The
  provisioner writes the env names the backend handler actually reads (#438). Proven by a virgin
  re-run: green end to end, zero interventions.
- **Honest RunPod polls (F17/#141, all 16 RunPod-driving modules; #440).** A backend whose error
  path leaves the job status stuck now gets its structured error surfaced (stage + message + job id)
  instead of polling forever and masking as "job not found"; the module cancels the hung job so it
  stops billing the worker; and a virgin endpoint's image pull no longer false-fails the first-ever
  job (the poll consults `/health` and waits out a genuine cold start, bounded at 15 min).
- **No more double-submits.** `advanceFilmJob` runs under a whole-tick D1 lease (migration 0007), so
  the 1-min cron and client polls can no longer race the same phase transition into duplicated GPU
  spend; the loser reads the job read-only (#439).
- **Spend posture knobs (#441).** `SPEND_LIMIT_FAIL_CLOSED` flips the F3 rate-limit guard to deny
  (503) when the limiter itself is broken; `SPEND_DAILY_CEILING` caps spend-route submissions per UTC
  day in D1 (migration 0008), returning 429 until midnight. Both off unless set.
- **Contract consistency (additive, no api bump; #443).** `score` output gains the shared `degraded`
  chain convention; `film.finish`'s optional `applied` is now a documented decision, and conformance
  type-checks both when present.
- **Docs tell the token-mode truth (#435-#437).** Quickstart/README/DEPLOYMENT rewritten for the
  shipped token auth (Access is optional hardening), the deploy docs match the ratified script, and
  teardown deletes the auto-minted Run token.

## v0.9.0

**Browser-grade media serving (#416): HTTP byte ranges on artifacts and worker-authoritative cache
headers.**

- **Byte-range requests on `/api/artifact`.** The artifact route ignored `Range` entirely, so
  Safari/iOS (which require ranged media) could not play planner films at all and a Chrome seek
  refetched from byte 0. It now advertises `Accept-Ranges: bytes` and serves 206 + `Content-Range`
  for closed, open-ended, and suffix ranges, a true 416 with `bytes */size` when out of bounds, a
  graceful full 200 on malformed or multi-part ranges, and supports HEAD (#421).
- **Cache headers are the worker's job now.** Bare non-page responses default to `no-store` at the
  response chokepoint (set-if-absent), artifacts keep `private, max-age=300`, and static assets keep
  the ASSETS binding's revalidate-always header. A deployment is cache-correct without any zone-level
  bypass rule; ours is reframed in the docs as optional hardening, so outsider deployments no longer
  depend on a dashboard setting they cannot see (#421).

## v0.8.4

**Planner regression sweep closes (#411): the NULL-string mapping fix and a module-bound local dev
environment.**

- **SQL NULL no longer serialized as the string "null".** The renders list mapped NULL
  `project` / `bundle_key` / `quality_tier` through a bare `String()`, shipping the literal, truthy
  string `"null"` to the planner: "null" labels and download names, and a bundle-less row that looked
  re-render eligible. Those fields now coerce to `""` like the sibling nullable fields, so the
  planner's existing truthiness gating is correct with no frontend change (#418).
- **Module-bound local dev environment.** `.dev-modbound/dev-modbound.sh` runs the core plus every
  in-tree module worker in one local `wrangler dev` fleet: the real 25-module catalog projects into
  the planner while every module invoke stays inert (binding-free dev configs; no GPU or provider
  spend possible). Includes a dev-only planner AI mock (`PLANNER_AI_MOCK`, unset in prod, live path
  unchanged) whose canned output runs the real extract/parse/validate pipeline, with sentinels for
  pass, validator-reject, and parse-failure. Closes the dev-parity gap the sweep surfaced; recipe in
  `docs/dev-modbound.md` (#419).

## v0.8.3

**Planner regression-sweep fixes (#411): the keyframe lightbox and the dead progress-stream path.**

- **Keyframe lightbox is styled.** Clicking a keyframe thumbnail opened an overlay whose classes had
  no CSS at all, dumping an unstyled full-size image at the page bottom (same never-implemented class
  as the v0.8.2 player fix). The lightbox is now a fixed full-viewport overlay: image contained and
  aspect-preserved at any shape (2x-upscaled, portrait, 1:1), backdrop + Escape dismiss (#412).
- **Dead render-progress stream removed.** The planner opened an SSE connection to a `/stream`
  endpoint that never existed server-side, so every render flashed "stream closed; falling back to
  8s polling" before polling anyway. The dead client path is gone; the 8-second poll on the
  structured status channel is the single, silent mechanism. Server-side SSE is tracked as a
  post-announce enhancement (#414, #415).

## v0.8.2

**Planner: upscaled films display correctly; hook-contract enforcement at runtime; support/security
contact docs.**

- **Upscaled clips no longer blow out the history card.** The inline film player and per-shot motion
  clips had no CSS sizing, so a 2x-upscaled MP4 rendered at intrinsic resolution and the card's
  `overflow:hidden` clipped it to a blown-up crop. Players now size to the card and keep the clip's
  own aspect (#410). Trigger for the full planner regression sweep (#411).
- **Runtime hook-contract enforcement (F5b).** The core now validates a module's terminal output
  against its hook contract at the orchestrator consumption seams (render, film, score, cast-image);
  an envelope-correct but malformed payload takes that seam's existing honest-degrade with a
  traceable per-module reason instead of being threaded downstream (#345, #408).
- **Support and security contact docs.** `SUPPORT.md` (GitHub Issues first, support@skyphusion.org
  next) and a root `SECURITY.md` reporting policy (private reports to security@skyphusion.org,
  linking the `docs/SECURITY.md` posture doc) now ship in this and every constellation repo (#409).

## v0.8.1

**Pre-announce polish: honest public docs, a cleaner deploy front door, and edge-cache purge on release.**

- **Welcome page reflects the real constellation.** The "how it fits together" table now lists both
  local self-host doors (`vivijure-local-12gb` / `-16gb`) and all three finish satellites
  (`vivijure-musetalk` / `-upscale` / `-audio-upscale`), with a pointer to `docs/constellation.md`. The
  stale "seven motion backends" claim is replaced with backend-agnostic wording (#403).
- **Deploy hygiene.** The real account Secrets Store id is templated out of the public module configs
  behind a `REPLACE_WITH_VIVIJURE_SECRETS_STORE_ID` placeholder; `deploy.sh` (outsider path) fills it
  from the operator's store and CI fills it from the `SECRETS_STORE_ID` repo variable, fail-closed, so
  a tag deploy never ships a dangling `[[secrets_store_secrets]]` binding. `deploy/vivijure_deploy.py`
  is demoted to a labelled alternative so `deploy.sh` is the single documented front door. The
  speech-upscale opt-in now names its per-module `RUNPOD_ENDPOINT_ID` secret (#404).
- **Edge-cache purge on release.** The tag-gated deploy job now purges the Cloudflare edge cache for
  `/welcome` and `/` after the core deploys, so a release stops serving a stale welcome page. Opt-in
  and self-host safe: a no-op unless `CF_ZONE_ID`, `CF_PURGE_HOST`, and `CF_CACHE_PURGE_TOKEN` are all
  set; honest failure (the worker is already live, so a purge error never rolls back) (#405).

## v0.8.0

**Workers-for-Platforms dynamic dispatch goes live: install a module without redeploying the core.**

- **WfP dispatch enabled in prod (Phase 3 deploy).** The `vivijure-modules` dispatch namespace is
  created and the core now binds `MODULE_DISPATCH`, so a module uploaded into the namespace is reached
  at request time via `env.MODULE_DISPATCH.get(<script>).fetch(...)` -- no core redeploy to install one.
  This lands the host-side dispatch work (#391 / #392 / #393) as a running capability; `GET /api/modules`
  now reports `host.dispatch: true`. Conformance-gated install routes + the operator CLI drive uploads.
- **Free-self-host promise preserved, by construction.** The `[[dispatch_namespaces]]` block still ships
  COMMENTED in `wrangler.toml.example`. Our prod render uncomments it only when the repo variable
  `ENABLE_WFP_DISPATCH == "1"` (set once, after the namespace exists); a community fork never sets it, so
  its render stays commented and deploys on the free plan with zero WfP dependency. The dispatch layer is
  also runtime-gated on `MODULE_DISPATCH` being bound, so behavior is identical when it is absent.
- `local-gpu` stays in the CI deploy EXCLUDE: under WfP the multi-tenant local door becomes a
  per-tenant namespace upload, not a `[[services]]` deploy -- a follow-on once tenant onboarding lands.

## v0.7.7

- **Exclude the WIP `local-gpu` module from deploy (#382).** It has no core `[[services]]` binding and its Secrets Store secrets are unseeded, so its deploy failed (code 10182) and broke v0.7.6. Fenced out until the homelab door lands.

## v0.7.6

- **Planner: BYO locality tag + bind the finalize gate to the BYO door (#381).** Three-value locality (local | byo | cloud) surfaced to the planner; finalize gated behind the BYO door.

## v0.7.5

- **Run the worker on static pages so security headers actually land (#377).** Re-fixes header stamping on `/welcome` and all pages without the redirect loop v0.7.3 introduced.

## v0.7.4

- **Revert `run_worker_first` (#375).** It broke `/welcome` with a 307 redirect loop; reverted pending the correct fix (landed in v0.7.5).

## v0.7.3

- **`run_worker_first` so the worker stamps headers on `/welcome` + all pages (#374).** Reverted in v0.7.4, superseded by v0.7.5.

## v0.7.2

- **Substitute `WEB_ANALYTICS_TOKEN` in the wrangler.toml render (#373).** The analytics beacon token now renders from the Actions secret.

## v0.7.1

- **Render wrangler.toml BEFORE applying D1 migrations (#372).** `wrangler d1` needs the rendered config to resolve the D1 binding and `migrations_dir`.

## v0.7.0

- **Worker-owned security headers on every response class (#371).** One source of truth for headers across page, API, and asset responses.

## v0.6.6

- **Durable module secrets via Cloudflare Secrets Store (#237).** Module secrets bind declaratively from the account Secrets Store, so a fresh-create can no longer start secretless and silently degrade.

## v0.6.5

- **Open a character on load so highlight + detail pane stay in sync (#146).**

## v0.6.4

- **Reconcile LoRA training rows wedged in `training` back to `failed` (#295).**

## v0.6.3

- **Exclude not-ready modules from deploy (#305):** openai-sora, alibaba-wan25, plan-enhance-py.

## v0.6.2

- **Fix exit-127 in the dynamic module deploy (#304).** POSIX sh only, no bash-isms (the CI container's `/bin/sh` is BusyBox ash).

## v0.6.1

- **Deploy ALL modules dynamically, not a hardcoded include-list (#303).** Fixes deploy-drift where a new module was forgotten and the live worker served stale.

## v0.6.0

- **Operator install-config page, registry-projected (#301).** Per-module install config edited from a settings page projected off the registry.

## v0.5.0

- **Strip `user_email` to zero: identity-free, anti-SaaS by architecture (#292 / #293).** No user identity is stored; the studio is self-hosted software, not a data-collecting service.

## v0.4.2

- **Write the runnable R2 doc before the D1 rows so a submit cannot orphan a render (#289 / #290).**

## v0.4.1

- **Fail loud on a partial assemble (#287 / #288).** Never silently complete a 1-of-N scatter gather.

## v0.4.0

- **Run the `film.finish` chain on the scatter gather (#286).** Subtitles and title/credit cards applied on the scatter assemble path.

## v0.3.3

- **Clamp seedance duration minimum to 4 (#279 / #282).** The endpoint allows [4,12] and 400s on 3.

## v0.3.2

- **Wire `tail_consumers` -> `vivijure-tail` (#278).** Deploy-ordered observability tail consumer.

## v0.3.1

- **Make the keyframe backend user-selectable (#275).** cloud-keyframe becomes reachable alongside the GPU keyframe.

## v0.3.0

- **Wire every `config_schema`-bearing hook end to end (#274):** speech + film.finish + master config knobs plumbed through; gated the v0.3.0 cut.

## v0.2.6

**Launch prep: fail-loud finish, the talking showcase, and the render-pipeline diagram.**

- **Fail loud on a failed finish chain (#245 / #249):** a finish step that genuinely fails (after the bounded retry + R2 reclaim) now fails the render with the real per-shot error instead of silently advancing to done and shipping the raw i2v clip with `applied=[]`. `clipKeysFromFilmJob` returns finished clips only when a finish chain was set up, never substituting a raw clip for a non-done shot. The honest-failures safety net: a finish failure can no longer ship a green-but-unfinished film.
- **Welcome page + README:** the "Vivijure Speaks" talking-character showcase on the public welcome page (#240), and a render-pipeline mermaid diagram in the README (storyboard to keyframe to dialogue + motion.backend to the finish chain to assemble to mux).
- Pairs with **backend-v0.2.27** (the RIFE pad-to-64 fix, verified live VOICED+FULL on a non-64 resolution): the finish chain now runs on every cloud i2v output dimension, so all seven motion backends do the full lip-sync + upscale path.
- **693 tests**, typecheck-clean.

## v0.2.5

**Preflight fix: the pre-render safety check actually runs now.** Found in a full planner regression pass.

- **preflight route wired + envelope unwrapped (#242 / #243):** `src/preflight.ts` (the real validator: shape + cast-readiness) was written but never imported, so `/api/storyboard/preflight` only ran the shape gate against the wrong object: it read `.title`/`.scenes` off the `{storyboard, castBindings}` envelope (undefined) and returned HTTP 400 on every valid storyboard. The client threw on the non-2xx and showed only "HTTP 400" with no reasons, and its bundle gate never activated. The handler now unwraps `.storyboard`, runs the full chain (validateStoryboard -> checkStoryboardShape -> checkCastBindingsReady -> summarize), and returns the PreflightResult at HTTP 200 with `ok:false` + structured issues for a storyboard-with-problems (validation findings are data, not an HTTP failure). The client now renders the issues and the bundle gate works. D1 is only queried when cast bindings are present.
- **690 tests** (8 new preflight-route tests incl. the exact old-bug payload as a regression guard), typecheck-clean.

## v0.2.4

**Cloud i2v duration enum fix.** Unblocks the cloud motion backends for short shots.

- **kling + wan duration snap (#241):** the Kling ({5,10}) and Wan 2.6 ({5,10,15}) cloud i2v modules accept only a discrete duration enum, not a continuous range; the old continuous clamp passed a 4s shot straight through and the provider 400'd at submit (so a cloud talking render failed before any clip rendered). Duration now snaps UP to the smallest allowed value at or above the per-shot seconds (4s -> 5; a 7s shot -> 10, never clipped shorter than the shot). The other six cloud modules likely share the bug; tracked as follow-up.
- **683 tests**, typecheck-clean.

## v0.2.3

**Finish-chain self-heal: a GC'd or frozen mid-chain finish step now recovers from R2.** Builds on v0.2.2's silent-render fixes.

- **R2-presence advance for any finish step (#239):** when a finish step's RunPod poll job is GC'd-after-complete (a 404) or freezes IN_PROGRESS (poll pends forever), and that step's OWN expected output is already in R2, the orchestrator folds it in and advances to the next module -- instead of polling a ghost job to the hard deadline. This fixes the wedge where RIFE completed and its output landed in R2 but the finish chain never advanced, so lip-sync was never dispatched and the shot pended forever. Per-step advance on the step's own artifact (not final-artifact adoption), so the remaining modules still run -- it cannot ship a half-finished clip.
- **682 tests**, typecheck-clean.

## v0.2.2

**The talking-character showcase fix: a scatter film keeps its voice end to end.** Builds on v0.2.1's self-heal so the orchestration now reliably delivers per-shot dialogue + lip-sync through gather and assemble.

- **Scatter keeps clip audio (#234):** when a render has dialogue, the gather concat now preserves each lip-synced clip's baked-in audio (and silent-pads an audio-less clip to a uniform track), instead of stripping all audio and producing a silent film.
- **No mid-chain finish adoption (#234):** a finish shot whose module fails mid-chain is no longer adopted from its intermediate R2 clip as "done" -- only the chain's final artifact is adoptable, so a failed lip-sync can no longer masquerade as a finished (silent) clip.
- **Bounded finish-step retry (#234):** a transient finish-module blip (5xx / timeout / lost poll token) re-dispatches the step up to 3 attempts; a deterministic reject (4xx / no face) still fails loud -- so a momentary MuseTalk cold-start no longer silences a shot.
- **Watchdog spares D1-blocked shards (#230):** a shard that is merely retrying a transient D1 error is no longer declared dead by the watchdog.
- **voiced-verify (#236):** a `scripts/` checker that gates a render on per-shot lip-sync + non-silent audio (volumedetect), not just stream presence.
- **677 tests**, typecheck-clean.

## v0.2.1

**Production hardening: tag-gated deploys + render self-heal.** First release cut under the new tag gate.

- **Tag-gated deploys (#228):** a push/merge to `main` now runs typecheck + test only; the Cloudflare deploy (module workers -> D1 migrations -> core) fires ONLY on a pushed `v*` SemVer tag. A merge can no longer redeploy production or interrupt an in-flight render.
- **D1 transient self-heal (#229):** the render-advance hot path retries transient `D1_ERROR` internal blips (4 attempts, short backoff) while constraint / SQL errors still fail fast, so a momentary D1 hiccup no longer wedges a shard until the watchdog -- the every-60s sweep now genuinely self-heals.
- **trainLoras fails hard (#227):** a render bound to a character with no trained cast LoRA now 400s naming the character ("train them on the Cast page first") instead of silently inline-retraining the LoRA every render.
- **665 tests**, typecheck-clean.

## v0.2.0

**Phase 1: render API + studio UI.** The film studio is fully home in this worker; the AI Playground
(`skyphusion-llm-public`) no longer owns render or planner routes.

- **Render spine:** film orchestrator (keyframe -> motion -> finish -> assemble), scatter-gather,
  render-from-keyframes, regen-shot, cron sweep for orphaned jobs, module-driven overrides UI.
- **Cast:** training-set gen via `cast.image`, LoRA train/status, portrait + multi-scene image chat,
  ref/source management, artifact copy from chat outputs.
- **Library:** renders CRUD, finalize / animate-cloud / animate-hybrid, adopt backfill, prefs,
  notify hook (`notify-email` module).
- **Authoring:** plan / refine / yaml / markers / bundle / score-bed / beat analyze / enhance chain.
- **Eleven module workers** bound in `wrangler.toml` (keyframe, own-gpu, seedance, kling, finish-rife,
  cast-image, notify-email, music-gen, narration-gen, beat-sync, plan-enhance).
- **368+ tests**, typecheck-clean CI.

## v0.1.0

**Phase 0: the module host.** First cut of Vivijure Studio as a standalone Cloudflare Worker, split
out of `skyphusion-llm-public` so the AI Playground and the film studio no longer share a roof.

- **The module contract (`vivijure-module/1`)** in `src/modules/types.ts`: hooks, manifest,
  `invoke` envelope, reference `finish` payloads.
- **The registry** in `src/modules/registry.ts`: discovers `MODULE_*` bindings, validates manifests,
  clamps config, indexes by hook.
- **`GET /api/modules`** plus the **self-assembling frontend** (`public/`): UI is a projection of
  the registry; zero modules installed is a valid lean studio.
- **`docs/module-api.md`**: the design spec.
- Tests cover manifest validation, hook indexing, discovery against faked bindings.
