### fix(ci): the hosted-pin advance FAILS when its credential is missing, instead of warning green (cf#372)

`STUDIO_PIN_VARIABLE_TOKEN` was never provisioned, and the advance step warned and exited 0 on that
condition by design. It ran that way on the v1.27.0 and v1.28.0 tags, reported **success** both
times, and never attempted a read or a write. Meanwhile the deployed studio reached v1.28.0 while
the hosted pin stayed at v1.26.0, so hosted and self-host ran different code under one version
number, against the parity invariant, and the gap grew by one every ship.

**An annotation is not a gate.** A `::warning` renders a yellow badge, a zero exit, a green check
and no obligation on anyone. It rendered on both run summaries and was seen by nobody. The comment
that sanctioned the trade named cp#393 as the backstop, but cp#393 fires at the NEXT control-plane
deploy and its drift report is a report someone must read, so neither half was a control on the
release that skipped.

The skip is now scoped to the only case where it is legitimate. On a fork or a self-host build,
where the secret correctly does not exist, it still warns and exits 0. On this repository an absent
credential is `exit 1`: a release that silently does not advance the pin is a parity violation and
must not be reported as a release. An unset `GITHUB_REPOSITORY` fails CLOSED rather than reading as
probably-a-fork, since treating an absent thing as a benign one is the reasoning that produced the
defect in the first place.

**And a second step that runs even when no write happened.** The defect in one sentence is that a
skip and a success shared exit 0. Failing closed fixes the case that bit us; `--assert` covers the
rest of the class by reading the pin back and judging it against the tag whatever the advance
decided to do. The invariant it enforces is pin NOT BEHIND tag rather than pin equals tag, because
re-running an older tag CI run is the sanctioned rebuild path and the advance correctly declines a
backwards move there; demanding equality would paint that red for doing the right thing.

The suite grew from 19 assertions to 32. **The case that asserted the defect was inverted, not
added to:** it read "absent credential declines rather than failing the release" and expected
`rc == 0`, so the test encoded the same belief the script did and could not have caught this
either. Its control is the fork case, which must stay green, since a script that failed on every
absent credential would pass the new case identically.

NOT fixed here, because it is a credential and not code: the PAT still has to be provisioned.
Until it is, the next `v*` tag fails this step, loudly, which is the point.
