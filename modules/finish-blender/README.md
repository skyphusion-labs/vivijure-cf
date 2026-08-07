# finish-blender

A **`finish`**-chain module (vivijure-module/2). Grades shot clips with **headless Blender**
compositor presets, dispatched to the dedicated **vivijure-blender** RunPod endpoint.

`ui.order: 18` -- after lipsync (15), before upscale (20), so grading runs at native resolution.

## Configuration

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `job_type` | enum `grade` / `composite` | `grade` | grade only, or grade + plate underlay (plate needs later studio UI) |
| `preset` | enum | `filmic_warm` | color look |
| `strength` | float 0..2 | `1` | how hard the preset is applied |

## Contract

- **Hook**: `finish` (chain). Soft-degrade passthrough on missing endpoint / backend failure.
- **Async**: `/invoke` + `/poll` (RunPod).
- **R2**: endpoint owns bucket IO; this worker holds no R2 keys.
- **Secrets Store**: `RUNPOD_API_KEY`, `BLENDER_RUNPOD_ENDPOINT_ID`.

## Soft-degrade

Polish step: never fail the chain. Pass input `clip_key` through with `degraded` reason.

## License

**AGPL-3.0-only.**
