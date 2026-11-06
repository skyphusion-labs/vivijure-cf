### feat(video-finish): the container takes a feature-length film: 600 clips and a 768 MiB bed (#1122)

`MAX_CLIPS` rises from 80 to 600 and `MAX_AUDIO_BYTES` from 256 MB to 768 MiB (60 minutes of 16 bit 48 kHz stereo WAV is 691 MB). Chunked assemble already bounds disk to a fixed working set, so the clip count no longer protects the disk. This lands and deploys BEFORE vivijure-core 1.36.0, which raises core's admission to 600: a container that takes more than core admits is harmless, the reverse is not.

`client_max_size` stays 1 MiB. The assemble body core sends at 600 clips measures about 0.46 MB (one `{ url }` per clip, the 80-pair partial pool, the output URL), so the 4 MiB raise in the vivijure-cf#1122 design was not needed; that design counted 1.4 KB a clip.

`tests/clip-cap-equality-1122.test.ts` now holds the property rather than equality: core's `ASSEMBLE_MAX_CLIPS` is at most the container's `MAX_CLIPS`, an assemble body at the container's cap fits its request limit, and with the container's real bed limit on disk finalize still fits the largest film core admits. The panel scene cap stays held equal to core.
