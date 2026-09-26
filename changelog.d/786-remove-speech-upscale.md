### fix(modules)!: remove speech-upscale -- dead endpoint, no trigger, purpose retired

Its RunPod endpoint no longer existed (cf#757), so it was bound to nothing while the finish tier
booked the degrade as `completed`. Its only planner trigger was the `finish-lipsync` checkbox,
removed with MuseTalk (cf#783). Its purpose was cleaning dialogue BEFORE post-hoc mouth
replacement, and lip-sync now happens at motion time via `infinitetalk` taking Cast audio
directly. And it is CUDA, one of the three GPU stages Cloudflare Containers cannot host.

Gone with it: the `MODULE_SPEECH_UPSCALE` binding, `AUDIO_UPSCALE_RUNPOD_ENDPOINT_ID`,
`SPEECH_UPSCALE_DOORS` and both `SPEECH_DOOR_TOKEN` bearers, the `--satellite audio-upscale`
provisioner, the `vivijure-audio-upscale` endpoint from the installer, the tenant catalog and
release rows, and the PUBLIC demo catalog seed (with a demo migration that drops the live row).
The `satellites` profile is now one module, `finish-upscale`.

Nothing replaced it, deliberately. The Cast voice is muxed as recorded. The `speech` HOOK in
vivijure-core is untouched, so a future speech module inherits a checked contract; no shipped
module implements it, and the docs and the vendor census now SAY that rather than generating zero
tests and reading green.
