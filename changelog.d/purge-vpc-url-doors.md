### fix(doors): purge Workers VPC; doors are operator URL lists

`DOOR_ORIGIN` / `VIDEO_FINISH_SUBMIT` baked production hostnames into
`modules/_shared/finish-door.ts`. film-titles and subtitle fell back to
that constant when `VIDEO_FINISH_URL` was unset. Finish modules built
their pool from those URLs whenever a token was present.

Doors are config now. `FINISH_UPSCALE_DOORS` / `SPEECH_UPSCALE_DOORS` /
`FINISH_BLENDER_DOORS` are comma-separated HTTPS origins (first URL is
the legacy door). Empty list is the RunPod path. New poll labels mint as
`door` / `door-<host>`; in-flight `vpc` / `vpc-<host>` still resolve.
`VIDEO_FINISH_URL` / `AUDIO_MASTER_URL` / `AUDIO_BEAT_SYNC_URL` have no
baked fallback. Hosted `[[vpc_services]]` blocks are gone (LOKI_VPC in
the tail worker stays).

A test fails if `skyphusion.org` / `DOOR_ORIGIN` / `VIDEO_FINISH_SUBMIT`
return to `finish-door.ts`.
