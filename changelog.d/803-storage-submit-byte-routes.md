### fix(storage): meter the byte-writing routes core's list misses (cf#803)

The storage ceiling missed `/renders/:id/retry` (a full `startFilmJob`),
`/cast/:id/voice-sample`, `/voice-sample/attach` (32MB) and `/render/frames`, so
an over-quota studio was refused 507 on `/storyboard/render` and could then
re-render a whole film through `/retry`. The gate now checks core's list UNION a
panel supplement covering those four. The supplement is self-retiring: a test
fails if core ever starts covering one, so it must shrink rather than drift.
