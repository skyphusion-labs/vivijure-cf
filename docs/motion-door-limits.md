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
| Duration | Clip length we snap to. A storyboard second outside this band is clamped. |
| Talks? | Whether we keep the model's own soundtrack (`usage.native_audio`). |
| Voice lock | How the speaker stays the same shot to shot. |
| Scatter? | Whether talking shots may render in parallel. Parallel shots cannot hear each other. |
| First+last? | Whether we pass the next shot's start still as this clip's end frame. |
| Cannot | Honest ceiling. If it is not listed, we do not promise it. |

Shared rules:

- Talking clips never scatter. Look doors (own-gpu, local-gpu, wan-lora,
  HappyHorse refs) never scatter. Only silent generic cloud (Kling, Hailuo,
  Wan without a face LoRA) may still split.
- Scatter means every shot is its own job. The door never hears the previous
  clip's audio or picture.
- **Flux v2v** (feed the last 4 seconds of the previous clip) is the real Flux
  speaker lock. Talking Flux stays on one film so that path can land. Until
  v2v is wired, the speaker lock is the same prompt lock on every shot.
- Seedance on Cloudflare has a **seed** knob and **no `audio_urls`**. Voice
  lock is seed plus prompt. There is no audio-reference field on the door we
  call.
- Kling in this tree is **2.1 silent**. It is not Kling 2.6 `voice_id`. Speaking
  is Cast TTS plus MuseTalk.

## cf-flux-3-video (Flux talking)

Stylized talking clips from your stills. Faces drift.

| | |
|---|---|
| Duration | 5, 10, 15, or 20 seconds (`usage.duration_steps`) |
| Talks? | Yes. Native audio kept when generate-audio is on. |
| Voice lock | `prompt_lock`. Same voice lock on every shot. No speaker id, no seed. |
| Scatter? | No. Talking Flux stays on one film. |
| First+last? | Yes. Start still plus the next shot's start still hold the cut. |
| Cannot | Pin a speaker with a seed. Hold faces tightly. v2v (last 4s of the previous clip) is not wired yet. |

## cf-seedance (Seedance talking)

Fast talking clips. Same seed keeps the voice closer.

| | |
|---|---|
| Duration | 4-12 seconds |
| Talks? | Yes. |
| Voice lock | `seed_and_prompt`. Same seed and same voice lock on every shot. |
| Scatter? | No. Talking clips stay on one film. |
| First+last? | Yes. `last_frame_image` is the next shot's start still when we have one. |
| Cannot | Lock the voice from a previous clip (no `audio_urls` / audio-reference on this door). |

## seedance (Seedance talking, hosted speed default)

Same idea as `cf-seedance`. This is the hosted speed default. 4-12 seconds.

| | |
|---|---|
| Duration | 4-12 seconds |
| Talks? | Yes. |
| Voice lock | `seed_and_prompt`. Same seed and same voice lock. |
| Scatter? | No. Talking clips stay on one film. |
| First+last? | Declared yes (last still is the next start). Visual last-frame wiring on this door is the same intent as `cf-seedance`. |
| Cannot | Lock the voice from a previous clip. No audio-reference field on the door we call. |

## google-veo (Veo talking)

Photoreal talking clips. Slow and spendy.

| | |
|---|---|
| Duration | Only 4, 6, or 8 seconds |
| Talks? | Yes. |
| Voice lock | `prompt_lock`. Same voice lock on every shot. Seed is hardcoded, not a pin. |
| Scatter? | No. Talking clips stay on one film. |
| First+last? | No. We do not pass a last frame. |
| Cannot | Arbitrary lengths. First+last stills. Pin a seed from the voice lock. |

## vidu-q3 (Vidu talking)

Talking clips when you have several stills.

| | |
|---|---|
| Duration | 3-10 seconds |
| Talks? | Yes. |
| Voice lock | `prompt_lock`. |
| Scatter? | No. Talking clips stay on one film. |
| First+last? | No. |
| Cannot | Hear the previous clip. Pin a seed from the voice lock. |

## cf-grok-video (Grok talking drafts)

Quick talking drafts from a still.

| | |
|---|---|
| Duration | 1-15 seconds |
| Talks? | Yes. |
| Voice lock | `prompt_lock`. |
| Scatter? | No. Talking clips stay on one film. |
| First+last? | No. |
| Cannot | Hear the previous clip. Pin a seed. |

## kling (silent cinematic)

Cinematic camera, silent clips.

| | |
|---|---|
| Duration | 5 or 10 seconds |
| Talks? | No. |
| Voice lock | `cast_tts`. Speaking is the Cast voice plus MuseTalk. |
| Scatter? | Yes (silent path; scatter does not break a voice this door never produced). |
| First+last? | No. |
| Cannot | Native talking audio. This is Kling 2.1 silent, not 2.6 `voice_id`. |

## minimax-hailuo (silent physical)

Physical motion, silent.

| | |
|---|---|
| Duration | 6 or 10 seconds |
| Talks? | No. |
| Voice lock | `cast_tts`. Cast voice plus MuseTalk if they speak. |
| Scatter? | Yes. Silent generic cloud. |
| First+last? | No. |
| Cannot | Native talking audio. Arbitrary lengths. |

## alibaba-wan (silent detailed)

Detailed motion, stronger faces, silent.

| | |
|---|---|
| Duration | 5, 10, or 15 seconds |
| Talks? | No. |
| Voice lock | `cast_tts`. |
| Scatter? | Yes. Silent generic cloud (no trained face). |
| First+last? | No. |
| Cannot | Native talking audio. Continuous duration. |

## alibaba-wan-lora (silent, your trained face)

Same family, with your trained face. Silent.

| | |
|---|---|
| Duration | 5 or 8 seconds (the door we call; not the 5/10/15 Wan 2.6 grid) |
| Talks? | No. |
| Voice lock | `cast_tts`. Seed is available to pin the look. |
| Scatter? | No. Face lock stays on one film. |
| First+last? | No. |
| Cannot | Native talking audio. 10s or 15s clips on this door. |

## cf-hh1-r2v (silent look lock)

Holds a look from reference stills. Silent.

| | |
|---|---|
| Duration | 3-15 seconds |
| Talks? | No. |
| Voice lock | `cast_tts`. |
| Scatter? | No. Look lock stays on one film. |
| First+last? | Yes. Start still plus the next shot's start still go in as reference images. |
| Cannot | Native talking audio. |

## own-gpu (best look, studio GPU)

Best look, slower, silent. Cloud talking doors finish faster.

| | |
|---|---|
| Duration | About 2-8 seconds (no hard grid; backend snaps frames) |
| Talks? | No. |
| Voice lock | `cast_tts`. Seed pins the look when set. |
| Scatter? | No. Look door stays on one film. |
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
| Voice lock | `cast_tts`. Seed is available. |
| Scatter? | No. Look door stays on one film. |
| First+last? | No. |
| Cannot | Native talking audio. Commercial self-host. Cloud API-free is the point, not datacenter parity. |

## infinitetalk (RunPod)

Portrait plus Cast audio. The speaker is ours.

| | |
|---|---|
| Duration | Audio-driven, we clamp 2-15 seconds |
| Talks? | Mouth is driven by our audio. Not native invented speech. |
| Voice lock | `cast_tts`. Needs `audio_url` from Aura or Chatterbox. |
| Scatter? | No. |
| First+last? | No. |
| Cannot | Invent speech. Run without a Cast audio clip. |

## kling-o1-r2v (RunPod)

Multi-ref silent. Cast, props, locations.

| | |
|---|---|
| Duration | 3, 5, or 10 seconds |
| Talks? | No. |
| Voice lock | `cast_tts`. |
| Scatter? | No. Look lock stays on one film. |
| First+last? | Yes, as extra reference images. |
| Cannot | Native talking audio. Kling 2.6 voice_id. |

## cf-wan-27 (Cloudflare Wan 2.7)

Hosted Wan door. Newer weights than RunPod 2.6. Code for 2.6 stays unbound.

| | |
|---|---|
| Duration | 2-15 seconds |
| Talks? | No. |
| Voice lock | `cast_tts`. Seed pins the look. |
| Scatter? | No. Look door. |
| First+last? | No. |
| Cannot | Native talking audio. |

## cf-hailuo (Cloudflare Hailuo 2.3)

| | |
|---|---|
| Duration | 6 or 10 seconds |
| Talks? | No. |
| Voice lock | `cast_tts`. |
| Scatter? | Yes. Silent generic cloud. |
| First+last? | No. |
| Cannot | Native talking audio. |

## cf-veo (Cloudflare Veo 3.1 Fast)

| | |
|---|---|
| Duration | 4, 6, or 8 seconds |
| Talks? | Yes. |
| Voice lock | `prompt_lock`. |
| Scatter? | No. |
| First+last? | No. |
| Cannot | Arbitrary lengths. A seed we control. |

## Voice modes (the four values)

| `usage.voice` | What the filmmaker gets |
|---|---|
| `prompt_lock` | Same speaker description in every motion prompt. No speaker id on the door. |
| `seed_and_prompt` | Same seed **and** the same prompt lock. Seedance. |
| `cast_tts` | Silent motion. The speaking voice is the Cast voice (TTS). MuseTalk mouth-replace is homelab-only; hosted does not bind it. |
| `prev_clip` | Each talking shot continues the previous clip (Flux v2v). Not wired yet. |
