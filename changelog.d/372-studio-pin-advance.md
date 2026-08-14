### ci(release): advance the hosted studio pin as part of the release, and verify the published artifact first (cf#372)

`STUDIO_RELEASE` on `vivijure-control-plane` is the single value deciding which studio code a
hosted tenant runs; self-host pulls the same tag straight from this repo's GitHub release. When the
pin trails, hosted and self-host run different code from the same nominal tag, against the absolute
hosted/self-host parity invariant. It has gone stale three times, and twice the fix was to bump the
value, so the advance now happens on the release path rather than in anyone's memory.

`studio-release.yml` gains two steps after the R2 mirror. The first re-downloads the artifact it
just PUBLISHED (what a self-hoster would fetch, not the tree this job built), opens the tarball and
asserts the manifest `tag` FIELD equals the released tag -- a filename is a claim by whoever named
it. Only then does the second step call `scripts/advance-studio-pin.sh`, which reads the current
pin, refuses to move it BACKWARDS (this workflow is dispatchable for rebuilds of older tags),
PATCHes the variable, and reads the value back, because a 204 reports that a call was accepted and
not that the stored value is what was asked for.

Least-privileged credential: a fine-grained PAT carrying the `vivijure-control-plane` repository
permission "Variables: read and write" and nothing else, held as `STUDIO_PIN_VARIABLE_TOKEN`. That
is strictly narrower than the `Contents: write` a `repository_dispatch` requires (the price
`corpus-notify.yml` pays because its receiver must act), and `GITHUB_TOKEN` cannot do it at all.
Until that secret exists the step WARNS and does not fail, so a missing credential cannot break
every studio release; the backstop is in the other repo and does not share this step's condition
(cp#393 refuses to deploy a trailing pin and reads the live Worker binding daily).

Setting the variable is not deploying it: the control plane binds `STUDIO_RELEASE` at its own
deploy time, so this stages a value and cp#393's drift check is what observes the gap.

`tests/advance-studio-pin.test.py` drives every refusal arm against a local stand-in for the GitHub
API. Its load-bearing assertions are the ones about requests NOT sent -- a refusal that still
issued the PATCH would print a refusal and change hosted anyway, which an exit-code-only test
cannot distinguish.
