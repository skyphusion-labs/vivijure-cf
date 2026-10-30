# cf-kling-v4

A **`motion.backend`** module (vivijure-module/2): Kling 4.0 via Cloudflare AI Gateway
(`klingai/kling-v4`). Silent clips from a start still, with the next shot's start
still as the end frame when we have one. No RunPod.

The provider page lists 3 to 30 seconds, 720p at $0.157/s and 1080p at $0.235/s.
1080p is the schema default, and the default per-second price is $0.235. There is
no audio input. Up to 9 middle frames exist on the model. This hook has a start
still and an optional end still, so middle frames are not sent. Whether a real
clip follows the stills, and whether the sent aspect survives them, are unsettled
until a real render.

## Contract

- **Hook**: `motion.backend` (`pick_one`).
- **Input**: `shot_id`, `keyframe_url`, `prompt`, `seconds`, optional `last_keyframe_url`.
- **Output**: `shot_id`, `clip_key`, and `fps` / `frames` read from the file.
- **Bindings**: `AI`, `GATEWAY_ID`, `R2_RENDERS`, `I2V_WORKFLOW`.
- **Service**: `vivijure-module-cf-kling-v4` bound as `MODULE_CF_KLING_V4`.

Installable. Not a spoken or silent default (`ui.order` 94, and the spoken
fallback still names infinitetalk). Not in the tenant catalog.

## License

**AGPL-3.0-only.**
