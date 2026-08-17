### Fixed: hung ffmpeg no longer holds a finish-door thread forever (cf#571)

`video-finish`, `audio-mix`, and `audio-master` ran every ffmpeg/ffprobe child
with no `timeout=`. A wedged encode consumed one default-executor thread
permanently; `/health` kept answering and the door degraded until restart.

Every production invocation now goes through a bounded `_run`: default
`FFMPEG_TIMEOUT=1200s` (encodes) / `FFPROBE_TIMEOUT=60s` (probes), process-group
kill on expiry, named `FfmpegTimeout` (`ffmpeg timeout after Ns`). Assemble
fails loud (it is the film; there is no passthrough). `image-prep` and
`audio-beat-sync` have no ffmpeg subprocess.

Refs https://github.com/skyphusion-labs/vivijure-cf/issues/571
