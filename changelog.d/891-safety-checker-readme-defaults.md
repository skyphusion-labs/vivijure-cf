### docs(modules): correct README default for `enable_safety_checker`, four repo-wide (cf#891)

`config_schema` declares `enable_safety_checker: default: false` in every module that carries it
("off: we already refuse CSAM"), and all six call sites read `cfg.enable_safety_checker === true`, so
the filter only turns on when a caller explicitly sets it. Four READMEs said the opposite: `kling`,
`kling-o1-r2v` and `infinitetalk` documented `default true` / `(default on)`, and `alibaba-wan-lora`
went further, stating "only an explicit `false` disables it" -- precisely inverted.

Corrected all four to `default false`, carrying the schema's own rationale. `alibaba-wan-lora`'s
inverted sentence is deleted rather than flipped in place (flipping alone would have left the
surrounding paragraph still implying a safe-by-default posture); replaced with a line stating the
filter becomes `true` only when explicitly set.

Repo-wide `grep -rln "enable_safety_checker" --include="*.md" .` confirms exactly these four; `alibaba-wan`
and `vidu-q3` (same call-site pattern, no README hit) were read in full and say nothing about the
setting either way, left alone. Docs only: no schema field, default, or call site touched.
