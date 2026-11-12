# Media-stack CPU containers

Five CPU finishing services (ffmpeg, librosa, rembg) that the studio Worker and the media finish
modules call over public HTTPS origins (`VIDEO_FINISH_URL`, `IMAGE_PREP_URL`,
`AUDIO_BEAT_SYNC_URL`, `AUDIO_MIX_URL`, `AUDIO_MASTER_URL`) with the `MEDIA_FINISH_TOKEN` bearer.
Workers VPC is no longer used for media.

Each image runs in one of two ways:

1. **As a Cloudflare Container app (the reference deploy).** Each service has its own Worker in
   `containers/<svc>/cf-container/`, and that Worker builds this directory's `Dockerfile`.
2. **With `docker compose` on your own box (the self-host path).** See "Local / self-host" below.

`docs/DEPLOYMENT.md` section 5 is the operator guide for both.

## Cloudflare Container apps (`cf-container/`)

| Service | Worker name | DO class / binding | `instance_type` | `max_instances` | Deployed by |
| --- | --- | --- | --- | --- | --- |
| `video-finish` | `vivijure-video-finish` | `VideoFinishDoor` / `FINISH` | standard-4 | 20 | `deploy-container-doors` job in `ci.yml`, on a `v*` tag |
| `image-prep` | `vivijure-image-prep` | `ImagePrepDoor` / `PREP` | standard-1 | 2 | `deploy-container-doors` job in `ci.yml`, on a `v*` tag |
| `audio-mix` | `vivijure-audio-mix` | `AudioMixDoor` / `MIX` | standard-1 | 2 | `deploy-container-doors` job in `ci.yml`, on a `v*` tag |
| `audio-beat-sync` | `vivijure-audio-beat-sync` | `AudioBeatSyncDoor` / `BEATS` | standard-1 | 2 | `deploy-container-doors` job in `ci.yml`, on a `v*` tag |
| `audio-master` | `vivijure-audio-master` | `AudioMasterDoor` / `MASTER` | standard-1 | 2 | `deploy-container-doors` job in `ci.yml`, on a `v*` tag |

Each `cf-container/wrangler.toml` sets `image = "../Dockerfile"` and `image_build_context = ".."`
and requires one wrangler secret, `LOCAL_FINISH_TOKEN`. Its value must equal the studio's store
secret `FINISH_DOOR_TOKEN`. The Worker checks `Authorization: Bearer` itself before it forwards
(`cf-container/src/gate.ts`; every route except `GET /health` and `GET /ready`), and passes the same
secret into the container through `envVars`, so the container's `bearer.py` checks it again.

Deploy one by hand (Docker running; see DEPLOYMENT.md 5a for the build host rule):

```bash
cd containers/<svc>/cf-container
npm ci
npx wrangler secret list            # names only; LOCAL_FINISH_TOKEN must be listed
npx wrangler deploy --containers-rollout=immediate
```

Then run that door's bearer-authenticated `POST /selftest` on its custom domain. `/health` and
`/ready` do not prove the token matches the studio's. **A token rotation must restart each door's
containers** (or move the door to a new container name), because a running container keeps the
`LOCAL_FINISH_TOKEN` it started with. DEPLOYMENT.md 5a has the full rule.

`vivijure-video-finish` is NOT the studio's own `FinishContainer`. Both build
`containers/video-finish/Dockerfile`, but `FinishContainer` is a container app of the studio Worker,
reached through its `FINISH_CONTAINER` binding. `vivijure-video-finish` is the public door that the
`film-titles` and `subtitle` module workers reach over `VIDEO_FINISH_URL`. A change under
`containers/video-finish/` therefore needs two rollouts: the studio deploy with
`--containers-rollout=immediate`, and the `vivijure-video-finish` door deploy.

## Images and packages

| Service | Local compose image | GHCR package |
| --- | --- | --- |
| `video-finish` | `vivijure-cf-cpu:local` (`CPU_APP=video-finish`) | `ghcr.io/skyphusion-labs/vivijure-cf-video-finish` |
| `image-prep` | `vivijure-cf-image-prep:local` | `ghcr.io/skyphusion-labs/vivijure-cf-image-prep` |
| `audio-beat-sync` | `vivijure-cf-cpu:local` (`CPU_APP=audio-beat-sync`) | `ghcr.io/skyphusion-labs/vivijure-cf-audio-beat-sync` |
| `audio-mix` | `vivijure-cf-cpu:local` (`CPU_APP=audio-mix`) | `ghcr.io/skyphusion-labs/vivijure-cf-audio-mix` |
| `audio-master` | `vivijure-cf-cpu:local` (`CPU_APP=audio-master`) | `ghcr.io/skyphusion-labs/vivijure-cf-audio-master` |

Self-host compose builds one image, `containers/cpu`, for the four join services. That image contains ffmpeg and librosa. `CPU_APP` selects the process. image-prep stays its own image. The per-service Dockerfiles remain, and CI still publishes a GHCR package per directory, including `ghcr.io/skyphusion-labs/vivijure-cf-cpu`. The Cloudflare Container apps do not use the GHCR packages; wrangler builds each image from its Dockerfile and pushes it to the Cloudflare registry.

## Naming

Package names **reflect this repo** (`vivijure-cf-*`). Do not reintroduce the old
orphaned `vj-*` GHCR names (manual jello pushes; deleted 2026-07-15).

These are **not** the `vivijure-local-*` images. Those are built by
`skyphusion-labs/vivijure-local` for the local control panel (modified containers
for that host). Same duties, different lineage.

## CI publish (GHCR)

`.github/workflows/build-media-images.yml` builds each `containers/<svc>` and
pushes to GHCR with the repo `GITHUB_TOKEN` (`packages: write`) plus
`org.opencontainers.image.source` so each package **auto-links** to this repo.

Triggers:

- push to `main` that touches `containers/**` or the workflow file
- `workflow_dispatch` with optional `tag` (version label on all five)

Pin a package by **digest**, never `:latest`, if you run it. The Hetzner fleet that pinned these
in `fleet-chezmoi` `system/swarm/stacks/vivijure-media.stack.yml` is retired; that history is in
[`fleet-chezmoi` runlog 2026-07-15-ghcr-package-audit](https://github.com/skyphusion-labs/fleet-chezmoi/blob/main/docs/runlog/2026-07-15-ghcr-package-audit.md).

## Local / self-host

```bash
docker compose -f containers/compose.yaml up -d --build
```

Self-hosts build from source; they do not need the GHCR packages. The four join services come up from `vivijure-cf-cpu:local`.
