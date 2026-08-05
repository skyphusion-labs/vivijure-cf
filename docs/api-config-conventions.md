# Studio API config-passing conventions (cf#390)

**Why this page exists.** The studio has **four different shapes** for "module config on an HTTP
body." Each is individually coherent and has history. Guesses about the shape do not 400: keys that
do not reach the module are dropped or clamped to schema defaults, and the job still succeeds with a
real artifact. That is the expensive failure mode (three wrong-shape incidents in one session, all
silent; cf#390).

This page is the **written preferred-shape map**, not a rewrite of the doors. Converging the shapes
is an API break and is deliberately out of scope here. Rejecting unknown keys at every door is the
same ask as #387 and is not bundled with this doc.

**Drift guard:** `tests/api-config-conventions-390.test.ts` pins the four call sites so a silent
shape change fails CI.

---

## The four conventions

| # | Surface | Shape | Where the code reads it |
|---|---------|-------|-------------------------|
| A | `POST /api/render/film` (`hStartFilm` / MCP `submit_film`) -- `keyframe_config`, `motion_config` | **FLAT** knob map: `{ quality_tier: "draft", ... }` (scalars at the top level) | `src/index.ts` `configMaps` entries with `deep: false` |
| B | Same door -- `finish_config`, `speech_config`, `film_finish_config`, `master_config` | **NESTED** per-module map: `{ [moduleName]: { knob: value } }` | same `configMaps` with `deep: true` |
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
  "motion_config": { "resolution": "720p", "camera_fixed": true }
}
```

- Values are **scalars** (string / number / bool) at the top level of that object.
- `motion_config` is judged strictly against the chosen backend's `config_schema` at the door
  (#577): unknown key / out-of-set enum / out-of-range / wrong type -> `400` **before** GPU spend.
- Shape check only: present non-object -> `400` (#696). Omitted is fine.

**Wrong (silent):** nesting under a module name, e.g.
`motion_config: { "own-gpu": { "resolution": "720p" } }`. The nested object is not a declared knob;
preflight / clamp treats it as unknown and the film runs at defaults.

---

## Shape B -- nested per-module map (`finish_*`, `speech_*`, `master_config`)

```json
{
  "finish_config": {
    "finish-upscale": { "scale": 2 },
    "finish-lipsync": { "enabled": true }
  },
  "film_finish_config": {
    "subtitle": { "mode": "burn" }
  },
  "master_config": {
    "audio-master": { "loudness": -14 }
  }
}
```

- Outer key = **module name** (or the chain slot the orchestrator expects).
- Inner object = that module's knobs.
- Door shape: top level AND every per-module entry must be plain objects (`deep: true`, #696).
- Subtitle mode (`burn` / `sidecar` / `both`) lives in **`film_finish_config`**, not `finish_config`.

**Wrong (silent):** a flat map `finish_config: { "scale": 2 }` -- there is no module named by those
keys; the per-module lookup finds nothing and the chain runs on defaults.

---

## Shape C -- nested `config` on score-bed

```json
{
  "kind": "music",
  "prompt": "sparse piano, no drums",
  "module": "music-gen",
  "seconds": 32,
  "config": { "model": "...", "seed": 1 }
}
```

- Route-level fields: `kind`, `prompt` / `text` / `storyboard`, `module`, `seconds`.
- Module knobs: only under **`config`**. Forwarded into `validateConfig(mod.config_schema, ...)`.

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

Full field table: [CONTRACT.md §2.17](CONTRACT.md).

---

## Related doors (not a fifth convention)

| Surface | Shape note |
|---------|------------|
| `POST /api/storyboard/render` `renderOverrides` | Flat bag at the door (`deep: false`); optional nested `renderOverrides.config` for per-module (`deep: true`). Mapped by `mapRenderOverridesToModuleConfigs` into keyframe/motion/finish maps. |
| `PATCH /api/modules/:name/config` | Install-scope body is a flat knob map clamped to install subschema. Unknown keys dropped (#387). |
| `POST /api/storyboard/enhance` `config` | Nested `config` object, same idea as score-bed (shape C family). |

---

## What is deliberately NOT done here

- **Unifying the four shapes.** Would break every existing MCP / Slate / panel client. Separate epic.
- **Reject-unknown-keys everywhere.** Cheapest honesty fix for silent drops, tracked with #387 for
  install config; film motion already rejects unknowns via #577 preflight. Expanding that to
  analyze / score-bed is a follow-up, not this page.
- **Rewriting analyze to accept nested `config`.** Dual-accept would paper over the inconsistency
  and freeze both forever.

---

## If you add a new config-bearing route

1. Pick **one** of A--D (or the renderOverrides family) and say which in the route handler comment
   and in `docs/CONTRACT.md`.
2. Prefer shapes that already have door-level unknown-key or type rejection (#577 / #696).
3. Extend `tests/api-config-conventions-390.test.ts` with a pin for the new call site.
4. Never invent a fifth silent shape without updating this page in the same PR.
