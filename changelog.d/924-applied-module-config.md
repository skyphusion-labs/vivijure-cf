### feat(renders): record what the modules were actually told, not just which door ran (cf#924)

A render recorded **which** door ran (`motion_backend` / `keyframe_backend`, cf#393) and never **what it
was told to do**. The config bag was accepted at submit, carried into the job, handed to the module, and
then dropped, so the knobs a render actually used were unreadable afterwards -- including the one that
doubles the price on a door.

New `output.applied_module_config` on every film render, carrying the resolved config each module
received, the raw config the caller requested, and both door names.

**Resolved and requested are separate fields and never conflated.** `motion_resolved` is what core's
`validateConfig` produced per shot and the module actually received (core already retains it as
`shot.config`, #767). `motion_requested` is the raw caller bag. `keyframe_requested` is labelled
requested-only, because the keyframe worker resolves its own config and the host never sees that value.
They differ exactly when something coerced, which is the case worth seeing. Per-shot configs collapse to
a single object when every shot agrees (compared by value with sorted keys, so a reordered bag is not a
disagreement) and fall back to `motion_resolved_by_shot` when a per-shot backend override makes them
genuinely differ.

**Absent means NOT RECORDED**, never "no config was used": the builder returns `null` rather than an
empty shape, which is the honest answer for legacy rows and for a film that has not reached the clips
phase.

The specific thing this prevents: a `size: "720p"` request to `infinitetalk` produced an 832x464
artifact, and separating "the value never reached the vendor" from "the vendor ignored it" took reading
four files and running the real compiled `validateConfig` against a probe table, and **still ended
undetermined** -- resolved only later by a direct vendor submit (cf#935). One recorded field answers it
in a single read. It also catches the inverse error made in the same sprint: reading 832x464 as proof
the 480p request was *honoured*, when 480p is the schema default and the artifact cannot distinguish
"applied" from "never arrived".

Carried on the `output` bag rather than a new column, matching the relay core already uses for
`clip_deliveries` / `keyframes_incomplete` and the host already uses for `wan_lora_projection` (cf#392).
`NewRenderRow`, `buildInsertRenderStmt` and the `SELECT` projection all live in `vivijure-core`, so a
first-class column would need a core change, a D1 migration, a core release and a pin bump here. The
field is queryable in D1 via `json_extract`, and **if a real column is wanted later this field is what
backfills it** -- the option stays open rather than foreclosed.
