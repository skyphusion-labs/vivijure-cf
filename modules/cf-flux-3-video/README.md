# cf-flux-3-video

A **`motion.backend`** module (vivijure-module/2): **FLUX 3 Video (CF AI)** via Cloudflare AI Gateway /
Unified Billing (`black-forest-labs/flux-3-video`). Turns one shot's start keyframe into a clip with **no RunPod**.

## Why Workflow, not RunPod /run

RunPod cloud i2v modules `POST /run` (async job id) then poll `/status`. Cloudflare
`env.AI.run` is **synchronous only** and a video gen can run minutes -- past Worker request
and `waitUntil` (~30s cancel, #155). This module starts a durable **Workflow** on `/invoke`
and `/poll` watches R2 state until the clip lands.

## Contract

- **Hook**: `motion.backend` (`pick_one`). Provides `i2v-cloud`.
- **Input**: `shot_id`, `keyframe_url` (presigned), `prompt`, `seconds`.
- **Output**: `shot_id`, `clip_key`, `fps` (24), `frames`.
- **Bindings**: `AI`, `GATEWAY_ID` (Secrets Store), `R2_RENDERS` (`vivijure`), `I2V_WORKFLOW`.
- **Service**: `vivijure-module-cf-flux-3-video` bound as `MODULE_CF_FLUX_3_VIDEO`.

## License

**AGPL-3.0-only.**
