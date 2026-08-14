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

## Cost (Cloudflare AI Gateway / Unified Billing)

CF does **not** mark up inference: Unified Billing charges **provider list rates**, and applies a **5% fee only when you buy credits**. See [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).

Account live rates: [CF dashboard · black-forest-labs/flux-3-video](https://dash.cloudflare.com/?to=/:account/ai/models/black-forest-labs/flux-3-video).

**Black Forest Labs list (FLUX 3 Video; pay-as-you-go API, as of Aug 2026):**

| Mode | Resolution | Price |
|---|---|---|
| Text/Image → Video (standard) | HD (~720p) | **$0.17 /s** |
| Text/Image → Video (standard) | FHD (~1080p) | **$0.29 /s** |
| Text/Image → Video (draft) | HD | **$0.06 /s** |
| Video → Video | HD / FHD | $0.41 /s / $0.53 /s |

Source: [bfl.ai/pricing](https://bfl.ai/pricing) (videoRates: standard t2v720=17¢, t2v1080=29¢; draft t2v720=6¢). This module uses `mode: i2v` (text/image → video), not v2v.

**Worked example (standard i2v):** 5s HD ≈ **$0.85**; 5s FHD ≈ **$1.45**; 5s draft HD ≈ **$0.30**.

## License

**AGPL-3.0-only.**
