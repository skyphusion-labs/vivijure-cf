# Media-stack CPU containers

Five always-on CPU finishing services used by the studio Worker over Workers VPC
(and by the fleet Swarm `vivijure-media` stack).

| Service | Local compose image | Fleet GHCR package |
| --- | --- | --- |
| `video-finish` | `vivijure-cf-cpu:local` (`CPU_APP=video-finish`) | `ghcr.io/skyphusion-labs/vivijure-cf-video-finish` |
| `image-prep` | `vivijure-cf-image-prep:local` | `ghcr.io/skyphusion-labs/vivijure-cf-image-prep` |
| `audio-beat-sync` | `vivijure-cf-cpu:local` (`CPU_APP=audio-beat-sync`) | `ghcr.io/skyphusion-labs/vivijure-cf-audio-beat-sync` |
| `audio-mix` | `vivijure-cf-cpu:local` (`CPU_APP=audio-mix`) | `ghcr.io/skyphusion-labs/vivijure-cf-audio-mix` |
| `audio-master` | `vivijure-cf-cpu:local` (`CPU_APP=audio-master`) | `ghcr.io/skyphusion-labs/vivijure-cf-audio-master` |

Self-host compose builds one image, `containers/cpu`, for the four join services. That image contains ffmpeg and librosa. `CPU_APP` selects the process. image-prep stays its own image. The per-service Dockerfiles remain, and CI still publishes a GHCR package per directory, including `ghcr.io/skyphusion-labs/vivijure-cf-cpu`.

## Naming

Package names **reflect this repo** (`vivijure-cf-*`). Do not reintroduce the old
orphaned `vj-*` GHCR names (manual jello pushes; deleted 2026-07-15).

These are **not** the `vivijure-local-*` images. Those are built by
`skyphusion-labs/vivijure-local` for the local control panel (modified containers
for that host). Same duties, different lineage.

## CI publish (fleet)

`.github/workflows/build-media-images.yml` builds each `containers/<svc>` and
pushes to GHCR with the repo `GITHUB_TOKEN` (`packages: write`) plus
`org.opencontainers.image.source` so each package **auto-links** to this repo.

Triggers:

- push to `main` that touches `containers/**` or the workflow file
- `workflow_dispatch` with optional `tag` (version label on all five)

Fleet pins by **digest** in
`fleet-chezmoi` `system/swarm/stacks/vivijure-media.stack.yml` (never `:latest`
in prod). Audit + cutover:
[`fleet-chezmoi` runlog 2026-07-15-ghcr-package-audit](https://github.com/skyphusion-labs/fleet-chezmoi/blob/main/docs/runlog/2026-07-15-ghcr-package-audit.md).

## Local / self-host

```bash
docker compose -f containers/compose.yaml up -d --build
```

Self-hosts build from source; they do not need the GHCR packages. The four join services come up from `vivijure-cf-cpu:local`.
