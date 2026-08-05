# cf-grok-video

A **`motion.backend`** module (vivijure-module/2): **Grok Imagine Video (CF AI)** via Cloudflare AI Gateway /
Unified Billing (`xai/grok-imagine-video`). Turns one shot's start keyframe into a clip with **no RunPod**.

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
- **Service**: `vivijure-module-cf-grok-video` bound as `MODULE_CF_GROK_VIDEO`.

## Cost (Cloudflare AI Gateway / Unified Billing)

CF does **not** mark up inference: Unified Billing charges **provider list rates**, and applies a **5% fee only when you buy credits**. See [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).

Account live rates: [CF dashboard · xai/grok-imagine-video](https://dash.cloudflare.com/?to=/:account/ai/models/xai/grok-imagine-video).

**xAI list (grok-imagine-video; as of Aug 2026):**

| Item | Price |
|---|---|
| Output video | **$0.05 / second** |
| Image input (when charged) | check [xAI model page](https://docs.x.ai/developers/models/grok-imagine-video) (resolution tiers may apply on some clusters) |

Source: [xAI · grok-imagine-video](https://docs.x.ai/docs/models/grok-imagine-video).

**Worked example:** 5s clip ≈ **$0.25**; 10s ≈ **$0.50** (plus 5% only on credit purchase).

## License

**AGPL-3.0-only.**
