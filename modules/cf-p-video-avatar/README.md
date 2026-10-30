# cf-p-video-avatar

A **`motion.backend`** module (vivijure-module/2): Pruna P-Video-Avatar via Cloudflare
AI Gateway (`pruna/p-video-avatar`). Portrait plus the Cast line. No RunPod.

The provider page lists no duration and no aspect ratio. 720p is $0.025/s and
1080p is $0.045/s. A shot with no Cast audio is refused, so the named voice
cannot invent the line. Whether that required voice name still colors an
audio-driven clip and whether the picture follows the portrait are unsettled
until a real render.

**15 seconds is this door's own cap, not the provider's.** It matches
`infinitetalk` and stands until a real long-line test (#931).

## Contract

- **Hook**: `motion.backend` (`pick_one`).
- **Input**: `shot_id`, `keyframe_url`, `prompt`, `audio_url`.
- **Output**: `shot_id`, `clip_key`, and `fps` / `frames` read from the file.
- **Bindings**: `AI`, `GATEWAY_ID`, `R2_RENDERS`, `I2V_WORKFLOW`.
- **Service**: `vivijure-module-cf-p-video-avatar` bound as `MODULE_CF_P_VIDEO_AVATAR`.

Installable. Not a spoken or silent default (`ui.order` 92, and the spoken
fallback still names infinitetalk). Not in the tenant catalog.

## License

**AGPL-3.0-only.**
