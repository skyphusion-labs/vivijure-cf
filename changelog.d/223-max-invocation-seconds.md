### Added: finish/speech manifests declare `max_invocation_seconds` (core#223)

The five clip-level finish/speech modules now declare the wall-clock
guard their doors already enforce (shipped default, not an aspiration):

- finish-lipsync 540 (musetalk `MAX_INVOCATION_SECONDS`)
- finish-rife 420 (backend `DEFAULT_MAX_SECONDS`)
- finish-upscale 1200 (`FFMPEG_TIMEOUT`; hosted path is URL doors)
- finish-blender 5400 (`PHASE_HARD_DEADLINE_SECONDS`)
- speech-upscale 540 (speech-door default; audio-upscale sibling)

If a door env overrides the guard, the number here is the shipped
default. Does not flip the core `checkManifest` gate.

Refs https://github.com/skyphusion-labs/vivijure-core/issues/223
