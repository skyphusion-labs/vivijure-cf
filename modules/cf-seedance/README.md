# cf-seedance

A **`motion.backend`** module (vivijure-module/2): **Seedance 2.0 (CF AI)** via Cloudflare AI Gateway /
Unified Billing (`bytedance/seedance-2.0`). Turns one shot's start keyframe into a clip with **no RunPod**.

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
- **Service**: `vivijure-module-cf-seedance` bound as `MODULE_CF_SEEDANCE`.

## Cost (Cloudflare AI Gateway / Unified Billing)

CF does **not** mark up inference: Unified Billing charges **provider list rates**, and applies a **5% fee only when you buy credits**. See [Unified Billing](https://developers.cloudflare.com/ai-gateway/features/unified-billing/).

Account live rates: [seedance-2.0](https://dash.cloudflare.com/?to=/:account/ai/models/bytedance/seedance-2.0) · [fast](https://dash.cloudflare.com/?to=/:account/ai/models/bytedance/seedance-2.0-fast) · [mini](https://dash.cloudflare.com/?to=/:account/ai/models/bytedance/seedance-2.0-mini).

**BytePlus ModelArk / Dreamina Seedance 2.0 series (USD, input without video, 5s 16:9 examples; as of Jul 2026):**

| Variant | 480p | 720p | 1080p | 4K |
|---|---|---|---|---|
| **Seedance 2.0** | $0.07/s ($0.35 / 5s) | **$0.15/s** ($0.76 / 5s) | $0.37/s ($1.87 / 5s) | $0.78/s ($3.89 / 5s) |
| **Seedance 2.0 Fast** | $0.06/s ($0.28 / 5s) | **$0.12/s** ($0.60 / 5s) | n/a | n/a |
| **Seedance 2.0 Mini** | $0.04/s ($0.18 / 5s) | **$0.08/s** ($0.38 / 5s) | n/a | n/a |

Source: [BytePlus ModelArk Pricing](https://docs.byteplus.com/docs/ModelArk/1099320) (Dreamina Seedance 2.0 series price examples). Billing is token-based under the hood; these are the published estimated per-second rates for typical i2v.

**Worked example (720p, 5s i2v, list):** Mini ≈ **$0.38**; Fast ≈ **$0.60**; full 2.0 ≈ **$0.76**.

## License

**AGPL-3.0-only.**
