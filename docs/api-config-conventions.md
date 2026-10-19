# Studio API config-passing conventions (cf#390)

**Why this page exists.** The studio has **four different shapes** for "module config on an HTTP
body." Each is individually coherent and has history. Many shape guesses do not 400: keys that
do not reach the module are dropped or clamped to schema defaults, and the job still succeeds with a
real artifact. That is the expensive failure mode (three wrong-shape incidents in one session, all
silent; cf#390). Since then some doors reject the common wrong shapes up front (shape B map shape
#696 + unknown finish modules cf#593, `motion_config` #577, install config #387); each section below
says which wrong shapes still pass silently and which `400`.

This page is the **written preferred-shape map**, not a rewrite of the doors. Converging the shapes
is an API break and is deliberately out of scope here. Rejecting unknown keys at every door is the
same ask as #387 and is not bundled with this doc.

**Drift guard:** `tests/api-config-conventions-390.test.ts` pins the four call sites so a silent
shape change fails CI.

---

## The four conventions

| # | Surface | Shape | Where the code reads it |
|---|---------|-------|-------------------------|
| A | `POST /api/render/film` (`hStartFilm` / MCP `submit_film`) -- `keyframe_config`, `motion_config` | **FLAT** knob map: `{ quality_tier: "draft", ... }` (scalars at the top level) | `src/index.ts` `hStartFilm` `configMaps` entries with `deep: false`, checked by `checkRenderRequestShape` / `moduleConfigMapError` in `src/render-door.ts` |
| B | Same door -- `finish_config`, `speech_config`, `film_finish_config`, `master_config` | **NESTED** per-module map: `{ [moduleName]: { knob: value } }` | same `configMaps` with `deep: true`; unknown finish modules rejected by `finishSelectPreflightError` (`src/render-door.ts`, via `preflightRenderModules`) |
| C | `POST /api/storyboard/score-bed` (alias `/music-generate`) | Nested **`config`** object beside top-level fields (`kind`, `prompt`, `module`, ...) | `hScoreBedGenerate` -> `startScoreBedGenerate({ config })` |
| D | `POST /api/audio/analyze` | **Top-level camelCase** fields (`clipSeconds`, `mode`, `forceShots`, ...), **no** `config` object | `hAudioAnalyze` -> `analyzeAudioBeats(env, a, ...)` |

Rules of thumb when writing a client:

1. **Film submit configs:** if the field name ends in `_config` and is not `keyframe_config` /
   `motion_config`, it is shape B (per-module). Keyframe and motion are shape A (flat knobs).
2. **Score / music bed:** put module knobs under `config`. Do not flatten them next to `prompt`.
3. **Audio analyze:** put knobs at the **top level in camelCase**. Nested `{ config: { mode } }` or
   snake_case (`clip_seconds`) is silently ignored; the module runs on schema defaults
   (`mode: "beat"`, `clipSeconds: 8`, ...).

---

## Shape A -- flat knob map (`keyframe_config`, `motion_config`)

```json
{
  "bundle_key": "bundles/demo/bundle.tgz",
  "scenes": [{ "shot_id": "s1", "prompt": "...", "seconds": 4 }],
  "motion_backend": "own-gpu",
  "keyframe_config": { "quality_tier": "draft", "seed": 7 },
  "motion_config": { "quality": "draft", "fps": 16 }
}
```

- Values are **scalars** (string / number / bool) at the top level of that object.
- Knob names come from the chosen module's `config_schema` (`GET /api/modules`). In the example,
  `keyframe_config` targets the `keyframe` module (`quality_tier`, `width`, `height`, `steps`,
  `guidance_scale`, `seed`, ...) and `motion_config` targets `own-gpu` (`quality`, `fps`,
  `flow_shift`, `negative_prompt`, `seed`).
- `motion_config` is judged strictly against the chosen backend's `config_schema` at the door
  (#577, core `motionConfigPreflightError` / `configPreflightViolations`): unknown key / out-of-set
  enum / out-of-range / wrong type -> `400` **before** GPU spend, e.g.
  `motion_config rejected by "own-gpu" before any GPU spend: unknown key "resolution" (declared keys: quality, fps, flow_shift, negative_prompt, seed).`
- `keyframe_config` has **no** such preflight: it is only clamped by `validateConfig` at invoke time,
  which reads the schema's declared keys and ignores everything else.
- Shape check only: present non-object -> `400` (#696). Omitted is fine.

**Wrong (400):** nesting `motion_config` under a module name, e.g.
`motion_config: { "own-gpu": { "quality": "draft" } }`. The #577 preflight sees an undeclared key and
bounces: `motion_config rejected by "own-gpu" before any GPU spend: unknown key "own-gpu" (declared keys: ...).`

**Wrong (silent):** the same nesting on `keyframe_config`, e.g.
`keyframe_config: { "keyframe": { "quality_tier": "draft" } }`. It passes the shallow shape check,
there is no keyframe preflight, and `validateConfig` drops the undeclared `"keyframe"` key, so the
keyframes run at schema defaults (`quality_tier: "final"`).

---

## Shape B -- nested per-module map (`finish_*`, `speech_*`, `master_config`)

```json
{
  "finish_config": {
    "finish-upscale": { "scale": 2 },
    "finish-blender": { "preset": "filmic-warm" }
  },
  "film_finish_config": {
    "subtitle": { "mode": "burn" }
  },
  "master_config": {
    "audio-master": { "target_lufs": -14 }
  }
}
```

- Outer key = **module name** (or the chain slot the orchestrator expects).
- Inner object = that module's knobs, from its `config_schema` (e.g. `finish-upscale`: `scale`,
  `model`; `finish-blender`: `preset`; `subtitle`: `enabled`, `mode`, `font`,
  `font_size`, ...; `audio-master`: `target_lufs`, `upscale`, `format`).
- Door shape: top level AND every per-module entry must be plain objects (`deep: true`, #696).
- Subtitle mode (`burn` / `sidecar` / `both`) lives in **`film_finish_config`**, not `finish_config`.
- **Omit `finish_config` on `POST /api/render/film` means no per-shot finish** (cf#386). It is not
  "run rife+upscale at schema defaults". Send `finish_select: { mode: "default" }` to ask for the
  participation set, or name the modules (`finish_select` or the keys of `finish_config`). A named
  module this studio does not serve is `400` (cf#593), not a silent drop. Speech / film.finish /
  master omit rules are unchanged (those maps still run serving modules at defaults).

**Wrong (400):** a flat map `finish_config: { "scale": 2 }`. The `deep: true` shape check requires
every entry to be an object, so the door answers
`finish_config.scale must be a JSON object (a { key: value } map), not a number`. A flat map whose
values happen to be objects (`{ "scale": {} }`) passes the shape check but then names a finish module
that is not serving: `finish module(s) requested but not serving: scale` (cf#593). Both bounce before
any GPU spend.

---

## Shape C -- nested `config` on score-bed

```json
{
  "kind": "music",
  "prompt": "sparse piano, no drums",
  "module": "music-gen",
  "seconds": 32,
  "config": { "is_instrumental": true, "format": "mp3" }
}
```

- Route-level fields: `kind`, `prompt` / `text` / `storyboard`, `module`, `seconds`.
- Module knobs: only under **`config`**. Forwarded into `validateConfig(mod.config_schema, ...)`.
  `music-gen` knobs: `prompt`, `lyrics`, `is_instrumental`, `lyrics_optimizer`, `format`, `bitrate`,
  `sample_rate`.
- The top-level `prompt` (music) / `text` (narration) **overwrites** `config.prompt` / `config.text`
  (`startScoreBedGenerate` in `src/score-bed.ts`). Music requires a non-empty top-level `prompt`
  (`400` `prompt required` from `hScoreBedGenerate`); a `config.prompt` alone is not enough.

**Wrong (silent):** putting knobs next to `prompt` at the top level, or using a second nested
envelope the handler does not read.

Full field table: [CONTRACT.md §2.14](CONTRACT.md).

---

## Shape D -- top-level camelCase on audio/analyze

```json
{
  "audioKey": "beds/demo/bed.mp3",
  "clipSeconds": 6,
  "mode": "duration",
  "forceShots": 8,
  "module": "beat-sync"
}
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `audioKey` | string | required | R2 key |
| `clipSeconds` | number | 8 | **camelCase** |
| `mode` | `"beat" \| "duration"` | `"beat"` | |
| `minSceneS` / `maxSceneS` | number | 2.5 / 12 | beat mode |
| `forceShots` | number | -- | duration mode |
| `module` | string | first beat-sync module | |

Core maps camelCase -> the module's snake_case knobs (`clip_seconds`, `force_shots`) inside
`@skyphusion-labs/vivijure-core` `beat-analyze`. Clients must **not** send snake_case at the HTTP
boundary and must **not** wrap knobs in `config`.

**Wrong (silent), the #390 incident:**

```json
{ "audioKey": "...", "config": { "mode": "duration", "force_shots": 8, "clip_seconds": 6 } }
```

Response still `200` with `mode: "beat"`, `clipSeconds: 8`, `suggestedShots: 1` -- the `??`
fallbacks in the analyze path. Looks like a measured finding that the route discards config; it is
actually the wrong shape.

> **Open question (#764, AC-7):** today the analyze result is nested under `output`
> (`{ ok, output: { mode, clipSeconds, suggestedShots, ... }, module }`), and on the module path the
> fallbacks are the beat-sync module's `config_schema` defaults via `validateConfig`, not the `??`
> fallbacks (those are on the `AUDIO_BEAT_SYNC_URL` path). The observed values are the same.

Full field table: [CONTRACT.md §2.17](CONTRACT.md).

---

## Related doors (not a fifth convention)

| Surface | Shape note |
|---------|------------|
| `POST /api/storyboard/render` `renderOverrides` | Flat bag at the door (`deep: false`); optional nested `renderOverrides.config` for per-module (`deep: true`). Mapped by `mapRenderOverridesToModuleConfigs` into keyframe/motion/finish maps. |
| `PATCH /api/modules/:name/config` | Install-scope body is a flat knob map of install-scope keys. Unknown or render-scope keys (including a nested `{ config: {...} }`) -> `400` `unknown or non-install config keys: <keys> (allowed: <keys>)` (`hPatchModuleConfig`, #387). |
| `POST /api/storyboard/enhance` `config` | Nested `config` object, same idea as score-bed (shape C family). |

---

## What is deliberately NOT done here

- **Unifying the four shapes.** Would break every existing MCP / Slate / panel client. Separate epic.
- **Reject-unknown-keys everywhere.** Cheapest honesty fix for silent drops. Install config already
  rejects unknowns (#387) and film motion does too via #577 preflight. Expanding that to
  `keyframe_config` / analyze / score-bed is a follow-up, not this page.
- **Rewriting analyze to accept nested `config`.** Dual-accept would paper over the inconsistency
  and freeze both forever.

---

## If you add a new config-bearing route

1. Pick **one** of A--D (or the renderOverrides family) and say which in the route handler comment
   and in `docs/CONTRACT.md`.
2. Prefer shapes that already have door-level unknown-key or type rejection (#577 / #696).
3. Extend `tests/api-config-conventions-390.test.ts` with a pin for the new call site.
4. Never invent a fifth silent shape without updating this page in the same PR.
