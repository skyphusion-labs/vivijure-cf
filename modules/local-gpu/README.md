# local-gpu

A dual-hook **`motion.backend` + `keyframe`** module (vivijure-module/2). It draws start keyframes
(SDXL `preview`) and animates each into a clip (image-to-video) on the user's **own local consumer
GPU** -- a 12GB-class (LTX) or 16GB-class (CogVideoX) card in their homelab -- via the
**vivijure-local-12gb** / **vivijure-local-16gb** job server.

This is the **local-consumer door**: the deliberate opposite of the RunPod datacenter backend
(`alibaba-wan`) and even of `own-gpu` (which still runs on a RunPod endpoint the user provisions).
Here the work happens on real silicon the user already owns -- no rent, no cloud GPU for keyframes
or motion -- reached over a Cloudflare tunnel that terminates at the box.

## One studio, two honest doors

The hook contract makes the motion backend pluggable. The control plane is unchanged; the user picks
the door:

```
DATACENTER door:  control plane --> alibaba-wan / own-gpu --/run--> RunPod --> vivijure-backend
LOCAL door:       control plane --> local-gpu
                                    |-- keyframe  --> tunnel --> door action: preview (SDXL)
                                    |-- motion    --> tunnel --> door action: i2v_clip (LTX / CogVideoX)
```

When the planner selects `motion_backend: local-gpu`, the core **couples** the keyframe stage onto
this same module (vivijure-local#153) so a film never silently routes keyframes through RunPod.

Both doors speak the SAME `i2v_clip` / `preview` wire bodies as vivijure-backend; only the box
behind the endpoint differs. That sameness IS the swappability.

## Where it fits

It occupies the `motion.backend` slot (and also serves `keyframe`), `ui.order` 4 -- ahead of
`own-gpu` (5) and the rented cloud i2v modules, because a truly-local card needs no rent at all.

The seam is R2: the backend SHARES the `vivijure` bucket. It reads the bundle / keyframe by key and
WRITES keyframe PNGs + finished clips itself, so this module never downloads or re-uploads; it
submits, polls, and surfaces the keys the backend reported.

## Configuration

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `quality` | enum `draft` / `standard` / `final` | `standard` | i2v quality tier |
| `quality_tier` | enum `draft` / `standard` / `final` | `final` | keyframe quality tier |
| `fps` | int (8..30) | `24` | output frame rate (LTX is comfortable at 24-30) |
| `flow_shift` | float (1..12) | `5.0` | motion amount (lower = faster; LTX door) |
| `negative_prompt` | string | `""` | additive negative prompt (i2v) |
| `width` / `height` | int | `1344` / `768` | keyframe size |
| `steps` / `guidance_scale` | | | keyframe diffusion knobs |
| `seed` | int (>= -1) | `-1` | seed (`-1` = random) |

**Tier honesty (#124).** The `quality` / `quality_tier` enums are the core's shared vocabulary
(`draft/standard/final`); the local backend maps each tier to an engine config a consumer card can
honestly deliver.

To self-host (service `vivijure-module-local-gpu`, bound into the core as `MODULE_LOCAL_GPU`):

- **Env at deploy**: `CLOUDFLARE_ACCOUNT_ID` (account_id is injected, never hardcoded).
- **Secrets** (Cloudflare Secrets Store): `LOCAL_BACKEND_URL` (the tunnel hostname terminating at your
  homelab render box) and the optional `LOCAL_BACKEND_TOKEN`.
- **Provision**: run `vivijure-local-12gb` or `vivijure-local-16gb` on your box, expose it via a
  Cloudflare tunnel, and point `LOCAL_BACKEND_URL` at it. The backend shares the `vivijure` R2 bucket
  and does the artifact I/O. No R2 binding on this worker.

## Contract

- **Hooks**: `motion.backend` + `keyframe`. `ui { section: "motion", order: 4, locality: "local" }`.
- **Keyframe input/output**: same as the RunPod `keyframe` module (`KeyframeInput` / `KeyframeOutput`).
- **Motion input/output**: `MotionBackendInput` / `MotionBackendOutput`.
- **Async + cancelable**: `POST /invoke` submits `preview` or `i2v_clip` and returns a poll token;
  `POST /poll` checks `/status/{jobId}`; `POST /cancel` stops an in-flight job (`cancelable: true`).
- **R2 transport**: the backend reads/writes in the shared bucket itself; this worker holds no R2 creds.

Preview and i2v share one consumer card **serially** (the door unloads the idle weights between
stages). Finish-chain polish (RIFE / MuseTalk / upscale) remains a separate concern and may still
use RunPod modules.

## License

**AGPL-3.0-only.** A labor of love, given freely: use it, learn from it, self-host it, build your own
creative visions on it. Run it as a network service and the AGPL has you share your changes back, so it
stays a commons. It is not for sale, and not to be resold as a SaaS.
