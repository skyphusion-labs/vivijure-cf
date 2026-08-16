### fix(finish): project the degrade reason, not one `passthrough:` literal (cf#595)

Poll-path polish misses still tag `passthrough:backend-soft-degrade`. The
cause now rides in `FinishOutput.degraded` (core#226) onto `output.finish.reasons`,
and the planner renders those reasons verbatim. A user can tell "no face" from
"door timed out". CSAM refusals stay a hard fail in all four finish doors.
