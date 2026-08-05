# cf-hh1-r2v

A **`motion.backend`** module (vivijure-module/2): **HappyHorse 1.1 R2V (CF AI)** via Cloudflare AI Gateway /
Unified Billing (`alibaba/hh1.1-r2v`). Turns one shot's start keyframe into a clip with **no RunPod**.

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
- **Service**: `vivijure-module-cf-hh1-r2v` bound as `MODULE_CF_HH1_R2V`.

## License

**AGPL-3.0-only.**
