# Vivijure Module API

> Status: **IMPLEMENTED** (`vivijure-module/2`; the `/1` window is closed, no longer accepted). The contract the core and modules share. This
> document is the design spec; the canonical TypeScript shape lives in
> `@skyphusion-labs/vivijure-core` (import subpath `@skyphusion-labs/vivijure-core/modules/types`;
> published as `dist/modules/types.d.ts`). Where this prose and that file disagree, the types win;
> file an issue against this doc.

## Why this exists

Vivijure is a **host, not a monolith**. The studio core owns only what is always true (project,
storyboard, cast, the bundle, the render-orchestration spine, and a module registry). Every
*capability* beyond that is an opt-in **module worker** that plugs into the pipeline through a
typed contract.

Not everyone wants cloud rendering. Not everyone wants frame interpolation, or narration, or
lip-sync. So none of it is baked in. You install the modules you want; the studio assembles itself
around them, including its own UI. That is the fix for the old problem (a frontend jammed full of
features most people did not want): the studio can only ever show what is actually plugged in.

It is also the open-source play. Publish the core plus a module SDK under AGPL, and anyone can
write a module: a Kling motion backend, a whisper-captions scorer, a region-specific provider
swap. The community becomes the roadmap instead of one maintainer being the bottleneck for every
feature.

## Concepts (the five nouns)

| Noun | What it is |
|---|---|
| **Core** | This worker (`vivijure-studio`). Owns project/storyboard/cast/bundle/orchestration + the registry and the planner/cast UI. |
| **Hook** | A named extension point in the pipeline with ONE typed input and ONE typed output. The core invokes hooks; it does not know who answers. |
| **Module** | A worker that serves one or more hooks. Ships a manifest + an `invoke` entry point. |
| **Manifest** | A module's self-description: which hooks it serves, what config it exposes, how it surfaces in the UI. |
| **Registry** | The core's index of installed modules, built from their manifests. Drives the pipeline and feeds the frontend. |

## The hooks (vivijure-module/2)

A hook is a contract, not a function. Each has a stable name, a typed input, and a typed output.
Shapes live in `@skyphusion-labs/vivijure-core` (`modules/types`).

| Hook | Purpose | Cardinality |
|---|---|---|
| `keyframe` | Storyboard -> start keyframes. Backend-selectable: GPU SDXL or GPUless cloud (e.g. cloud-keyframe) are modules. | pick one |
| `motion.backend` | Keyframe (+ motion prompt) -> shot clip. GPU/RunPod and cloud providers are modules. | pick one per shot |
| `finish` | Post-process a clip: frame interpolation, color grade, upscale (CUDA Real-ESRGAN), face restore. | chain (0..n, ordered) |
| `score` | Add audio to a film: music, narration, beat-sync. | chain (0..n) |
| `dialogue` | Per-shot dialogue lines -> speech audio (TTS, one voice per cast member). Runs after clips, before finish; its audio becomes the shot's spoken track, and is offered to any finish module that declares `finish_consumes_audio`. | pick one |
| `speech` | Per-shot dialogue AUDIO -> cleaned/enhanced dialogue audio (e.g. speech upscale). Runs after `dialogue`, before `finish`, so the improved track is what the film carries. | chain (0..n) |
| `plan.enhance` | Expand a storyboard before render: LLM auto-direction, camera/lighting enrichment. | chain (0..n) |
| `image.generate` | prompt -> single image | pick one |
| `cast.image` | Portrait + bible -> LoRA training reference images. | pick one |
| `notify` | Film done -> deliver a render-complete notification (email, webhook, ...). | chain (0..n) |
| `master` | Assembled film's audio bed -> mastered audio (music upscale + LUFS loudness). Film-level, runs after the audio mix is built (assemble), before the final mux; fail-safe (a master miss muxes the un-mastered bed). The audio sibling of `finish` (clips) and the dialogue/speech lane (per-shot voice). | chain (0..n) |
| `film.finish` | Assembled + muxed film -> film with opening title / end-credit cards. Post-mux, before done. Runs on both the single-film path (`/api/render/film`) and the scatter/gather finalize (`runScatterFilmFinish`); fail-safe on both. Scatter threads async submit+poll per chain step so a long `film.finish` survives across gather ticks (#602). | chain (0..n) |

`pick one` hooks resolve to a single module (the user's chosen backend). `chain` hooks run every
installed module in a declared order, each consuming the previous output.

**Order.** Every serving module is sorted by `ui.order` ascending (a module with no `ui.order` sorts
as `100`), ties broken by module `name` (`localeCompare`). A `pick one` hook with no explicit choice
resolves to the first module in that order. `finish` is the only chain hook that honours a per-render
participation selection (`SELECTABLE_HOOKS`; see `participation` below); every other chain hook runs
every bound, serving module.

**What a failing step does** (`ok: false`, a contract-violating output, or an unreachable module)
depends on the hook, not on the module:

| Hook | Effect of a failed step |
|---|---|
| `finish` | Transient failures (see "Transient vs deterministic" below) retry, up to 3 attempts per step; a deterministic failure, or retries exhausted, **fails the shot and therefore the render** with the real error (after R2 reclaim). A finish miss is never a silent degrade. |
| `speech`, `master`, `film.finish` | Soft-degrade: the step is recorded as degraded, the input (audio bed / film) passes through unchanged, the chain advances. Never fails the render. |
| `plan.enhance` (via `dispatchChain`) | The failed module is skipped and recorded in `errors`; the chain continues from the last good output. |
| `notify` | Best-effort per notifier; a failure is swallowed and never fails the render. |
| `dialogue` | A submit failure on the pre-clip path fails the film; on the post-clip path the film finishes silent. |
| `keyframe`, `motion.backend` | Fails that phase / shot (motion retries transient provider failures per shot). |

> **Known deviation (#764, MA-13):** `score` is declared `chain`, but no render path folds a score
> chain today. The host invokes exactly ONE score module per request from the planner
> (`src/score-bed.ts`, core `beat-analyze`), classifying modules by which config key they declare:
> `config_schema.prompt` = music bed, `config_schema.text` = narration, `config_schema.clip_seconds` =
> beat analysis (first by `ui.order` unless the caller names one). The generated bed is read from an
> `audio:<r2-key>` tag in `ScoreOutput.applied`, not from `film_key`.

## The module manifest (`module.json`)

Served by the module at `GET /module.json`. The core fetches it when it discovers the module (see
"The registry" below for when that happens and how long it is cached).

```jsonc
{
  "name": "finish-rife",                 // unique module id
  "version": "0.1.2",                    // the MODULE's own release version (free-form, non-empty)
  "api": "vivijure-module/2",            // contract version this module targets (/1 is closed)
  "hooks": ["finish"],                   // which hooks it serves
  "participation": "default",            // REQUIRED by conformance for a `finish` module (cf#537)
  "max_invocation_seconds": 900,         // REQUIRED by conformance for `finish` / `speech` (core#223)
  "provides": [                          // user-facing capabilities (one module may offer several)
    { "id": "interpolate", "label": "Smooth motion (frame interpolation)" },
    { "id": "face_restore", "label": "Relock faces" }
  ],
  "config_schema": {                     // typed knobs; the UI renders these, the core validates them
    "interpolate":          { "type": "bool", "default": true, "label": "Smooth motion" },
    "interpolation_factor": { "type": "int", "min": 1, "max": 8, "default": 2,
                              "label": "Smoothness", "enum_labels": { "1": "off", "2": "2x", "4": "4x" } },
    "face_restore":         { "type": "enum", "values": ["none", "gfpgan"], "default": "none",
                              "label": "Face restore" }
  },
  "finish_artifacts": {                  // SHOULD for finish; see "Declared finish artifacts"
    "output_key": { "kind": "shot_named", "filename": "_finished.mp4" },
    "applied": [
      { "when": { "knob": "interpolate", "equals": false }, "tag": "noop:interpolate-off" },
      { "tag": "interpolate:{interpolation_factor|2}x" }
    ]
  },
  "ui": { "section": "finish", "icon": "wand", "order": 10 }   // hints for the self-assembling UI
}
```

This is a trimmed, lightly relabeled copy of the real `modules/finish-rife` manifest (`MANIFEST` in
`modules/finish-rife/src/index.ts`) and passes `checkManifest`. Drop `participation` or
`max_invocation_seconds` and it still LOADS, but FAILS conformance.

### Manifest field reference

Every field of `ModuleManifest` / `ModuleUi`. "Load" = what `validateManifest` (core
`modules/manifest-validate`) enforces when the registry reads the manifest: a violation REJECTS the
module (it is skipped and logged, never registered). "Conformance" = what `checkManifest` (core
`modules/conformance`) additionally FAILS; a module that fails conformance can still load when
service-bound, but is never installed through the dispatch install gate, and is not done.

| Field | Type | Req? | Load (rejects) | Conformance (fails) |
|---|---|---|---|---|
| `name` | string | yes | missing / empty | |
| `version` | string | yes | missing / empty | |
| `api` | `"vivijure-module/2"` | yes | not a supported api (`/1` no longer accepted) | |
| `hooks` | `HookName[]` | yes | empty, or any unknown hook name | |
| `provides` | `{ id: string; label: string }[]` | no | | an entry missing `id` or `label` |
| `config_schema` | `Record<string, ConfigField>` | no | | bad `type`, bad `scope`, enum with empty `values` or a `default` not in `values`, a `default` whose type does not match `type` |
| `ui` | `ModuleUi` (below) | no | not validated | |
| `participation` | `"default" \| "opt_in"` | no | any other value | ABSENT on a module serving a `SELECTABLE_HOOKS` hook (today: `finish`) |
| `max_invocation_seconds` | number (seconds) | no | not a positive finite number | ABSENT on a module serving a `CEILING_DERIVED_HOOKS` hook (today: `finish`, `speech`) |
| `cancelable` | boolean | no | not validated | |
| `finish_artifacts` | `FinishArtifactsDecl` | no | malformed (see that section) | |
| `finish_consumes_audio` | boolean | no | not validated | |
| `keyframe_label` | string | no | empty / whitespace / non-string | |
| `duration_grid` | `{ fps: number; tiers: Record<string, { max_frames: number }> }` | no | not validated | |
| `usage` | `MotionUsageDecl` | no | present but not a valid `MotionUsageDecl` (needs `native_audio`, `voice`, `scatter_native_audio`, `min_seconds`, `max_seconds`) | |
| `needs_tenant_r2` | boolean | no | not validated | |
| `ui.section` | string | no | | |
| `ui.icon` | string | no | | |
| `ui.order` | number | no | | (absent sorts as `100`) |
| `ui.locality` | `"local" \| "byo" \| "cloud"` | no | | (absent classifies as `cloud`) |
| `ui.cost` | string | no | | |
| `ui.blurb` | string | no | | |
| `ui.limits` | string[] | no | | |

What each optional field means:

- **`participation`** (cf#537): whether the module runs when a render carries NO explicit selection
  for its hook. `"default"` or absent = yes; `"opt_in"` = only when a caller names it in that
  render's selection. Only honoured on `SELECTABLE_HOOKS`. Conformance requires an explicit value so
  "considered, runs by default" is distinguishable from "nobody thought".
- **`max_invocation_seconds`** (core#182 / core#223): the module's OWN enforced wall-clock ceiling for
  one whole invocation, relayed from the guard it actually runs with. The core sizes the phase stall
  ceiling from it. Declare the whole invocation or nothing; never a rate, never an aspiration. An
  absent value is reported (`FilmJob.ceiling_undeclared`, `film.ceiling_undeclared` event), not guessed.
- **`cancelable`**: the module serves `POST /cancel` (see "Async + cancel").
- **`usage`** (`motion.backend`): how the door is actually called (native audio, voice mode, min/max
  seconds, duration steps, first/last frame, seed, voice ref, driving audio). Absent = undeclared.
- **`needs_tenant_r2`**: see `InvokeRequest.r2` under "Invocation contract". Leave absent unless the
  module submits to a pooled RunPod endpoint that needs the tenant's per-job R2 credential.
- **`ui.locality`**: load-bearing, not cosmetic. It drives the planner door tag AND the core's
  local-vs-cloud classification (`cloudMotionModules` / `gpuDoorMotionModules`); every
  `motion.backend` module SHOULD declare it. `ui.cost` / `ui.blurb` / `ui.limits` are display-only
  and omitted from the UI when absent (`limits` falls back to the `config_schema` knob ranges).
- `finish_artifacts`, `keyframe_label`, `finish_consumes_audio`, `duration_grid`: their own sections below.

The `config_schema` is the single source of truth for a module's knobs. The frontend renders the
controls from it; the core clamps/validates against it before invoking. One declaration, one hop,
same words down. No separate override grab-bag.

A field may carry an optional `"scope"`:

- **`"render"`** (the default when omitted): a per-render knob, chosen at submit time, flowing through
  the per-render config path -- the behavior every field has always had.
- **`"install"`**: operator-set-**once**, instance-wide config (e.g. `notify-email`'s `notify_email`
  recipient). The operator sets it on the studio **settings** page; the core persists it in the
  operator-config store and injects it into the module invoke at hook time. The value lives only in
  that store, read/written via `GET/PATCH /api/modules/:name/config` -- it never rides the public
  `/api/modules` projection (only the schema marker does, so the settings UI can render the control).

`scope` is additive: an unmarked field is a `"render"` field, so adding it broke nothing and bumped no
contract version. See CONTRACT.md 4.1.1 / 4.1.2 for the full spec.

> **Known deviation (#764, MA-14):** the core injects stored install-scope values only on the
> `notify` hook (film done-transition and scatter notify). For every other hook an `"install"` field
> is treated like a render field: it arrives at its `default` unless a render config supplies it.

### How `config` is clamped (`validateConfig`)

The `config` a module receives is the output of core `validateConfig(config_schema, userValues)`
(clamp, never throw), so a module never has to defend against junk in DECLARED keys:

| Case | Result |
|---|---|
| Key not declared in `config_schema` | Dropped. |
| Declared key missing | The field's `default`. |
| `int` / `float`, value not a finite number (after `Number(v)`) | `default`. |
| `int` / `float`, below `min` / above `max` | Clamped to `min` / `max`. `int` is then `Math.round`ed. |
| `bool`, value not a boolean | `default` (a string `"true"` is NOT coerced). |
| `enum`, value not in `values` | `default`. |
| `string`, value not a string | `default`. |
| No `config_schema` at all | `{}`. |

At the API door the host is stricter than the clamp: a caller-supplied `motion.backend` config is
checked by `configPreflightViolations` BEFORE any GPU spend and an unknown key, wrong type, or
out-of-range / out-of-set value is a 400 naming what is allowed (#577).

**Host-injected keys (added AFTER the clamp, so they arrive even if undeclared):**

| Hook / call site | Keys the host sets |
|---|---|
| `plan.enhance` from the planner routes | `mode`, `model`, `system_message`, `message` (see the mode table below) |
| `image.generate` (chat image path) | `model` (the module's own catalog id) |
| `score` beat analysis (core `beat-analyze`) | `audio_url`, `audio_key` |

Keys injected BEFORE the clamp (so a module only receives them if it declares them): `quality_tier`
on the chosen `keyframe` module, and `quality` on every `motion.backend` module whose schema declares
`quality`, both set to the render's quality tier. The `dialogue` hook is invoked with `config: {}`
today (no schema defaults are applied).

### How a planning module advertises its models (`config_schema.model`, `plan.enhance`)

The studio hardcodes **no model names**. `GET /api/storyboard/models` -- the planner's model picker --
is PROJECTED from the modules installed against the `plan.enhance` hook. Conrad's ruling (2026-07-17):
*"nothing should be providing model names but plan.enhance."* Anyone can write their own planning
module because they want a different model, and the panel honors it per this contract.

A planning module advertises its models by declaring an **enum field named `model`**:

```jsonc
{
  "name": "acme-planner",
  "api": "vivijure-module/2",
  "hooks": ["plan.enhance"],
  "provides": [{ "id": "acme", "label": "ACME Planning" }],
  "config_schema": {
    "model": {
      "type": "enum",
      "values": ["acme/planner-xl", "acme/planner-mini"],
      "default": "acme/planner-xl",
      "label": "model"
    }
  }
}
```

The projection rules, in full:

- A module declaring `config_schema.model` as an enum contributes **one catalog row per enum value**.
  The row's `id` is the enum value **verbatim**, its `label` is `"<provides[0].label or name> · <id>"`,
  and its `group` is `"Planning · <module name>"`. The emitted row is exactly
  `{ id, label, group, type, capabilities }` -- the same shape vivijure-local emits, because the
  panel that renders it is a verbatim-shared surface between the two hosts. Do not add host-only
  fields here; land a shape change in local first, then port it.
- A module serving `plan.enhance` with **no** `model` enum still appears, as **one row** under its own
  name and label. Not declaring a model list is a valid choice, not an exclusion.
- The chosen id **routes back to the module that declared it**, and is handed to that module as
  `config.model` at invoke time -- so a module only ever receives an id it minted itself.
- With no planning module installed the catalog is **empty**, and that is a correct answer, not an
  error state. Nothing in the studio assumes any particular id exists.

There is **no special-casing of the first-party `plan-enhance` module** anywhere on this path. A
third-party planning module is discovered, listed, and dispatched to identically; the test suite
installs a third-party-shaped module alongside the first-party one and asserts both that its models
appear in `GET /api/storyboard/models` and that choosing one dispatches to **its** worker.

A planning module also receives the planner's three entry points through `config.mode`:

| `config.mode` | input | expected output |
|---|---|---|
| `"plan"`    | `config.message` (the brief + cast prompt); `input.storyboard` is `{ "scenes": [] }`, `input.brief` the raw brief | `output.storyboard` -- a full storyboard |
| `"refine"`  | `config.message` (one delta) + `input.storyboard` | `output.storyboard` -- the revised storyboard |
| `"chat"`    | `config.message` | `output.notes` -- the reply, as a `string[]` (the host joins it with `"\n"`) |
| `"enhance"` (default) | `input.storyboard` | `output.storyboard` -- a director pass over the prompts |

Planner-route invokes carry `context: { "project": "planner", "job_id": "<random uuid>" }`; there is no
real project behind them, so a planning module must not write artifacts under that prefix. The
planner routes do not poll: a planning module must answer inline (`ok: true, output`), never
`pending`. `config.mode` / `model` / `system_message` / `message` are host-injected after the clamp
(see above), so they arrive even though the module does not declare them.

`config.system_message` carries the system prompt for the generative modes. A model MISS on
`plan`/`refine` must degrade honestly (`ok: true`, the input storyboard passed through unchanged, and
a `notes` entry naming what was skipped and why) rather than failing the chain; malformed I/O (a
missing `config.message`) fails loud with `ok: false`.

### `image.generate` model catalog

`image.generate` modules advertise models the same way: an enum `config_schema.model` contributes one
row per value (`type: "image"`, `group: "Image Gen · <module name>"`), and a module with no `model`
enum appears as one row under its own name. The rows are served, together with the planning rows, by
`GET /api/models`. The chosen id is handed back as `config.model`. Unlike planning there is NO
sole-module fallback: an id no installed module declares resolves to nothing (cf#381). The chat image
path invokes with `context.project: "chat"`, does not poll (answer inline), and returns the image
bytes in the output (see the per-hook reference) rather than an R2 key.

## Invocation contract

**Transport.** The core reaches a module by `fetch()`ing it, never by a direct function call: either
over a `MODULE_<NAME>` **service binding** on the studio Worker (the deploy-wired path), or through the
Workers-for-Platforms **dispatch namespace** (`MODULE_DISPATCH.get(<script>)`, installed without a
core redeploy; see `docs/module-dispatch.md`). The URL host is a placeholder (`https://module/...`);
only the path matters. Everything after "got a Fetcher" is identical for both transports. One entry
point per module:

```
POST /invoke
{
  "hook":    "finish",                   // which hook is being asked
  "input":   { ... },                    // the hook's typed input (see the per-hook reference)
  "config":  { ... },                    // the user's values, already clamped vs config_schema
  "context": { "project": "neon", "job_id": "abc" },   // InvokeContext; never secrets
  "r2":      { ... }                     // OPTIONAL TenantR2Config, see below; usually ABSENT
}
->
{ "ok": true,  "output": { ... } }                          // the hook's typed output
{ "ok": true,  "pending": true, "poll": "<token>", "jobId": "<id>" }   // async accept; jobId optional
{ "ok": false, "error": "human-readable reason" }           // a module failure never crashes the core
```

A module is **stateless to the core**: it gets typed input + config, returns typed output. Where it
does the work (its own GPU, a cloud provider, a CPU container) is the module's business.

**Always HTTP 200 + JSON.** A module answers `/invoke` (and `/poll`, `/cancel`) with HTTP 200 and a
JSON envelope, INCLUDING for failures: an unknown/unsupported `hook`, malformed input, or a backend
error is `{ "ok": false, "error": "..." }` with status 200, never a 4xx/5xx or a thrown exception.
The live conformance gate probes exactly this (a bogus hook must come back `200` + `ok:false`). On the
core side (`invokeModule` / `pollModule` / `cancelModule`) anything else is turned into
`ok: false` data, never a crash: an unreachable module (`module unreachable: ...`), a non-2xx status
(`module /invoke -> <status>`), an empty body, a body that is not JSON, a body over **1 MB**
(`MAX_MODULE_RESPONSE_BYTES`), or JSON without a boolean `ok`. Keep outputs small: large payloads
belong in R2 (the one exception, `image.generate`, returns one image and must fit the cap).

**`jobId` (optional, on `pending`).** The module's own backend job id, opaque to the core. The core
records it (e.g. for the keyframe phase) for telemetry and recovery; it never replaces `poll`.

**`r2` (optional, `TenantR2Config`).** The tenant's per-job R2 credential
(`{ endpoint, access_key_id, secret_access_key, bucket }`, all four or the key is absent, never
`null`). The core attaches it ONLY to a module whose manifest sets `needs_tenant_r2: true` AND that is
first-party (service-bound, not a `dispatch:` module), and only on a host that carries a full
credential set; a dispatch/community module never receives it, even if it declares the flag. This
makes the envelope as a whole no longer secret-free (`context` still is). A receiver MUST strip it on
arrival: call core `takeTenantR2(req)` at the top of the handler, which returns the block and
`delete`s it from the request so nothing downstream can log it.

**Artifact keys.** Every R2 key a module RETURNS must be a safe relative key under
`renders/<context.project>/` (core `key-safety`): 1..1024 chars of `[A-Za-z0-9._-/]`, no leading
`/`, no `..` segment, strictly longer than the prefix. The core refuses (`refused key outside
renders/<project>/`) and fails the step for an escaping `keyframe_key`, `motion.backend` `clip_key`,
or `finish` `clip_key`; `KeyframeOutput.trained_loras` values must be under `loras/` or `renders/`.
Other returned keys are expected to follow the same rule.

### Async + cancel

A long-running hook answers `/invoke` with `{ ok: true, pending: true, poll }` and the core POSTs
`{ poll }` to `POST /poll` until it is done. A module doing real backend work (a GPU render) SHOULD
also set `cancelable: true` and serve `POST /cancel { poll }` -> `{ ok: true }` (cancelled, or already
terminal: idempotent) / `{ ok: false, error }`. The module decodes the token to its own backend job id
and cancels with its own creds. Without `/cancel`, a cancelled render or a stall-recovery adopt
ORPHANS the GPU job (it keeps billing after the work is satisfied); the core honest-degrade-logs that
orphan rather than hide it (#327 / #328). Full envelope spec in CONTRACT.md section 4.

This is NOT just for GPU hooks: a CPU-container `film.finish` module (subtitle burn, title cards)
whose encode outlasts a request budget on a long film ALSO answers `pending` + `poll`, so the core
drives submit+poll across ticks and no single request holds the encode open (#602). Such a module
stays FAIL-SAFE -- a poll failure soft-degrades (ships the film uncarded), it never fails the render.

**`POST /poll { "poll": "<token>" }` answers one of (`PollResponse`):**

```
{ "ok": true, "pending": true, "wait": "accepted" | "running" }   // still going; `wait` optional (cf#307)
{ "ok": true, "output": { ... } }                                  // done: the hook's typed output
{ "ok": false, "error": "...",                                     // failed
  "outcome": "backend-error" | "failed" | "gone" | "cancelled",    // optional closed classification (cf#298)
  "runpodStatus": "...", "errorType": "..." }                      // optional, when known
```

`wait` is backend-neutral: `accepted` = the backend has the work but compute has not started (queue /
cold start), `running` = compute underway. Hosts record `outcome` instead of parsing `error` prose;
any value outside the set is ignored.

**Transient vs deterministic failure.** The core classifies an `ok: false` `error` string
(`classifyTransientFailure`) to decide retry vs fail. TRANSIENT (retried, bounded): an HTTP status of
408, 429 or 5xx embedded as `-> <status>` (the core's own transport errors look like
`module /poll -> 503`); text matching `unreachable`, `timeout` / `timed out`, `network`,
`econnreset`, `connection reset|lost`, `fetch failed`; provider load text (`high load`,
`please try again later`, `cannot process your request`, AI Gateway `7003`). Everything else,
including any 4xx other than 408/429 and every module-logic `ok: false` (bad input, "job failed", no
output key), is DETERMINISTIC and is not retried. So: report a genuine, permanent failure plainly; do
not dress a bad-input rejection in transport words, and do not report a real backend blip as a
permanent failure.

**Inline vs `pending`, per call site.** A module may answer `pending` only where the host polls. Today:

| Hook (call site) | May answer `pending`? |
|---|---|
| `keyframe`, `motion.backend`, `finish`, `speech`, `dialogue`, `master`, `cast.image` | Yes (the core polls across ticks). |
| `film.finish` | Yes. Scatter finalize polls across ticks (#602); the single-film path polls in-request (about 40 x 3 s) and then soft-degrades. |
| `motion.backend` cast voice sample | MUST answer `pending` (a synchronous answer is rejected). |
| `plan.enhance` (planner plan / refine / chat) | No: answer inline. |
| `plan.enhance` (`POST /api/storyboard/enhance`, `dispatchChain`) | Tolerated: polled in-request (about 40 x 3 s), then fails. Answer inline. |
| `image.generate` | No: a `pending` answer is rejected. |
| `notify` | No: the host never polls a notifier; answer inline. |
| `score` music / narration bed (planner) | MUST answer `pending` (a synchronous answer is rejected). |
| `score` beat analysis (`config_schema.clip_seconds`) | No: answer inline. |

### Credential readiness (`GET /ready`, optional + additive)

A module that reads a credential from its environment SHOULD serve `GET /ready`:

```
GET /ready
->
{
  "ok": true,                                   // every credential below is readable here
  "module": "keyframe",                         // echoed, so a prober can prove it hit the right script
  "credentials": {                              // BOOLEANS ONLY -- never a value, ever
    "runpod_api_key": true,
    "runpod_endpoint_id": true
  }
}
```

**Booleans only, never values.** This endpoint reports whether a credential is VISIBLE to the code
answering the request; the value itself never appears in the response, which is what makes the
endpoint safe to leave unauthenticated alongside `/module.json`.

**Why it exists (cf#114).** In a hosted deployment the module worker and its credentials arrive by
different routes at different times: the endpoint id is bound when the script is uploaded, the API
key is written afterwards as a secret. Between those two moments the edge can still serve a version
that cannot read the key. Nothing outside the module can observe that: the platform API reports the
secret NAME exists (it does) and cannot say which version the edge serves. Only code running INSIDE
the served version can answer, which is the entire point of the endpoint.

Zero backend cost, identical shape across every module, and no input required -- so a host can probe
readiness without submitting work. The hosted control plane probes it after installing a key and
before flipping a tenant live.

**Honest credential text goes with it.** A module that can tell the two cases apart MUST say which
one it hit:

| endpoint id | api key | what it means | what the module says |
|---|---|---|---|
| present | present | ready | (proceeds) |
| present | absent | the key is configured but this version cannot see it yet | `credential not yet visible on this worker version (retry shortly)` |
| absent | present | the endpoint id binding is missing (the key is fine) | `RUNPOD_ENDPOINT_ID not configured` |
| absent | absent | genuinely unconfigured | `RUNPOD_API_KEY / RUNPOD_ENDPOINT_ID not configured` |

On the proxied route (cf#394) the credential is `RUNPOD_PROXY_TOKEN` and the messages name it instead
of `RUNPOD_API_KEY`. The shared helper is core `runpodCredentialProblem`.

**Additive `/ready` fields the first-party RunPod modules also report** (none of them gates `ok`
unless stated):

- `runpod_proxied: boolean` (cf#394): which route answered (the plane proxy vs a direct key). The
  `credentials.runpod_api_key` field keeps its name on both routes, because the control plane refuses
  a `/ready` that omits it.
- `telemetry: { "job_log": "ok" | "unavailable" | "unknown" }` (cf#279 / cf#284): can this worker
  RECORD a job outcome. `unknown` means could-not-measure (probe error or 1.5 s timeout), never
  healthy. Informational only.
- `door: { "bound": true, "token": boolean, "route": string, "routes": [{ "name", "token" }] }`
  (cf#612): present ONLY when an on-iron door is bound. On the door arm `ok` is the door's readiness
  (at least one usable door), not the RunPod credentials. The control plane classifies a `/ready`
  answer with core `classifyReadyResponse` (`module-ready`).

A polish module that soft-degrades rather than failing carries the same distinction in its degrade
reason (`runpod-key-not-yet-visible` vs `no-runpod-secrets`), so the honest-degrade record does not
itself carry the lie.

### Binding readiness (`GET /ready` `bindings` field, optional + additive, cf#295)

A module whose real work depends on a piece of wired infrastructure (a Workers service binding such as
an EMAIL send binding, or a configured CPU-container base URL such as `VIDEO_FINISH_URL`) rather than
a Secrets Store credential reports its presence the same way, in a sibling field kept separate from
`credentials`:

```
GET /ready
->
{
  "ok": true,
  "module": "film-titles",
  "bindings": { "video_finish_url": true }
}
```

Same discipline, same reason it exists: an operator (or a hosted control plane) can ask whether a
module's binding is actually wired without submitting a render. `credentials` and `bindings` are kept
apart because they answer different questions -- a credential can leak a VALUE if handled carelessly
(hence booleans only); a binding has no value to leak, but conflating the two fields would blur
"secret configured" with "infrastructure wired," which are different failure modes with different
fixes (rotate a secret vs. add a binding to `wrangler.toml`).

**`ok` reflects what the code actually requires, read from its own hard-fail guards, never a default.**
Some modules hard-fail without their binding (a `film.finish` module passthroughs the film degraded
rather than failing the chain, but `/ready` still reports `ok:false` -- the SPEECH-UPSCALE precedent:
an opt-in feature being off by default does not make "can this feature ever fire" uninteresting).
Others hold a credential that only unlocks an optional, better path with a real fallback (`plan-enhance`
falls back to a free local model; several AI-Gateway-adjacent modules run their default model directly,
gateway-bypassed) -- for those, the credential is reported but never gates `ok`, the same "informational,
not gating" discipline `telemetry.job_log` already established: report what you can see, never invent a
verdict for a case this endpoint cannot determine (e.g. a credential a module needs only for a
config-dependent model choice `/ready` has no way to know the caller will pick).


### Declared finish artifacts (`finish_artifacts`, optional + additive)

A `finish` module SHOULD declare its artifact conventions in the manifest so the core's
R2-authoritative recovery (a step whose backend job was GC'd or froze mid-chain, #141/#166) can
predict the module's output key and reconstruct its `applied` marker FROM THE MANIFEST -- the core
never pattern-matches module names to guess conventions. Two shapes:

```ts
finish_artifacts: {
  // How the module names its output clip in R2, one of:
  output_key: { kind: "shot_named", filename: "_finished.mp4" }   // renders/<project>/clips/<shot_id><filename>
  output_key: { kind: "append_suffix", suffix: "_ls" }            // input clip key + suffix before its extension
  // Optional rules reconstructing `applied` from the validated config; FIRST match wins. `when`
  // gates a rule on a knob equaling a literal; {knob|default} in a tag reads the knob (else default).
  applied: [
    { when: { knob: "interpolate", equals: false }, tag: "noop:interpolate-off" },
    { tag: "interpolate:{interpolation_factor|2}x" },
  ]
}
```

Tag templates: `{knob}` is replaced by the knob's value, or by the empty string when the knob is
absent; `{knob|default}` uses `default` when absent. Only `[A-Za-z0-9_]` knob names are substituted
(anything else in braces is copied literally), and a template is truncated at 512 characters. When
`applied` rules are declared but none matches, or no rules are declared (subject to the legacy
fallback noted below), an R2-adopted step is marked `<binding>:r2-adopted` so the adoption is never
silent. Declare rules that mirror your module's real `applied` tags.

**The declaration also gates presigned transport.** The core attaches the presigned finish transport
(`video_url`, `output_url`, `output_key`, plus `audio_url` for a dialogue shot and `hash_url` when
`output_hash` is set; see `FinishInput`) ONLY when it can predict the step's output key, i.e. only
when the module declares `finish_artifacts`. A credential-less module (every dispatch/community module:
it holds no R2 binding of its own) MUST declare it, or it receives keys it cannot read and nowhere to
write. The presign is all-or-nothing and best-effort: if any leg fails the input stays key-only
(`clip_key` / `audio_key` are always kept). The finish `output_key` convention MUST produce a key under
`renders/<context.project>/`.

A finish module WITHOUT the declaration gets no R2 shortcut: its stuck steps pend to the hard
deadline honestly instead of the core guessing where its output landed. Present-but-malformed
`finish_artifacts` REJECTS the manifest at registration (non-object; missing `output_key`; unknown
`output_key.kind`; empty `filename` / `suffix`; `applied` not an array; a rule without a non-empty
`tag`; a `when` without a non-empty `knob` or without `equals`).

> **Known deviation (#764, MA-8):** for a finish module that declares NO `finish_artifacts`, core
> `finishStepOutputKey` / `finishStepAppliedTag` (`film-model`) still fall back to matching the binding
> name (`RIFE`, `LIPSYNC`, `UPSCALE`) to guess the legacy first-party conventions, and that
> guess also drives presigning. The contract above ("never pattern-matches") is the rule; do not rely
> on the fallback.

### Keyframe display label (`keyframe_label`, optional + additive)

A `keyframe` module MAY declare `keyframe_label`: a compact display token for the keyframe-stage
backend or model (e.g. `"SDXL"`). The planner UI is a projection of the registry, so it reads this
token and renders it inline (the regen confirm, the keyframes-only badge, the "no `<label>` keyframe
pass" copy) instead of hardcoding a model name that would drift. The frontend picks the token from the
`ui.order`-first keyframe module that declares one and falls back to `"SDXL"` when none does, so the
copy is never blank.

```jsonc
{ "hooks": ["keyframe"], "keyframe_label": "SDXL" }
```

Leave it out when the model is not a single fixed name (e.g. a user-selectable model enum): an
undeclared label is honest, and the fallback covers the copy. `keyframe_label` is OPTIONAL and
additive (no MODULE_API bump); present-but-empty-or-non-string REJECTS the manifest at registration.

### Dialogue-aware finish order (`finish_consumes_audio`, optional + additive)

A `finish` module MAY declare `finish_consumes_audio: true` to say it drives its output from the
shot dialogue audio (`FinishInput.audio_key`) and is calibrated to the SOURCE frame rate, i.e. it
lip-syncs. NOTE: since cf#783 removed finish-lipsync, NO module shipped in this repo declares
`finish_consumes_audio`. The mechanism is live in vivijure-core and the contract below is
unchanged; there is simply no shipped implementation to read it off, so a new audio-consuming
finish module is the first thing that will exercise it again.
The core reads this (never a module name) to run such a module FIRST in the finish chain
for a shot that HAS a dialogue line, so it lip-syncs the native-fps clip BEFORE any interpolation.
Without it, a lip-sync run on already-interpolated footage smears the mouth shapes across the doubled
frames (the breathy look, vivijure #584).

The rule is a STABLE partition of the chain: audio-consuming modules move ahead of the rest, `ui.order`
preserved within each group. Worked with `finish-rife` (order 10), a hypothetical
audio-consuming finish module (order 15,
`finish_consumes_audio`), and `finish-upscale` (order 20):

- a shot WITH a dialogue line runs the audio-consuming module -> `finish-rife` -> `finish-upscale`;
- a shot with NO line keeps the plain `ui.order` (`finish-rife` -> the audio-consuming module -> `finish-upscale`),
  where the core does not invoke the audio-consuming step at all and records it as `noop:no-dialogue`.

```jsonc
{ "hooks": ["finish"], "ui": { "order": 15 }, "finish_consumes_audio": true }
```

The module declares only its OWN nature; the cross-module ordering policy lives in the core. Because
the reorder changes each step INPUT clip, the `#583` step-input provenance hash
(`finishStepInputHash`, CONTRACT.md 3.3.1) differs across the two orderings on its own, with no
special-case. `finish_consumes_audio` is OPTIONAL and additive (no MODULE_API bump); absent/false =>
the chain folds purely in `ui.order`.

### Fixed duration grid (`duration_grid`, optional + additive)

A `motion.backend` module whose engine renders on a FIXED duration grid (a pinned output fps plus
per-quality-tier frame ceilings, e.g. CogVideoX: 8fps, every tier fixed at 49 frames) MAY declare the
grid so the core can warn AT STORYBOARD TIME that a shot's planned seconds will be clamped, instead
of the clamp staying silent until the clip lands short (vivijure #707). A tier's maximum deliverable
seconds is `max_frames / fps`. Tier keys match the render quality tiers the module accepts.
The `local-gpu` module also uses the active tier's declared `fps` and `max_frames` when it submits to
that fixed-grid door; it does not derive an unsupported intermediate shape from `seconds * fps`.

```jsonc
{
  "hooks": ["motion.backend"],
  "duration_grid": {
    "fps": 8,
    "tiers": { "draft": { "max_frames": 49 }, "standard": { "max_frames": 49 }, "final": { "max_frames": 49 } }
  }
}
```

The module RELAYS what its backend actually enforces (e.g. read from the backend's own health/info
endpoint, best-effort) -- it must never fabricate a grid, and it declares nothing when the backend
has no fixed grid (a flexible engine like LTX simply omits the field). The core's preflight compares
each shot's planned seconds against the selected tier's ceiling and emits a WARNING per clamped shot
(never an error: clamping is legitimate behavior; silence was the bug). `duration_grid` is OPTIONAL
and additive (no MODULE_API bump); absent => no declared constraint, no preflight check.

## Worked example: the `finish` hook

This is the whole contract for one hook, end to end. It is also the first real module.

### Types (canonical TS shapes)

```ts
// What the core hands a finish module: a rendered clip and what is known about it. The clip is
// self-describing (a finish backend probes it), so every hint below is OPTIONAL: the core passes
// it when it has it, and a finish module must not require it.
interface FinishInput {
  shot_id: string;
  clip_key: string;          // R2 key of the input clip (mp4); ALWAYS present, even when presigned
  audio_key?: string;        // the shot's dialogue audio (a lip-sync module drives the mouth from it)
  src_fps?: number;          // SOURCE hints: omitted when unmeasured, never guessed
  frames?: number;
  width?: number;
  height?: number;
  delivery_width?: number;   // the DELIVERY target (the film path always supplies it); pick a scale
  delivery_height?: number;  //   that does not undershoot it
  output_hash?: string;      // opaque step-input provenance hash (#583); write it to `<output_key>.hash`
  // Presigned transport, attached ONLY when the module declares `finish_artifacts` (see above):
  video_url?: string;        // presigned GET of clip_key
  output_url?: string;       // presigned PUT for the finished clip ...
  output_key?: string;       //   ... at this key (return it as FinishOutput.clip_key)
  audio_url?: string;        // presigned GET of audio_key (dialogue shots)
  hash_url?: string;         // presigned PUT for `<output_key>.hash` (when output_hash is set)
}

// What a finish module returns: the processed clip plus what it did.
interface FinishOutput {
  shot_id: string;
  clip_key: string;     // R2 key of the FINISHED clip (may equal input if it no-op'd)
  out_fps: number;
  frames: number;
  applied: string[];    // e.g. ["interpolate:2x", "face_restore:gfpgan"]
  degraded?: string;    // honest soft-degrade reason (a pass that could not run); non-empty string only
}
```

Presigned URLs live 30 minutes. A module that prefers URLs selects on their presence, but must not
require `clip_key` / `audio_key` to be absent.

**CSAM refusal (a HARD FAIL, never a degrade).** A finish module that refuses content on the CSAM
bright line returns its normal `FinishOutput` shape with a reason containing `csam` (case-insensitive)
in `degraded` or in an `applied` tag. The core (`finishOutputIsCsamRefusal` in core `film-model`)
detects that and FAILS the shot with the reason; it is never folded in as a polish miss.

Invariant for `finish`: every clip in one render is processed with the SAME config, so all outputs
share fps + codec and the off-GPU concat stays a stream-copy (no re-encode). The module enforces
this; the core passes one config for the whole render.

### The module's job

1. Read `clip_key` from R2.
2. Apply the configured passes (RIFE interpolation, then/or face restore), best-effort: a pass
   whose model is unavailable is skipped, not fatal.
3. Write the finished clip back to R2, return `FinishOutput`.

The render engine for this lives on the GPU side (the `finish.py` module already drafted in
`vivijure-backend`); the module worker is the thin contract wrapper around it.

### Conformance

The conformance checks are published in core, import subpath
`@skyphusion-labs/vivijure-core/modules/conformance` (not in this repo):

- `checkManifest(raw)`: the `module.json` (see the "Conformance" column of the manifest field reference).
- `checkInvokeResponse(raw)`: the `{ ok, ... }` envelope (`ok:true` + `output`, `ok:true` + `pending`
  + string `poll`, or `ok:false` + string `error`).
- `checkCancelResponse(raw)`: the `/cancel` envelope.
- `checkHookOutput(hook, output)`: the typed PAYLOAD a success returns, against the REQUIRED output
  fields in the per-hook reference below (optional fields are not demanded). This matters because
  the envelope and the payload are two different promises: `{ ok: true, output: {} }` is a
  well-formed envelope and still not a `FinishOutput`. The core runs the same check at runtime
  (`hookOutputViolation`) on every resolved output and fails / degrades the step on a violation.
- `runLiveConformance(fetcher)`: the dispatch INSTALL gate (`docs/module-dispatch.md` 4.3): manifest,
  a first-hook `/invoke` probe (typed output checked only if it answers inline), and a bogus-hook
  probe that must return HTTP 200 + `ok:false`. A dispatch module is installed only if every check
  passes. It does NOT poll async jobs, so an async hook's typed output is the module's own CI's job.

`npm run conformance` runs `tests/conformance.test.ts` (the shape checks) and
`tests/conformance.live.test.ts` (a live module). The live spec is opt-in: point it at a deployed
module to verify its `module.json`, an HTTP 200 well-formed `invoke` envelope for its first hook (and
the payload when it answers inline), and the bad-hook degrade, end to end:

```
MODULE_URL=https://my-module.example.workers.dev npm run conformance
```

**Expected behavior the harness does NOT check** (a `finish` module must still do it, and its own
tests should prove it):
- `applied` reflects the config it was given,
- the clip's duration is preserved (interpolation changes fps + frame count, never length),
- a pass whose model is unavailable degrades to a no-op with a `degraded` reason instead of erroring,
- under an empty / all-default config that enables no pass, the input passes through unchanged.

Green means the module plugs into ANY Vivijure deployment. This is what keeps the ecosystem
trustworthy: implementing the interface is not enough, you have to pass the contract.

## Per-hook I/O reference

The canonical shapes are the `*Input` / `*Output` interfaces in core `modules/types`; the fuller
per-hook semantics (who calls it, when, what the core does with the result) are in `docs/CONTRACT.md`
section 3. "Req" marks what the core always sends (inputs) or what `checkHookOutput` enforces
(outputs); a missing required output field is a contract violation (the step fails or degrades per
the hook's failure policy). Optional output fields are validated only when present, as noted.

**`keyframe`** (pick one; project-level pass, one job for every shot)

| | Field | Req | Notes |
|---|---|---|---|
| in | `project` | yes | R2 prefix |
| in | `bundle_key` | yes | the project bundle |
| in | `shot_ids` | no | subset (parallel keyframe shards) |
| in | `pretrained_loras` | no | `slot -> R2 key` of already-trained cast LoRAs |
| out | `project` | yes | string |
| out | `keyframes[]` | yes | each `{ shot_id, keyframe_key }`, both strings; key under `renders/<project>/` |
| out | `trained_loras` | no | if present an object of string R2 keys (`loras/` or `renders/`) |

**`motion.backend`** (pick one per shot)

| | Field | Req | Notes |
|---|---|---|---|
| in | `shot_id`, `keyframe_url`, `prompt`, `seconds` | yes | `keyframe_url` is presigned |
| in | `keyframe_key`, `last_keyframe_url`, `last_keyframe_key`, `voice_ref_url`, `voice_ref_key`, `audio_url`, `audio_key` | no | end frame (first/last), voice reference clip, driving line audio |
| out | `shot_id`, `clip_key` | yes | strings; `clip_key` under `renders/<project>/` |
| out | `fps`, `frames` | yes | finite numbers |
| out | `has_audio`, `distilled` | no | booleans; omit rather than fabricate |

**`finish`** (chain): see the worked example above (`FinishInput` / `FinishOutput`). Required out:
`shot_id`, `clip_key` (strings), `out_fps`, `frames` (numbers), `applied` (`string[]`).

**`dialogue`** (pick one; one batch per film)

| | Field | Req | Notes |
|---|---|---|---|
| in | `project` | yes | R2 prefix |
| in | `lines[]` | yes | each `{ shot_id, text, voice_id? }` |
| out | `project` | yes | string |
| out | `audio[]` | yes | each `{ shot_id, audio_key, voice_id }` all strings, `duration_s?` number |
| out | `applied` | yes | `string[]` |

**`speech`** (chain, per shot; polish, never fails the render)

| | Field | Req | Notes |
|---|---|---|---|
| in | `shot_id`, `audio_key` | yes | |
| in | `audio_url`, `output_url`, `output_key` | no | presigned GET / PUT when the host can presign |
| out | `shot_id`, `audio_key` | yes | strings; on a soft-degrade return the INPUT `audio_key` |
| out | `applied` | yes | `string[]`; no fake tag on a degrade |
| out | `degraded` | no | reason string |

**`plan.enhance`** (chain; answer inline)

| | Field | Req | Notes |
|---|---|---|---|
| in | `storyboard` | yes | `{ scenes: [{ prompt, ... }], ... }`; preserve every field you do not rewrite |
| in | `brief` | no | |
| out | `storyboard` | yes | an object with a `scenes` array |
| out | `notes` | no | `string[]` |

**`image.generate`** (pick one; answer inline)

| | Field | Req | Notes |
|---|---|---|---|
| in | `prompt` | yes | |
| in | `negative_prompt`, `refs` (data URLs), `width`, `height` | no | |
| out | `image.bytes_b64` | yes | non-empty RAW base64 (a `data:` prefix is a violation) |
| out | `image.mime` | yes | non-empty, the real mime of the bytes |

**`cast.image`** (pick one)

| | Field | Req | Notes |
|---|---|---|---|
| in | `cast_id` (number), `portrait_url` (presigned) | yes | |
| in | `portrait_key`, `source_urls`, `bible`, `art_style` | no | |
| out | `cast_id` | yes | number |
| out | `images[]` | yes | each `{ key, mime }` strings (already written to R2) |
| out | `applied` | yes | `string[]` |

**`score`** (see the MA-13 note under "The hooks" for how the host calls it today)

| | Field | Req | Notes |
|---|---|---|---|
| in | `film_key`, `seconds` | yes | |
| in | `storyboard` | no | mood / tempo context |
| out | `film_key` | yes | string |
| out | `applied` | yes | `string[]` (the planner bed reads `audio:<r2-key>` from it) |
| out | `degraded` | no | string if present |

**`notify`** (chain; terminal side effect; answer inline)

| | Field | Req | Notes |
|---|---|---|---|
| in | `event` (`"render.complete"`), `film_id`, `project` | yes | |
| in | `download_url`, `seconds` | no | `download_url` is a presigned GET of the film |
| out | `delivered` | yes | `string[]`; empty (never an error) when there is nothing to deliver |

**`master`** (chain; film-level audio bed; fail-safe)

| | Field | Req | Notes |
|---|---|---|---|
| in | `film_id`, `audio_key`, `audio_url`, `output_url`, `output_key` | yes | presigned GET of the bed, presigned PUT at `output_key` |
| in | `seconds` | no | |
| out | `audio_key` | yes | string; the INPUT key on a soft-degrade |
| out | `applied` | yes | `string[]` |
| out | `degraded` | no | reason string |

**`film.finish`** (chain; post-mux cards / subtitles; fail-safe)

| | Field | Req | Notes |
|---|---|---|---|
| in | `film_key`, `video_url`, `output_url`, `output_key`, `captions[]`, `sidecar_url`, `sidecar_key` | yes | presigned GET / PUT; `captions` may be empty |
| in | `width`, `height`, `fps`, `title { text, subtitle? }`, `credits { lines[] }`, `meta_url`, `meta_key` | no | no title / credits => pass the film through |
| out | `film_key` | yes | string; the INPUT key on a passthrough, never omitted |
| out | `applied` | no | `string[]` if present |
| out | `degraded` | no | string if present (set only when the film shipped uncarded) |
| out | `prepend_seconds` | no | finite number `>= 0` if present |
| out | `duration_seconds` | no | finite number `> 0` if present |
| out | `elapsed_ms` | no | |

## The registry + the self-assembling frontend

There is no boot step (a Worker has no boot). The registry is built lazily by core `discoverModules`
when a request needs it, from two sources merged into one list:

- **Service bindings:** every `MODULE_<NAME>` env binding that is a Fetcher (the `MODULE_DISPATCH`
  namespace excluded). Each manifest is read with a 3 s timeout, up to 3 attempts (retrying 408 / 429
  / 5xx / network errors, not other 4xx); an unreachable or invalid module is skipped and logged, never
  poisoning the registry. This scan is cached per isolate (30 s by default; `GET /api/modules` and
  the planner use 60 s), and a scan that did not return every bound module is not cached. So a
  manifest change on a service-bound module can take up to that TTL to show.
- **Dispatch (WfP):** the enabled rows of the D1 `installed_modules` table, re-read on every call.
  The manifest used is the SNAPSHOT stored at install time (after the conformance gate), not a live
  fetch; changing a dispatch module's manifest means reinstalling it. On a name collision the service
  binding wins.

Then:

- **Pipeline:** at each hook, the core invokes the installed module(s). `pick one` hooks use the
  user's choice (else the first by order); `chain` hooks fold every module in `ui.order` (default
  100, ties by name; the `finish` chain applies one dialogue-aware exception -- see
  `finish_consumes_audio` above -- and honours `participation`).
- **Frontend:** the core serves `GET /api/modules` (the merged manifests). The studio UI renders
  ONLY the sections, controls, and providers that are actually installed. A bare deploy is a lean
  studio; installing `finish-rife` makes the "Smooth motion" control appear, nowhere hardcoded.

```
GET /api/modules
{
  "api": "vivijure-module/2",
  "modules": [ { "name": "finish-rife", "hooks": ["finish"], "provides": [...], "config_schema": {...}, "ui": {...} } ],
  "hooks": { "finish": ["finish-rife"], "motion.backend": ["own-gpu"] },
  "catalog": [ { "name": "finish", "blurb": "interpolation / upscale / face restore", "cardinality": "chain", "order": 80 } ],
  "render": { "quality_tiers": [ { "value": "...", "label": "...", "blurb": "..." } ], "default_tier": "..." },
  "host": { "dispatch": false },
  "studio_release": "<release>"
}
```

- `modules`: each manifest as served (the internal `binding` ref is stripped; topology never leaves
  the core). `hooks`: hook -> module names, in fold order.
- `catalog`: EVERY hook (installed or not) with its `blurb`, `cardinality` (`pick_one` | `chain`) and
  display `order`; the UI renders the pipeline panel from it. `render`: host-owned render config
  (quality tiers, see CONTRACT.md 2.3.1).
- `host` (optional, the host describing itself): `dispatch` (this deploy binds the WfP namespace),
  and when relevant `hooks_unavailable` (hook -> reason the UI prints verbatim, cf#98),
  `abuse_report_url` (only when the operator set one), and on demo deploys `readonly: true`,
  `render.available`, `assistant`.
- `studio_release` (cf#287) is the studio build identity: `env.STUDIO_RELEASE` when bound, else the
  baked `package.json` version. Optional `git_sha` appears only when `env.STUDIO_GIT_SHA` is set.
  Module manifest `version` strings do not substitute for this: each is that module's own release
  version (and `api` is the contract version), neither is the studio build.

## Contributor flow

1. Start from the 4-file module template in `docs/module-authoring.md` (a minimal worker that serves
   `GET /module.json` and `POST /invoke`, plus a vendored copy of the `vivijure-module/2` shapes you
   use, or an import of `@skyphusion-labs/vivijure-core/modules/types`). There is no separate
   template repo to clone.
2. Implement one hook: answer `POST /invoke` with the envelope above (always HTTP 200 + JSON).
3. `npm run conformance` (with `MODULE_URL` pointing at your deployed worker) until green.
4. Install it: add a `MODULE_<NAME>` service binding to the studio's `wrangler.toml` and redeploy, or
   (on a WfP-enabled host, shipped in v0.8.0) upload it to the dispatch namespace and install it,
   which runs the conformance gate and needs no core redeploy (`docs/module-dispatch.md`).

That is the whole barrier to entry. One hook, one green suite.

## Rollout

- **Phase 0 (done, v0.1.0):** contract + registry + self-assembling UI shell.
- **Phase 1 (done, v0.2.0):** render API migrated behind hooks; reference modules bound at deploy;
  planner/cast/library routes live in this worker.
- **Phase 2 (done for production cutover):** `vivijure.skyphusion.org` points here; render + planner
  stripped from `skyphusion-llm-public`. Optional polish (render SSE stream, further core extraction)
  remains fair game.
- **Phase 3 (done, v0.8.0):** Workers for Platforms / dynamic dispatch so a module installs without
  redeploying the core (opt-in, paid; a standard self-host never needs it). The frontend is already a
  projection of the registry, so it needed no change.

## Non-goals (v1)

- No module-to-module calls. Modules talk only to the core, through hooks. (Keeps the graph a star,
  not a web.)
- Dynamic install shipped in Phase 3 (WfP dynamic dispatch, v0.8.0); it is opt-in and paid, and the
  default self-host still binds modules at deploy.
- Capabilities beyond the render spine belong in modules, not inlined in the core.
