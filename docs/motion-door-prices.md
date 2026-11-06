# Motion door prices

What one clip costs US on each motion door, at the provider's price with no markup (Conrad's ruling,
2026-11-05, cf#1246). The manifest carries the figure and `ui.cost_as_of`. This page carries where the
figure came from. When a provider changes a price, change the manifest, its `cost_as_of`, and the row here
together.

The rules every motion door's manifest must meet are in `modules/_shared/door-manifest-rules.ts`. The
fields are described in `docs/CONTRACT.md` section 4.

| Door | Field | Figure | Source | Read |
|---|---|---|---|---|
| alibaba-wan | per second | 720p $0.10, 1080p $0.15 | https://docs.runpod.io/public-endpoints/models/wan-2-6-i2v | 2026-11-05 |
| alibaba-wan-lora | per second | $0.07 (5 s $0.35, 8 s $0.56) | https://docs.runpod.io/public-endpoints/models/wan-2-2-i2v-lora | 2026-11-05 |
| cf-flux-3-video | per second | hd $0.15, fhd $0.24 | https://developers.cloudflare.com/ai/models/black-forest-labs/flux-3-video/ (the page gives no unit; "per second" is from https://bfl.ai/pricing) | 2026-11-05 |
| cf-grok-video | per second | 480p $0.08, 720p $0.14 (default model `xai/grok-imagine-video-1.5-preview`; `xai/grok-imagine-video` is $0.05 and $0.07) | https://developers.cloudflare.com/ai/models/xai/grok-imagine-video-1.5-preview/ | 2026-11-05 |
| cf-hailuo | per clip | 768P 6 s $0.28, 768P 10 s $0.56, 1080P 6 s $0.49; no listed price for 1080P 10 s | https://developers.cloudflare.com/ai/models/minimax/hailuo-2.3/ | 2026-11-05 |
| cf-hh1-r2v | per second | 720P $0.14, 1080P $0.18 | https://developers.cloudflare.com/ai/models/alibaba/hh1.1-r2v/ | 2026-11-05 |
| cf-kling-v4 | per second | 720p $0.157, 1080p $0.235 | https://developers.cloudflare.com/ai/models/klingai/kling-v4/ | 2026-11-05 |
| cf-minimax-h3 | per second | 768P $0.08, 2K $0.13 | https://developers.cloudflare.com/ai/models/minimax/h3/ | 2026-11-05 |
| cf-p-video-avatar | per second | 720p $0.025, 1080p $0.045 | https://developers.cloudflare.com/ai/models/pruna/p-video-avatar/ | 2026-11-05 |
| cf-veo | per second | 720p $0.10, 1080p $0.12 with its audio (the default); silent $0.08 and $0.10 | https://developers.cloudflare.com/ai/models/google/veo-3.1-fast/ | 2026-11-05 |
| cf-vidu-q3-turbo | per second | 540p $0.04, 1080p $0.07 (720p $0.06) | https://developers.cloudflare.com/ai/models/vidu/q3-turbo/ | 2026-11-05 |
| infinitetalk | per clip | $0.25 (480p, the only size it delivers) | https://docs.runpod.io/public-endpoints/models/infinitetalk | 2026-11-05 |
| minimax-hailuo | per second | $0.19 | RunPod public endpoint catalog, endpoint `minimax-hailuo-2-3-fast` | 2026-11-05 |

**Unpriced, on purpose:**

| Door | Why |
|---|---|
| cf-seedance | Its Cloudflare model page lists no price. Another provider's Seedance price is not what we pay, so it is not used. |
| local-gpu | The user's own hardware. |
| own-gpu | GPU seconds on our endpoint, which is not a listed per-clip or per-second price. |
