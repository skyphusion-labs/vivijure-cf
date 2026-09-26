# cf-veo

A **`motion.backend`** module (vivijure-module/2): **HappyHorse 1.1 R2V (CF AI)** via Cloudflare AI Gateway /
Unified Billing (`google/veo-3.1-fast`). Turns one shot's start keyframe into a clip with **no RunPod**.

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
- **Service**: `vivijure-module-cf-veo` bound as `MODULE_CF_VEO`.

## Cost (Cloudflare AI Gateway / Unified Billing)

CF does **not** mark up inference: Unified Billing charges **provider list rates**, and applies a **5% fee only when you buy credits** (e.g. $100 credit → $105 charged). See [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).

Account live rates: [CF dashboard · google/veo-3.1-fast](https://dash.cloudflare.com/?to=/:account/ai/models/google/veo-3.1-fast).

**Alibaba Model Studio list (International, happyhorse-1.1-r2v, output-second billing; as of Aug 2026):**

| Resolution | List price | Limited-time 40% off (if still active) |
|---|---|---|
| 720P | **$0.14 /s** | ~$0.084 /s |
| 1080P | **$0.18 /s** | ~$0.108 /s |

Source: [Alibaba Cloud Model Studio model pricing](https://www.alibabacloud.com/help/en/model-studio/model-pricing) (HappyHorse Reference-to-video). Free trial quota may apply for new Model Studio accounts (not guaranteed via CF).

**Worked example (list, no promo):** 5s @ 720P ≈ **$0.70**; 8s @ 1080P ≈ **$1.44** (plus ~5% effective only on the credit top-up that funded it).

## License

**AGPL-3.0-only.**
