# cf-vidu-q3-turbo

A `motion.backend` module (vivijure-module/2): Vidu Q3 Turbo via Cloudflare AI
(`vidu/q3-turbo`). It turns one shot's start still into a clip. When the next
shot's start still is present, that still is the end frame.

This door replaces RunPod `vidu-q3` (cf#1075).

## Why Workflow

`env.AI.run` is synchronous, and a video gen can run for minutes. `/invoke`
starts a Workflow. `/poll` reads R2 state until the clip lands (#155).

## What we send

From `schema-input.json` on 2026-10-30. `additionalProperties` is false, so
the body has only these keys:

| Field | Sent as |
|---|---|
| `start_image` | the shot still |
| `end_image` | the next still, only when we have one |
| `duration` | integer seconds, clamped to 1-16 (schema default 5) |
| `resolution` | `540p`, `720p`, or `1080p` (schema default `720p`) |
| `audio` | the talking-audio switch. The JSON schema has no default; the page says Q3 defaults true. We send the boolean. |
| `prompt` | the motion prompt, cut at 5000 characters (schema `maxLength`) |

`aspect_ratio` is documented as text-to-video only. This door always sends a
still, so the ratio is not sent. Unknown: whether the provider would reject
the ratio beside a still. We do not find out by sending it.

`schema-output.json` requires `video` and nothing else. It does not state fps.
The module stamps 24 so `frames / fps` equals the seconds we sent. A real
render has to confirm the file's fps.

## Price (Cloudflare model page, 2026-10-30)

Per second: $0.04 at 540p, $0.06 at 720p (also the page's default rate), $0.07
at 1080p.

## License

AGPL-3.0-only.
