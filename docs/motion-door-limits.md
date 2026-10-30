# Motion door limits

Source of truth for how **we** call each `motion.backend` door, and what that means
for voice and look consistency across a film.

These envelopes are the calls we send, not the provider marketing max. Cost lives
on `ui.cost`. Filmmaker copy lives on `ui.blurb` and `provides[].label`. Machine
facts live on `usage`. Planner door cards render `ui.limits`.

No frozen provider endpoint IDs here. Those drift; this file is about the
contract we actually honor.

## How to read a door

| Fact | What it means on a film |
|---|---|
| Duration | Clip length we snap to. A storyboard second outside this band is clamped. Preflight reports it: over the top is an error, other misses are warnings (cf#926). |
| Talks? | Whether we keep the model's own soundtrack (`usage.native_audio`). A door with no audio takes no spoken line. |
| Voice lock | How the speaker stays the same shot to shot. |
| First+last? | Whether we pass the next shot's start still as this clip's end frame. |
| Cannot | Honest ceiling. If it is not listed, we do not promise it. |

Shared rules:

- One film, no split. Motion and film stay on a single job. Talking clips
  stay on one film so the door can hear itself shot to shot.
- **Flux v2v** (feed the last 4 seconds of the previous clip) is the real Flux
  speaker lock. Talking Flux stays on one film so that path can land. Until
  v2v is wired, the speaker lock is the same prompt lock on every shot.
- Seedance on Cloudflare uses the talking sample you kept as the voice
  lock. Same take, every shot.
- **A silent door takes no spoken line.** Submit refuses a board with a line on a
  door where `usage.native_audio` and `usage.driving_audio` are both false, and the
  planner hides those doors for that board (`docs/CONTRACT.md`). The check reads the
  whole bundle, so one spoken shot rules out a silent door for the film (cf#1056).

## cf-flux-3-video (Flux talking)

Stylized talking clips from your stills. Faces drift.

| | |
|---|---|
| Duration | 5, 10, 15, or 20 seconds (`usage.duration_steps`) |
| Talks? | Yes. Native audio kept when generate-audio is on. |
| Voice lock | `prompt_lock`. Same voice lock on every shot. No speaker id, no seed. |
| First+last? | Yes. Start still plus the next shot's start still hold the cut. |
| Cannot | Pin a speaker with a seed. Hold faces tightly. v2v (last 4s of the previous clip) is not wired yet. |

## cf-seedance (Seedance talking)

Fast talking clips. Uses the sample you kept. The default model is Seedance 2.5.
The same door also calls 2.0, 2.0 Fast, and 2.0 Mini. Those four models do not
share one input document.

| | |
|---|---|
| Duration | 4-30 seconds on 2.5. 4-12 seconds on 2.0, 2.0 Fast, and 2.0 Mini. A longer ask is clamped to that model's max. |
| Talks? | Yes. |
| Voice lock | The sample you kept. 2.5 sends that clip as one item in `reference_videos`. The 2.0 family sends `reference_video`. 2.5 also publishes `reference_audios`, and Mini publishes `reference_audio`. The sample is a video, so those audio fields are not set. Whether 2.5 keeps the voice from `reference_videos` is unproven until a real render. |
| First+last? | Yes. The next shot's start still is the end frame when we have one. On 2.5, first and last frames always use aspect ratio `adaptive` (a supplied ratio is overridden), so the ratio knob does not make a vertical clip. The keyframe has to be 9:16. On 2.0, Fast, and Mini, Cloudflare says aspect ratio is ignored when an image is used. |
| Cannot | 1080p or 4k except on Seedance 2.0. 2.5, Fast, and Mini allow 480p and 720p. An ask outside that set is sent as 720p, the published default. 9:21 is not on 2.5. That ask is sent as `adaptive`. Invent a different speaker. Finish does not add mouths on this door. |

## seedance (Seedance talking, hosted speed default)

Same voice lock idea as `cf-seedance`. This door is 4-12 seconds.

| | |
|---|---|
| Duration | 4-12 seconds |
| Talks? | Yes. |
| Voice lock | `seed_and_prompt`. Same seed and same voice lock. |
| First+last? | Declared yes (last still is the next start). Visual last-frame wiring on this door is the same intent as `cf-seedance`. |
| Cannot | Lock the voice from a previous clip. No audio-reference field on the door we call. |

## google-veo (Veo talking)

Photoreal talking clips. Slow and spendy.

| | |
|---|---|
| Duration | Only 4, 6, or 8 seconds |
| Talks? | Yes. |
| Voice lock | `prompt_lock`. Same voice lock on every shot. Seed is hardcoded, not a pin. |
| First+last? | No. We do not pass a last frame. |
| Cannot | Arbitrary lengths. First+last stills. Pin a seed from the voice lock. |

## vidu-q3 (Vidu talking)

Talking clips when you have several stills.

| | |
|---|---|
| Duration | 3-10 seconds |
| Talks? | Yes. |
| Voice lock | `prompt_lock`. |
| First+last? | No. |
| Cannot | Hear the previous clip. Pin a seed from the voice lock. |

## cf-grok-video (Grok talking drafts)

Quick talking drafts from a still.

| | |
|---|---|
| Duration | 1-15 seconds |
| Talks? | Yes. |
| Voice lock | `prompt_lock`. |
| First+last? | No. |
| Cannot | Hear the previous clip. Pin a seed. |

## minimax-hailuo (silent physical)

Physical motion, silent.

| | |
|---|---|
| Duration | 6 or 10 seconds |
| Talks? | No. |
| Voice lock | None. No spoken lines on this door. |
| First+last? | No. |
| Cannot | Native talking audio. Arbitrary lengths. |

## alibaba-wan (Wan 2.6 talking)

Stills to clip. Mouth follows the storyboard line when we have a Cast
voice. Without a line, invents speech from the prompt. Cannot lock the
sample you kept. Public slug `wan-2-6-i2v`. Cloudflare Wan 2.7 is gone.

| | |
|---|---|
| Duration | 5, 10, or 15 seconds |
| Talks? | Yes. Our LINE file, or auto-dub when the shot has no words. |
| Voice lock | Mouth follows the storyboard line in the Cast voice. |
| First+last? | No. |
| Cannot | Lock the sample you kept. Continuous durations. |

## alibaba-wan-lora (silent, your trained face)

Same family, with your trained face. Silent.

| | |
|---|---|
| Duration | 5 or 8 seconds (the door we call; not the 5/10/15 Wan 2.6 grid) |
| Talks? | No. |
| Voice lock | None. No spoken lines on this door. Seed is available to pin the look. |
| First+last? | No. |
| Cannot | Native talking audio. 10s or 15s clips on this door. |

## cf-hh1-r2v (silent look lock)

Holds a look from reference stills. Silent.

| | |
|---|---|
| Duration | 3-15 seconds |
| Talks? | No. |
| Voice lock | None. No spoken lines on this door. |
| First+last? | Yes. Start still plus the next shot's start still go in as reference images. |
| Cannot | Native talking audio. |

## own-gpu (silent look, studio GPU)

Our studio GPU. Best picture, silent. No talking audio and no voice lock.
Use a talking door for dialogue.

| | |
|---|---|
| Duration | About 2-8 seconds (no hard grid; backend snaps frames) |
| Talks? | No. |
| Voice lock | None. No spoken lines on this door. Seed pins the look when set. |
| First+last? | No. |
| Cannot | Native talking audio. Fast turnaround vs a cloud talking door. |

## local-gpu (best look, your GPU)

Best look you can keep on your own GPU. Silent. Self-host is hobby and
non-commercial (`vivijure-local`). Commercial use is the hosted studio, not
this door. Weights carry their own licences (CogVideoX on 16GB, LTX on 12GB).

| | |
|---|---|
| Duration | About 2-8 seconds unless the local door declares a tighter `duration_grid` |
| Talks? | No. |
| Voice lock | None. No spoken lines on this door. Seed is available. |
| First+last? | No. |
| Cannot | Native talking audio. Commercial self-host. Cloud API-free is the point, not datacenter parity. |

## cf-p-video-avatar

Portrait plus Cast audio, at 720p or 1080p. The speaker is ours. Higher
resolution than infinitetalk. Not a default door.

| | |
|---|---|
| Duration | 1 to 15 seconds. 15 is our door cap, not the provider's, until a real long-line test (#931). |
| Talks? | Mouth follows our file. Not invented speech. |
| Voice lock | Mouth follows the storyboard line in the Cast voice. A shot with no line is refused. |
| First+last? | No. The page has a portrait and no end frame. |
| Cannot | Invent speech. Lock the sample you kept. Say whether the picture follows the portrait. Say whether the required named voice changes an audio-driven clip. Trim trailing silence. |

## infinitetalk

Portrait plus Cast audio. The speaker is ours, not invented.

| | |
|---|---|
| Duration | Clip length follows the LINE audio. |
| Talks? | Mouth follows our file. Not invented speech. |
| Voice lock | Mouth follows the storyboard line in the Cast voice. A shot with no line stays quiet. |
| First+last? | No. |
| Cannot | Invent speech. Lock the sample you kept. |

## cf-kling-v4

Silent long clips from your stills. 3 to 30 seconds. Not a default door.

| | |
|---|---|
| Duration | 3 to 30 seconds. Whole seconds. |
| Talks? | No. |
| Voice lock | None. No spoken lines on this door. |
| First+last? | Yes. The next shot's start still is the end frame when we have one. The model allows up to 9 middle frames. This door does not send them. |
| Cannot | Spoken lines. Scatter. Send middle frames. Say whether 9:16 survives once a still is attached (the provider page says aspect is ignored when keyframes are given). Check a still before send. Assume a frame rate. |

## cf-minimax-h3

Silent clips from your stills. 4 to 15 seconds. Not a default door.

| | |
|---|---|
| Duration | 4 to 15 seconds. Whole seconds. |
| Talks? | No. Native audio output is not stated. |
| Voice lock | None. No spoken lines on this door. |
| First+last? | Yes. The next shot's start still is the end frame when we have one. |
| Cannot | Spoken lines. Scatter. Send an image, video, or audio reference. Name a video-input price (the page does not list one). Say the provider default resolution (the schema lists none; we send 768P, the default per-second price). Assume a frame rate. |

## cf-hailuo (Cloudflare Hailuo 2.3)

| | |
|---|---|
| Duration | 6 or 10 seconds |
| Talks? | No. |
| Voice lock | None. No spoken lines on this door. |
| First+last? | No. |
| Cannot | Native talking audio. |

## cf-veo (Cloudflare Veo 3.1 Fast)

| | |
|---|---|
| Duration | 4, 6, or 8 seconds |
| Talks? | Yes. |
| Voice lock | `prompt_lock`. |
| First+last? | No. |
| Cannot | Arbitrary lengths. A seed we control. |

## Voice modes (the four values)

| `usage.voice` | What the filmmaker gets |
|---|---|
| `prompt_lock` | Same speaker description in every motion prompt. No speaker id on the door. |
| `seed_and_prompt` | Same seed **and** the same prompt lock. Seedance. |
| `cast_tts` | Speaking voice is the Cast voice (TTS). Driving-audio doors (InfiniteTalk, Wan) consume that LINE file at motion time. Post-hoc mouth-replace is GONE (cf#783). A silent door declares this value too, and takes no spoken line: submit refuses the board. |
| `prev_clip` | Each talking shot continues the previous clip (Flux v2v). Not wired yet. |
