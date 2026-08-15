### fix(finish): prefer satellite presigned mode when core hands URLs (cf#312)

The finish satellites already branched on presigned URLs and nothing ever sent them one. Every
caller shipped `clip_key` / `audio_key`, which is what selects the shared-bucket R2 path on the
handler side, so `vivijure-upscale`, `vivijure-musetalk` and `vivijure-audio-upscale` were pinned to
the credentialed transport and could not be pooled. The branch was live code with no producer.

`buildRunPodBody` in `finish-upscale`, `finish-lipsync` and `speech-upscale` now emits the
credentialless shape when the core attaches presigned URLs (`video_url` + `output_url`, plus
`audio_url` for lipsync and audio), and OMITS the key fields while doing so. The omission is the
load-bearing half: the handler routes on which keys are PRESENT, so sending both shapes would select
R2 mode and the presigned URLs would be ignored silently, which is the failure this change would
otherwise ship. Absent URLs keep the legacy R2 body byte for byte, so an older core, or one with
`PRESIGNER` unbound, is unaffected rather than broken.

The four transport fields (`video_url`, `output_url`, `output_key`, `hash_url`, plus `audio_url`
where it applies) are additive and optional on each module's VENDORED `FinishInput`. They are
mirrored rather than imported, because these contracts are copied on purpose so a module does not
depend on the core repo; a field the core adds does not arrive here on a dependency bump.

`output_key` is now taken from the core when supplied and falls back to the module's own derivation
(`upscaledKey` / `lipsyncedKey` / `enhancedAudioKey`) when it is not, so the presigned PUT target and
the key the chain reports downstream cannot disagree.

The cf#507b derived upscale factor is unaffected and reaches BOTH transports: `resolveUpscaleScale`
still decides the factor, and the result lives in the object both return paths spread, so a
presigned job asks the GPU for the same scale a shared-bucket job would.

`finish-rife` is deliberately unchanged. It drives `vivijure-backend`'s `finish_clip`, which has no
presigned branch at all (its R2 I/O is open ended and would need per job credentials or endpoint
env), so giving it URLs would be a shape the handler cannot read.
