### Fixed: `poll_cast_refs` `registered` never moved while the job ran (cf#386)

The cast-image module generated one image per poll and the orchestrator only called `addRefs` on the
terminal batch, so six healthy polls read `registered: 0` then jumped `0 -> N` at done. A stuck job
was byte-identical to a healthy mid-run under that signal. The module now returns progressive
`images` + `progress` on pending polls; the orchestrator folds each new key onto the member as it
lands. `registered` and `images` grow while `phase === "generating"`. A legacy bare-pending module
still batches at done (graceful).

Two honesty rules came with it. Mid-run images are checked against the same `cast.image` per-image
rule the terminal batch already went through (`addRefs` appends verbatim, so the fold was the only
unguarded path onto the member), and a terminal registration failure now ends the job
`phase: "failed"` with `registered k of n generated refs; cast row unavailable` instead of reporting
`done` with a `registered` self-consistent with a batch that was dropped.

### Docs: omitting a `*_config` does not skip a chain hook (cf#386)

Intended: every serving module for a chain hook runs, clamped to schema defaults. Natural reading of
"omit the config" was skip -- which mispriced phase-1 matrix cost and left no predicted tags for
default-only steps. CONTRACT + MCP tool text now state the omit rule and point at module no-op knobs
(e.g. `finish-rife` `interpolate: false` -> `noop:interpolate-off`).
