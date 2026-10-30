# cf-minimax-h3

A **`motion.backend`** module (vivijure-module/2): MiniMax H3 via Cloudflare AI
Gateway (`minimax/h3`). Clips with the model's own sound, from a start still, with the next shot's
start still as the end frame when we have one. No RunPod.

The provider page lists 4 to 15 seconds. 768P is $0.08/s and 2K is $0.13/s.
The schema states no resolution default and no duration default. 768P matches
the default per-second price, so that is what we send when you do not choose.
The image examples send ratio `adaptive`. 9:16 is a choice. The model returns
its own soundtrack, measured 2026-10-30, and no field turns it off. The schema also has image, video, and
audio reference roles. This hook does not carry those, so they are not sent.
Video-input pricing is not listed.

## Contract

- **Hook**: `motion.backend` (`pick_one`).
- **Input**: `shot_id`, `keyframe_url`, `prompt`, `seconds`, optional `last_keyframe_url`.
- **Output**: `shot_id`, `clip_key`, and `fps` / `frames` read from the file.
- **Bindings**: `AI`, `GATEWAY_ID`, `R2_RENDERS`, `I2V_WORKFLOW`.
- **Service**: `vivijure-module-cf-minimax-h3` bound as `MODULE_CF_MINIMAX_H3`.

Installable. Not a spoken or silent default (`ui.order` 96, and the spoken
fallback still names infinitetalk). Not in the tenant catalog.

## License

**AGPL-3.0-only.**
