### chore(finish): record 1.33.4 title inject; spend ceiling off

`vivijure-module-film-titles` and `vivijure-module-subtitle` have a
nonempty `VIDEO_FINISH_URL` on the versions the edge is serving.
Public `/ready` is off (`workers_dev = false`). One new film id still
needed; C1 stays closed.

Hosted studio `SPEND_DAILY_CEILING` was 25 (template leftover). Live
inherit-patched to 0 (full bindings list). The template now ships `"0"`
so the next tag does not put 25 back.
