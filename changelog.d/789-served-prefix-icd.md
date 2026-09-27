### test(shared): the served-prefix rule now fails CI when the two repos' lists diverge (cf#789)

The rule "which R2 prefixes are served, and therefore what may be copied into them" was stated in
four places across two repos, and the lists had already drifted in both directions. Nothing was
vulnerable; the risk was that widening any one of them silently reopens a closed class in a file
nobody would think to connect to it.

This adds neither a fifth restatement nor a shared list. It adds the **ICD**: one declared table of
the intended delta in `docs/CONTRACT.md`, and `tests/served-prefix-icd-789.test.ts`, which checks
both repos by EXECUTION against their real functions rather than by reading either list.

Why a check and not one source of truth: core's `RENDERS_AUDIO_PREFIXES` is a module-private `const`
and is not exported, so cf cannot import it, and making it importable is a core change plus a
publish plus a dependency bump before any drift becomes visible here. The two lists also answer
different questions -- cf's is "may this be SERVED", core's is "may this be STAGED as audio" -- so
collapsing them would either widen cf's serve surface or break core's staging.

The declared delta, both directions pinned: `dialogue/` is staged by core and not served by cf;
`cast/` is served by cf and refused by core. `quarantine/` is refused by both, which cf#789 found was
true only by accident of construction and is now an assertion.

Watched it go red in both directions, because a drift check that has never seen drift is decoration:

- adding a prefix to cf's `ARTIFACT_PREFIXES` fails the denominator case;
- adding `cast/` to core's `RENDERS_AUDIO_PREFIXES` fails `core refuses cast/` -- which is literally
  the failure scenario the issue was filed to prevent.

Carries a positive control on each side, since 9 of the 13 core assertions are of the form "it
refused" and a core that refused everything would satisfy all nine.
