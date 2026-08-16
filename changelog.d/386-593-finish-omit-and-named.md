### Fixed: omitting `finish_config` no longer bills default polish; a named missing finish module fails closed (cf#386, cf#593)

An MCP / `POST /api/render/film` caller who did not mention finish still ran the default
participation set (rife + lipsync + upscale) at schema defaults. That is the expensive reading of
"leave it out": the film looked bare in the request and was not. Omit `finish_config` (and
`finish_select`) is now `{ mode: "named", modules: [] }`. Explicit empty is the same. Keys of a
present `finish_config` (minus `finish-order`) become the named list. `{ mode: "default" }` is how
a caller still asks for the participation set. The planner door is unchanged: no `select` key still
means default participation.

A named finish module this studio does not serve used to drop silently, so `{ mode: "named",
modules: ["ghost"] }` became an empty chain that read as "nothing to do". The planner now reports
`unresolved` (an error, not derived-empty) and the render door `400`s
`finish module(s) requested but not serving: ...` before any keyframe spend. Core still fails the
job at enterFinishPhase if a caller bypasses the door.

cf#595 (every poll-path degrade is one `passthrough:backend-soft-degrade` literal) is not in this
PR. Closing it needs a closed cause-code vocabulary from the doors plus vivijure-core#226 so
`summarizeFinish` can count more than the tag prefix. Not a same-file sibling.

Refs https://github.com/skyphusion-labs/vivijure-cf/issues/386
https://github.com/skyphusion-labs/vivijure-cf/issues/593
https://github.com/skyphusion-labs/vivijure-cf/issues/595
