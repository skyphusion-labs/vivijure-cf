### feat(media): send MEDIA_FINISH_TOKEN on film-titles, subtitle, beat-sync, and frames (cf#615)

The fleet containers refuse work when LOCAL_FINISH_TOKEN is set (cf#613). These
callers sent no bearer. They now attach Authorization when MEDIA_FINISH_TOKEN is
bound (reuses the FINISH_DOOR_TOKEN store secret). Unset stays fail-open.

Requires `@skyphusion-labs/vivijure-core@^1.17.0` so assemble and mux send the
same header.
