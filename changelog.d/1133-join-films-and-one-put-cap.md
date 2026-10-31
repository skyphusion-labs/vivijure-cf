### feat(video-finish): join finished films into one film, and cap a film at what one upload carries

`POST /async/join-films` joins up to 64 finished films, in order, by URL, into one PUT. The video is copied and the audio is encoded once. Films must match in frame, rate and codec, and a mismatch is refused before any join. The job id comes from the object paths, so a re-submit after a restart reaches the same job and writes the same bytes. See `containers/video-finish/README.md`.

`MAX_FILM_BYTES` falls from 6.85 GB to 5,363,466,240 bytes, the R2 limit for one PUT, and `_put_file` refuses above it with a named 413. Core's assemble admission needs the matching change.
