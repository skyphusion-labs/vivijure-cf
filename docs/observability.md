# Observability: where logs go, and how to query them

> **STATUS 2026-09-27 (cf#838). The Loki half of this document is a SETUP GUIDE, not a description
> of a running system.** The host that ran the reference Loki and Grafana is deleted;
> `grafana.skyphusion.org` is NXDOMAIN (measured). `wrangler.toml.example` no longer binds
> `tail_consumers`, so a fresh deploy of the core ships console lines to Cloudflare Workers Logs and
> nowhere else.
>
> Why it is called out this loudly: for the quarter before this change the binding was still live and
> still green. `vivijure-tail` was invoked 549 times in the six hours before the fix (measured from
> the Workers observability API) and delivered nothing, and no surface anywhere said so. That is the
> failure worth remembering: an absent sink read exactly like a working one.
>
> The shipper itself is generic and supported. If you run your own Loki, follow
> [opt-in-tiers.md](opt-in-tiers.md) and the sections below. Since cf#838 a misconfigured sink is
> observable instead of silent: `vivijure-tail` emits one `{"ev":"tail.sink.drop","reason":...}` line
> per dropped batch into ITS OWN Workers Logs (`reason` is `sink_unbound`, `sink_unreachable`,
> `sink_rejected` or `shape_failed`, with a `lines` count of what did not arrive). A quiet tail worker
> with live invocations now means delivery; before cf#838 it meant nothing at all.

There are **two** observability surfaces for the Vivijure workers, and they hold
different things. Querying the wrong one is the single most common diagnosability
trap on this project, so read this before you conclude "the logs are missing."

## Self-hosting honesty: a stock deploy is poll-only

Everything below describes the REFERENCE pipeline (the skyphusion production instance). A stock
`./deploy.sh` install does NOT have it: the `tail_consumers` block is an OPTIONAL block in
`wrangler.toml.example` (the minimal profile strips it), and the tail worker, Loki, and Grafana
are operator-run infrastructure this repo does not stand up for you.

Out of the box a self-hosted studio has:

- **Cloudflare Workers Observability** (the dashboard "Observability" tab): invocation summaries,
  status codes, timings, cron runs. `[observability] enabled = true` ships on in the template.
- **The studio's own status routes**: render and job progress is polled over `/api/*` (the studio
  UI does this polling for you). There is no push/streaming log channel.

That is enough to operate a single-user studio. If you want the full structured-event pipeline
below (Loki labels, LogQL over the `{"ev": ...}` events), you stand it up yourself: run a Loki +
Grafana somewhere you control, deploy a tail worker that ships to it, and keep the
`tail_consumers` optional block in your rendered config. The rest of this doc is the map of that
setup, written against our reference instance.

## TL;DR -- which tool for what

| You want...                                                              | Use                                   |
|--------------------------------------------------------------------------|---------------------------------------|
| Request line, status, duration, cron/fetch trigger, invocation outcome   | **CF Workers Observability** (query API / dashboard "Observability" tab) |
| Your `console.log` lines, structured `{ "ev": ... }` events, app state    | **CF Workers Observability** logs view, plus **your own Grafana / Loki** if you run the opt-in tail tier (there is no reference instance; `grafana.skyphusion.org` is NXDOMAIN) |

**The gotcha:** the CF observability **query API** returns ONLY invocation-summary
events (`type: cf-worker-event` -- the request line, status, and the cron/fetch
trigger), even when `observability.logs.enabled = true`. Your `console.log`
content does **not** come back through that API. If you filter the CF obs API for
a token that only exists in a log body (e.g. `film.render.terminal`) you get `[]`, and
it looks like the log was dropped. It was not: with `[observability.logs] enabled = true` it is in
the Workers Logs view (dashboard, or the `/telemetry/query` endpoint against the logs dataset), and
additionally in Loki IF you run the opt-in tail tier. Do not read an empty result from the
invocation-summary query as a missing log line, and do not read it as proof a tail sink is working.

## The pipeline

```
worker  --console.log/exceptions-->  tail_consumers = [ vivijure-tail ]
        --(vivijure-tail worker)-->  LOKI_VPC  (vpc_service binding)
        --(Cloudflare VPC connector)-->  Loki  (self-hosted on the operator's monitoring host)
        --(datasource)-->  Grafana  (grafana.skyphusion.org)
```

The tail consumer is what carries the rich per-invocation `logs[]` and
`exceptions[]`. That is its whole job. The CF obs dataset is a separate, summary
only index.

## Config (must be mirrored in `wrangler.toml`)

```toml
[observability]
enabled = true

# SELFHOST-SKIP optional block in wrangler.toml.example (top level, before any [table]):
tail_consumers = [ { service = "vivijure-tail" } ]
```

`[observability]` is what `wrangler.toml.example` ships; the `tail_consumers` line is present but
COMMENTED OUT (cf#838). `head_sampling_rate` is NOT set in the template (Cloudflare's default of `1`,
i.e. sample every invocation, applies); add `head_sampling_rate = 1` under `[observability]` only if
you want it explicit.

Measured on the live `vivijure-studio` worker 2026-09-27, before this change landed:
`observability.logs = {enabled: true, persist: true, invocation_logs: true, head_sampling_rate: 1}`
and `tail_consumers = [{ service = "vivijure-tail" }]`. The first stays and is the surface that
actually holds your log lines. The second is what cf#838 unbinds, because `vivijure-tail` still
carried its `LOKI_VPC` binding to a service whose Loki no longer exists.

The tail worker is an **opt-in tier** (stripped for a self-host default and for WfP tenants) deployed
by hand via `scripts/deploy-tail.sh`, which renders `tail/wrangler.toml` from
`tail/wrangler.toml.example` (`LOKI_VPC_ID` injected; cf#294 / PR #309). It is not
part of `deploy.sh` or the tag-gated CI release job -- it changes rarely. The worker reaches your Loki
through its `LOKI_VPC` `vpc_service` binding, at `LOKI_PUSH_URL` or the
`http://loki:3100/loki/api/v1/push` default.

## Loki labels (the tail derives these per line)

The tail (`tail/src/index.ts`, `shapeEventsToLoki` / `deriveFields`) sets exactly four stream
labels: `worker`, `level`, `phase`, `module`. They are derived by best-effort parsing of the log
TEXT, not read from structured fields (a line is only read structurally when it is a JSON object
with `"_v":1`, which no current emitter sets).

| Label          | Meaning / values                                                   |
|----------------|--------------------------------------------------------------------|
| `worker`       | the producing worker's `scriptName`, e.g. `vivijure-studio` (`unknown` if absent) |
| `level`        | `info`, `warn`, or `error` (`mapLevel`): `console.error` -> `error`, `console.warn` -> `warn`, `console.log` / `info` / `debug` -> `info`; exception rows are always `error`; an invocation summary is `info` when `outcome` is `ok`, `error` for `exception` / `exceededCpu`, else `warn` |
| `phase`        | the FIRST entry of the tail's `PHASES` list that appears as a whole word in the line: `keyframe`, `pre_clip_dialogue`, `pre_clip_speech`, `clips`, `dialogue`, `speech`, `finish`, `assemble`, `master`, `mux`, `done`, `failed`; otherwise `unknown` |
| `module`       | `film.finish` if the text contains `film.finish`; else the first `<name>: ` token (lowercase word followed by colon + space) that is not a phase name; else `none`. Compact JSON lines (no space after `:`) therefore get `none` |
| `service_name` | NOT set by the tail (see note)                                     |

> **Open question (#764, OB-14):** `service_name` is not one of the tail's labels; it is added on the
> Loki side (Loki's own service-name discovery, typically `unknown_service` for these streams). Whether
> to keep documenting it here is an owner call.

Because `phase` is a real label you can slice without a full text scan, e.g.
`{worker="vivijure-studio", phase="assemble"}`. It is a keyword match, not a pipeline fact: a
`film.phase` line `{"ev":"film.phase",...,"from":"clips","to":"finish"}` is labelled with whichever
`PHASES` entry comes first in that list order (`clips` here), so filter on the parsed `to` field when
you need the real transition.

## Line shape (important: double-wrapped)

A Loki line is `{"msg":"<inner>"}`:

- **Invocation summary:** `inner` is the request line, e.g.
  `{"msg":"GET https://vivijure.skyphusion.org/... 200","kind":"invocation","outcome":"ok","status":200}`.
- **App log:** `inner` is your `console.log` payload as a string, e.g.
  `{"msg":"{\"ev\":\"film.phase\",\"film_id\":\"film-...\",\"project\":\"...\",\"from\":\"clips\",\"to\":\"finish\"}","job_id":"film-...","outcome":"ok"}`.

So to parse structured fields you unwrap twice: `| json | line_format "{{.msg}}" | json`.

The OUTER object carries tail-added fields beside `msg` (absent keys are omitted, never zeroed):

| row kind | outer fields |
|----------|--------------|
| invocation summary | `msg` (`<METHOD> <path-or-url> <status>`, `cron <expr>`, `scheduled`, or `invocation`), `kind: "invocation"`, `outcome`, `status`, `path`, `cpu_ms`, `wall_ms`, `truncated` (only when the runtime dropped events) |
| app log (`console.*`) | `msg`, `job_id` (regex-derived from `film-...` / `clips-...` in the text), `reason` (only for `_v:1` lines), `outcome` (the invocation outcome) |
| exception | `msg` (`<name>: <message>`), `name`, `job_id`, `outcome` (defaults to `exception`) |

`cpu_ms` / `wall_ms` are line fields, not labels; query them with `| json | unwrap wall_ms`.

## The clips-only / silent-film degrade event (`film.finish_unavailable`)

When the video-finish media tier is UNAVAILABLE, the film does not hard-fail after the GPU spend. It
COMPLETES delivering what was rendered, and the orchestrator emits one loud, structured line so you
can see it happened (#519 / #524). In the pinned core the triggers are:

- **assemble:** `VIDEO_FINISH_URL` is unset/empty. (A set URL whose container then fails or is
  unreachable FAILS the render at assemble with the real error; it does not degrade.)
- **mux:** `VIDEO_FINISH_URL` is unset/empty, OR the remux job fails / is unreachable (the error from
  the async submit/poll), OR the container reports it could not attach the audio bed.

```
{"ev":"film.finish_unavailable","film_id":"...","project":"...","at":"assemble","delivered":"clips","clips":3,"reason":"video-finish tier not installed (VIDEO_FINISH_URL unset); delivered per-shot clips"}
```

- `at` -- which delegated step could not run: `assemble` or `mux`.
- `delivered` -- what shipped instead of the finished film: `clips` (the per-shot clips, no single
  concatenated film) at the assemble step, or `silent_film` (the assembled film with no audio bed
  muxed onto it) at the mux step.
- `clips` -- the count of per-shot clips delivered (the assemble degrade); `0` for the silent-film case.
- `reason` -- the honest cause. Literal strings: `video-finish tier not installed (VIDEO_FINISH_URL
  unset); delivered per-shot clips` (assemble), `video-finish tier not installed (VIDEO_FINISH_URL
  unset); shipped silent film` (mux), `video-finish could not attach the audio bed (the bed exceeded the
  container audio cap or was undecodable); shipped silent film` (mux), or the async remux error text
  (mux, e.g. `video-finish async submit failed (no jobId)`).

This is the UNAVAILABILITY path ONLY. A genuine per-shot / container ERROR (the container ran and
reported a real failure) still fails the render loud with the real per-shot error (#245 / #249); it
never emits this event. So a `film.finish_unavailable` line means "completed, but the finish tier was
not reachable", never "silently shipped a broken render".

The same fact surfaces on the API poll view (`finish_unavailable = { at, reason, delivered }`, plus
the deliverable `clips[]` of `{ shot_id, clip_key }` at the assemble step) so the UI shows "clips
only, finish unavailable" instead of a plain green with a missing film. On the clips-only path the
film download route presigns each clip so the caller can fetch the delivered clips directly.

## The output-validation event (`clip.validate`, #523)

Every rendered motion clip is **structurally validated at intake** -- the moment it reaches `done` with a
clip key, BEFORE the finish / dialogue / upscale chain spends anything downstream (#523: a satellite GPU
once upscaled 411KB of pure noise to 2.8MB because nothing looked at the clip). The gate is core-side and
engine-agnostic, so it covers the cloud backend, both local-gpu doors, and any future `motion.backend`
module with one check. It emits one structured line per shot:

```
{"ev":"clip.validate","job_id":"clips-...","shot_id":"shot_01","verdict":"pass","checks":{"container":true,"video_track":true,"duration_s":3.0,"expected_s":4,"frames":49,"width":720,"height":480,"bytes":411000}}
```

- `verdict` -- `pass` (structure sound), `fail` (structurally corrupt; the shot is failed with the real
  reason BEFORE any finish spend, honest-failure #245/#249), or `skip` (the artifact was unreadable or
  validation is disabled -- an I/O blip never false-rejects a real render, so it is left untouched).
- `checks` -- what the in-Worker mp4 box parse could read: `container` (valid ftyp + moov), `video_track`,
  `duration_s`, `expected_s` (the requested seconds, for context only -- NOT gated, since backends emit a
  fixed frame count), `frames` (video sample count), `width`/`height`, `bytes` (object size).
- `reason` -- present on `fail` / `skip`: the honest cause (truncated / non-mp4 / zero-frame /
  zero-duration / out-of-bounds duration or dimension / unreadable).

**Honest scope (do not over-read a `pass`).** A CF Worker has no video decoder, so this catches the
STRUCTURAL-corruption class only. A structurally-valid clip of pure *pixel* noise (local-16gb#35: CogVideoX
on a vGPU) passes this gate -- separating noise from content needs a pixel decode, which is Layer 2 (a
pre-finish gate in the video-finish CPU container, tracked separately). A `clip.validate` `pass` means
"the container is well-formed", never "the picture is good".

## The content-validation event (`clip.content_validate`, #523 Layer 2)

Layer 1 (`clip.validate`) is a Worker-side STRUCTURAL check and cannot see pixels. Layer 2 is the
pixel-content catch: at the film **finish gate** (before finish/upscale GPU spend), the core asks the
video-finish container (which runs ffmpeg) to look at the frames and judge whether the clip plausibly
contains its conditioning keyframe. It runs only on the film path (where spend happens), only when the
video-finish tier is installed, and emits one line per shot:

```
{"ev":"clip.content_validate","job_id":"clips-...","shot_id":"shot_01","verdict":"corrupt","keyframe_similarity":0.02,"metrics":{"sat_mean":108.7,"gray_std_mean":18.5,"chroma_structure_ratio":5.63,"frames":12},"reason":"first frame does not resemble its keyframe ..."}
```

- `verdict`:
  - `corrupt` -- CONFIDENT: the clip's first frame does not resemble its conditioning keyframe (the
    local-16gb#35 signature). The shot is FAILED with the real reason BEFORE finish/upscale spend
    (honest-failure #245/#249). This is the pixel-noise catch Layer 1 cannot make.
  - `suspect` -- the weaker content-only heuristic fired (chromatic-noise signature: high saturation,
    low luma structure). WARN only: a `content_degraded` marker is set on the shot and the film
    still completes. Never a hard fail on the heuristic alone (deliberately-abstract films exist).
  - `ok` -- passed.
  - `skip` -- the container was unreachable / `/inspect` errored (`video-finish /inspect unreachable or
    errored`), or the presign failed (`presign failed: ...`). A down inspector never fails a real render.
    When the tier is NOT installed (`VIDEO_FINISH_URL` unset, e.g. self-host), Layer 2 is a no-op and
    emits NO `clip.content_validate` line at all (not a `skip`).
- `keyframe_similarity` -- normalized first-frame-vs-keyframe correlation in [0,1] (present when a keyframe
  was available); ~0 = the output ignored its conditioning.
- `metrics` -- `sat_mean`, `gray_std_mean`, `chroma_structure_ratio` (the fallback noise signature), `frames`.

Empirically (S12 evidence): the CogVideoX-on-vGPU noise clips score `chroma_structure_ratio` ~5.6 while
every good clip (LTX, film, LoRA, high-motion) scores <= 2.5; the threshold sits mid-gap at 4.0. That
fallback only WARNS; the keyframe-similarity check (available in production, where every shot has its
keyframe) is the confident signal.

## The partial-keyframe degrade event (`film.keyframes_incomplete`, #619 / #622)

When the keyframe phase delivers a PARTIAL set -- the stall-recovery ceiling fired with some
keyframes still missing (#619), or a keyframe module honestly completed with fewer keyframes than
scenes, e.g. a per-shot content refusal (#622) -- the film does not silently rebase to the smaller
total and report a clean `complete`. It delivers the scenes that rendered LOUDLY: the drop is
recorded on the job's `keyframes_incomplete` field (`{ adopted, expected, dropped }`, surfaced on
the poll view), and the orchestrator emits one structured line:

```
{"ev":"film.keyframes_incomplete","film_id":"...","project":"...","adopted":2,"expected":4,"dropped":["shot_03","shot_04"]}
```

The all-missing case still hard-fails loud; this event is the some-rendered degrade only. A film
with this line completed, but it is NOT the full storyboard -- the poll view says so too.

## The Wan cast-LoRA projection event (`film.wan_lora_projection`, cf#392)

When the host projects bound cast Wan adapters into an `alibaba-wan-lora` motion config
(`src/wan-lora-projection.ts`), it records `{ injected, dropped }` on the film job (host field
`wan_lora_projection`, relayed on the film summary and planner poll `output`) and emits one
structured line so phase-1 verification can assert the motion adapter was injected without digging
through R2:

```
{"ev":"film.wan_lora_projection","film_id":"...","project":"...","injected":1,"dropped":0,"applied":true}
```

`injected` is the number of cast slots whose high/low expert pair was presigned into the config;
`dropped` is how many the per-pass cap (`MAX_LORAS_PER_PASS`) refused. A pure no-op (wrong motion
backend, or no Wan cast) emits nothing and leaves the poll field absent. (Scatter is retired, the
scatter routes answer `410` `Scatter is retired. Start a single film.`, so every live emit carries
`film_id`; the emitter still accepts an optional `scatter_id` but no live caller passes one.)

## The deferred-bookkeeping event (`render.bookkeeping_deferred`, #695)

A started film never 500s on its own bookkeeping: after `startFilmJob` returns, the post-start
writes (the history-row insert, the download-url presign) are best-effort. A transient D1 blip
there logs one structured line and the `201` still ships -- instead of baiting a retry-on-5xx
client into paying for a SECOND film:

```
{"ev":"render.bookkeeping_deferred","op":"insertRender","job_id":"...","project_label":"...","reason":"..."}
{"ev":"render.bookkeeping_deferred","op":"withFilmDownloadUrl","film_id":"...","reason":"..."}
```

`op` names the deferred write (`insertRender` = the history-row insert; `withFilmDownloadUrl` =
the presign enrichment, which returns the summary without a `download_url` -- the next poll
re-issues it). The fields differ per `op`: `insertRender` carries `job_id` and `project_label` (a
scrubbed `keyLabel` of the project, never the raw project name, cf#223); `withFilmDownloadUrl`
carries `film_id` and no project field.

The poll path insert-if-missing heals the missing row on the next poll. A line here means "the
film started fine; a UI-list row lagged one poll", never a lost render. Polls themselves stay
throwing (they are idempotent; a retry is safe there).

## The film lifecycle events (`film.phase`, `film.render.terminal`)

These are the backbone for tracing a render. The core's `putFilm` (every film job-doc write) compares
the previous persisted phase (in-isolate cache, else recovered from the R2 job doc) with the new one
and, on a change, emits:

```
{"ev":"film.phase","film_id":"film-...","project":"...","from":"clips","to":"finish"}
```

- `from` -- the previous phase, or `null` when none was recoverable (e.g. the first write).
- `to` -- the new `job.phase` (`keyframe`, `pre_clip_dialogue`, `pre_clip_speech`, `clips`,
  `dialogue`, `speech`, `finish`, `assemble`, `master`, `mux`, `done`, `failed`).

When the new phase is `done` or `failed` it ALSO emits exactly one terminal line:

```
{"ev":"film.render.terminal","film_id":"film-...","project":"...","status":"failed","from":"assemble","error":"duration gate: ..."}
```

- `status` -- `done` or `failed`.
- `from` -- the phase the film left (or `null`).
- `error` -- present only when the job carries one (a failed film's real reason; also a `done` film
  that recorded an error string).

A film that never produces a `film.render.terminal` line is still in flight (or wedged; see
`film.advance_failed` below).

### Other live structured events

Every line below is a single-line JSON object with an `ev` field (the table lists the fields besides
`ev`). `level` is what the tail assigns from the console method. Each was verified by grepping the
emitter in the pinned core dist (`node_modules/@skyphusion-labs/vivijure-core/dist`) or `src/`.

| `ev` | emitter | level | fields | meaning |
|------|---------|-------|--------|---------|
| `motion.audio` | core `film-orchestrator` | info | `film_id`, `shot_id`, `kind` (`line` / `silence` / `voice_ref` / `none`) | the audio conditioning chosen per motion shot |
| `dialogue.pre_clip` | core `film-orchestrator` | info | `film_id`, `project`, `shots` | pre-clip dialogue submitted for N lined shots |
| `dialogue.padded` / `dialogue.trimmed` | core `film-orchestrator` | info | `film_id`, `project`, `shot_id`, `seconds` | a line WAV was normalized to the clip bounds |
| `dialogue.silence` | core `film-orchestrator` | info | `film_id`, `project`, `shot_id`, `seconds` | a silence WAV was minted for an unlined shot |
| `dialogue.neighborhood` | core `film-orchestrator` | info | `film_id`, `project`, `shot_id` | unlined shot left to the native-audio backend (no silence minted) |
| `speech.skipped_already_done` | core `film-orchestrator` | info | `film_id`, `project` | speech chain already complete; went straight to finish |
| `finish.presign_skip` / `speech.presign_skip` | core `film-orchestrator` | warn | `shot`, `reason` | best-effort presign for a finish / speech step failed |
| `film.ceiling_undeclared` | core `film-orchestrator` | info | `film_id`, `phase`, `undeclared`, `unresolved`, `holding_floor_seconds` | phase stall ceiling is unbounded against modules with no `max_invocation_seconds` (core#182) |
| `film.doc_corrupt` | core `film-orchestrator` | error | `film_id`, `error` | job doc unparseable; the render is marked failed |
| `film.advance_failed` | core `film-orchestrator` | error | `film_id`, `error` | an advance tick threw; the render is failed with `advance failed: <msg>` |
| `film.submit.deduplicated` | core `film-submit-idempotency` | info | `film_id` (the incumbent), `dropped_film_id`, `entry`, `keyed_by` (`idempotency-key` / `natural-key`), `window_seconds` | a duplicate film submit was folded into the in-flight film |
| `d1.retry` / `d1.exhausted` | core `d1-retry` (`withD1Retry`) | info | `op`, `attempt` / `attempts`, `code` | transient D1 error retried / retries exhausted |
| `authz.deny` | host `src/index.ts` | warn | `route` (template), `method`, `required`, `held` | a route refused the credential's scope (403) |
| `authz.token_scope_invalid` | host `src/auth-gate.ts` | error | `name`, `scope`, `msg` | an `api_tokens` row has no usable scope; denied |
| `router.error` | host `src/index.ts` | error | `route` (template), `method`, `reason` | an unhandled handler throw (500 `internal error`) |
| `auth.allow_unauthenticated` | host `src/access-auth.ts` | info | `msg` | in-Worker auth is disabled (`ALLOW_UNAUTHENTICATED=true`); once per isolate |

## Poll-surface content length (cf#365) -- assemble vs delivered

`GET /api/render/film/:id` / `poll_film` expose two CONTENT-length fields (integer ms, absent =
NOT MEASURED); the pinned vivijure-core projects both on the film summary (`film-model.js`):

| Field | Meaning |
|-------|---------|
| `assemble_ms` | Pre-`film.finish` concat length at the deterministic `renders/<id>/film.mp4` key |
| `output_ms` | DELIVERED length of `film_key` (last writer; same basis as `renders.output_ms`) |

Both are already captured on the job as `film_output_seconds`; this is the read half that lets a
predicted-vs-delivered delta be decomposed without D1. They are **not** wall-clock: CPU finish
capacity is `finish_elapsed_ms` / container `elapsedMs` (cf#268). Plan `duration_seconds` is a third
quantity (requested, not delivered). Non-final tiers are known to deliver clips shorter than plan
(#698), so a gap between plan and `assemble_ms` can be real clip shortfall, not a finish-chain retiming.

## The assemble duration gate (#697) -- a hard fail, not an event

Layer 1 `clip.validate` deliberately does NOT gate on duration (`expected_s` is context-only, since
backends emit a fixed frame count), so a per-shot finish chain that adopts a truncated partial write can
deliver a 0.085s clip for a 4s shot and pass every earlier gate. At **assemble** the core compares each
clip's ACTUAL probed seconds (the per-clip `clipDurations` the video-finish assemble job reports) against its planned seconds and,
below `FILM_CLIP_DURATION_FLOOR` (default 0.5, `0` disables), FAILS the render loud -- honest-failure
#245/#249, never a silent green.

This is a HARD FAIL, so it emits **no dedicated structured event**. Like every #245/#249 per-shot
failure, the reason surfaces on the failed job's `error` string (and the poll view), e.g.:

```
duration gate: 1 shot(s) delivered below 50% of plan: shot_01 0.10s vs planned 4.00s (floor 2.00s)
```

and a matching `console.warn` log line (`film <id>: duration gate: ...`), which the tail labels
`level="warn"` (not `error`). The film then reaches `failed`, so the `film.render.terminal` event
(below) also carries the same `error`. The gate is EVIDENCE-ONLY: a video-finish build that reports
no `clipDurations` leaves it a logged no-op (`console.warn`: `video-finish reported no per-clip
durations; duration gate skipped (redeploy video-finish to arm #697)`), so it can never fail a film
for a missing measurement. Query the failures with `{worker="vivijure-studio"} |= "duration gate"`
(do not add `level="error"`, which would hide them).

## Query recipes (Grafana -> Explore -> Loki datasource)

```logql
# all studio application logs
{worker="vivijure-studio"}

# lines whose text mentions a phase keyword, by label (no text scan; keyword-derived, see Loki labels)
{worker="vivijure-studio", phase="assemble"}

# every film phase transition (parse the structured fields out: double-unwrap, then filter)
{worker="vivijure-studio"} | json | line_format "{{.msg}}" | json | ev="film.phase"

# one film's whole timeline (job_id is a line field, not a label)
{worker="vivijure-studio"} | json | job_id="film-..."

# terminal outcomes only; failed films with their real error
{worker="vivijure-studio"} | json | line_format "{{.msg}}" | json | ev="film.render.terminal" | status="failed"

# anything carrying a given structured field
{worker="vivijure-studio"} |= "keyframes_incomplete"

# errors only (console.error + exceptions); console.warn degrades are level="warn"
{worker="vivijure-studio", level="error"}

# the finish-unavailable degrade (completed-with-clips / silent-film, #519 / #524)
{worker="vivijure-studio"} |= "film.finish_unavailable"

# output-validation verdicts (structural clip gate, #523); a `fail` rejected a corrupt clip before finish spend
{worker="vivijure-studio"} | json | line_format "{{.msg}}" | json | ev="clip.validate"

# Layer 2 content verdicts (#523); a `corrupt` failed a noise clip before finish spend
{worker="vivijure-studio"} | json | line_format "{{.msg}}" | json | ev="clip.content_validate"

# partial-keyframe degrades (#619/#622): films that shipped fewer scenes than planned, loudly
{worker="vivijure-studio"} |= "film.keyframes_incomplete"

# deferred post-start bookkeeping (#695): the film started; a history row / presign lagged a poll
{worker="vivijure-studio"} |= "render.bookkeeping_deferred"
```

```logql
# D1 durability events (#290): withD1Retry retries and exhaustion on the film path (renders-db,
# advance lease, cast LoRA). Healthy = silent. A spike here is the early warning that D1 is flapping.
# (d1.error was the retired scatter submit's swallowed-error line; nothing live emits it now.)
{worker="vivijure-studio"} |~ "d1\\.(retry|exhausted)"
```

## Reaching Loki when it is network-isolated

> Written against the retired reference instance (both hostnames below are NXDOMAIN as of
> 2026-09-27). The TOPOLOGY generalises to any operator running Loki on a private network, which is
> why it is kept rather than deleted; substitute your own hostnames.

Loki and Grafana run self-hosted on the operator's monitoring host, on a private
network. Two facts decide how you query them:

- **Grafana UI is public** at `grafana.skyphusion.org` (cloudflared + Access, same
  pattern as `status.skyphusion.org -> gatus`). From a laptop browser this Just
  Works; it is the default path for a human.
- **Loki itself is network-isolated** (`3100/tcp`, no public port; the tail worker
  pushes to it over the Cloudflare VPC connector, not a public endpoint).

**The caveat:** Loki has no public route, so a host that is not on the monitoring
host's private network has **no direct path** to it (a `curl` to the Loki port
returns `000` / timeout, NOT a worker fault). To query Loki directly you must run
from a host on that private network (or tunnel onto it); from inside, run a
one-shot query against Loki's own docker network:

```bash
# from the monitoring host (or a host on its private network):
docker run --rm --network monitoring_default curlimages/curl:latest -s \
  --data-urlencode 'query={worker="vivijure-studio"}' \
  --data-urlencode since=1h \
  http://monitoring-loki-1:3100/loki/api/v1/query_range
```

If you do not have private-network access, **use the Grafana web UI or the CF
Workers Observability API instead**; both are reachable without it, and CF-obs
already carries the invocation truth (status, timing, cron). Do not read an
unreachable Loki as a missing-logs / broken-pipeline signal; confirm reachability
first.

## Fleet VPC call attribution (`vpc.call`, cf#396)

Four module workers call **our** finishing swarm. They are no longer Workers VPC bindings: each
reaches its container over a public HTTPS door configured by a URL var in the module's
`wrangler.toml`. The event name `vpc.call` (and the `vpc:elapsed_ms=` applied tag) is LEGACY, kept
so existing Loki queries and in-flight applied tags keep matching; the transport is no longer VPC
(`modules/_shared/vpc-call-log.ts` header). A consumer using them spends our capacity the same way a
RunPod path spends our GPU account. cp#288 meters RunPod; until cf#396 nothing recorded wall-clock
start or duration for these fleet hops.

| module | URL var (module `wrangler.toml`) | `service` / `binding` field value |
|---|---|---|
| `film-titles` | `VIDEO_FINISH_URL` | `video-finish` |
| `subtitle` | `VIDEO_FINISH_URL` | `video-finish` |
| `audio-master` | `AUDIO_MASTER_URL` | `audio-master` |
| `beat-sync` | `AUDIO_BEAT_SYNC_URL` | `audio-beat-sync` |

Helper: `modules/_shared/vpc-call-log.ts`. Every real hop emits one structured `console.log` line.
Intermediate async status polls stay silent; only submit + terminal outcomes log. Note the `binding`
field carries the same service-name string as `service` (e.g. `video-finish`), not a binding or var
name.

```
{"ev":"vpc.call","module":"film-titles","service":"video-finish","binding":"video-finish","route":"/async/status/job-abc","mode":"async_poll","outcome":"completed","started_at_ms":1720000000000,"elapsed_ms":12,"job_elapsed_ms":45230,"http_status":200,"container_job_id":"job-abc","film_key":"renders/.../film.mp4"}
```

Optional correlation fields `project` and `context_job_id` appear when the caller passed them.

> **Known deviation (#764, OB-3):** no module `wrangler.toml` in this repo declares
> `tail_consumers`, so these module-worker `vpc.call` lines are NOT shipped to vivijure-tail / Loki by
> the committed config. Since cf#838 the studio core does not ship them either by default: its
> `tail_consumers` line is commented out, so NO worker in this repo is a tail producer out of the box.
> The LogQL below returns nothing unless you run the opt-in tail tier and add the consumer yourself;
> the lines are visible in each worker's own Workers Observability logs (dashboard; every worker here
> ships `[observability] enabled = true`). Reaching Loki is unverified and, on the reference instance,
> now impossible.

| field | meaning |
|---|---|
| `started_at_ms` | wall-clock start of this hop (or of the async job, on terminal poll) |
| `elapsed_ms` | this hop's RTT (submit / sync / terminal poll) |
| `job_elapsed_ms` | async only: submit token time -> terminal observation (fleet wall-clock) |
| `mode` | `sync` \| `async_submit` \| `async_poll` |
| `outcome` | `ok` / `submitted` / `completed` / `failed` / `error` / `unreachable` / `not_found` |

On success the module also appends `vpc:elapsed_ms=N` to `applied` (sync: hop RTT; async: job
wall-clock) so film job applied history carries the same number without a new billing column.

LogQL examples (unwrap twice per the line-shape section above):

```
{worker=~"vivijure-module-.*"} |= `vpc.call`
{worker=~"vivijure-module-.*"} |= `vpc.call` |= `film-titles`
```

### What this is NOT (remaining gap)

This is **module-side observation**, not full metering:

1. **No control-plane / per-tenant ledger.** Hosted-tenant spend attribution for fleet capacity still
   needs a plane ruling (same breath as cp#288). We deliberately do not invent a D1 billing table
   here.
2. **These four are not hosted-tenant reachable today.** They have no `TENANT_MODULE_CATALOG` row
   (bucket D in cf#394). The instrument lands before any catalog row makes the path live. Adding a
   catalog row without a metering decision would re-open the unmetered-consumer hazard this issue
   closed on the module side.
3. **`local-gpu` is out of scope on purpose.** It reaches the user's own hardware; nothing of ours
   to meter. Membership is "whose infrastructure absorbs the cost", not credential shape.
4. **Core paths that also call the same containers** (assemble / mux / beat-analyze on the studio
   Worker) are a separate surface; this ship covers the four *module* hops named in #396.

Requirement for any future catalog proposal: any consumer-reachable path into our infrastructure
must already carry duration + start-time attribution (this helper, or a successor) before the row
lands.

## Direct Loki API (from the monitoring host, no Grafana UI)

Loki has no published host port (it is `3100/tcp`, network-internal on the
monitoring host). Query it from inside its docker network:

```bash
docker run --rm --network monitoring_default curlimages/curl:latest -s \
  --data-urlencode 'query={worker="vivijure-studio"} |= `film.render.terminal`' \
  --data-urlencode 'since=24h' --data-urlencode 'limit=20' \
  http://monitoring-loki-1:3100/loki/api/v1/query_range
```

Label discovery: `.../loki/api/v1/labels` and `.../loki/api/v1/label/<name>/values`.

## When the CF obs API IS the right tool

Use the CF Workers Observability query API / dashboard for: invocation counts,
latency percentiles, status-code distributions, confirming a cron fired (or
stopped firing), and invocation-level exception outcomes. Example: verifying a
`*/N` cron no longer fires is a CF-obs query (filter `$metadata.origin = cron`),
not a Loki query, because that is an invocation event, not an app log.
