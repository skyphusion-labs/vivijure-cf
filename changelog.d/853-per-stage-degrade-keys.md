### fix(panel): read the speech, master and dialogue degrade keys, so completed-with-limits can light for them

The panel now projects the three per-stage degrade keys `vivijure-core` emits (`speech`, `master`,
`dialogue`), in the same `{ degraded, reasons }` vocabulary it already parses for `output.finish`. A
film that was never mastered, whose speech chain passed everything through, or that shipped without
generated voices is now separable from a clean one, on the live render view and in render history.

**The ladder is three states, not two**, and keeping them apart is the whole point:

    key ABSENT        the stage was never reached. NOT MEASURED. Show nothing.
    degraded: 0       it ran and ran clean. Measured, and NOT a limit.
    degraded: n > 0   it ran and degraded; the reasons are the studio's own words, rendered verbatim.

The core omits the key entirely rather than writing a zero, so a parse that read a missing key as a
clean run would throw away the distinction the core is spending a field to preserve. Absent maps to
`unmeasured` and never to `none-reported`.

`degraded` is the COUNT and `reasons` is DEDUPED, so `degraded >= reasons.length` and the two are not
interchangeable: two shots failing for the same reason report `{ degraded: 2, reasons: [one] }`.
Deriving the count from `reasons.length` under-reports exactly when several shots fail the same way.

The existing clip-finish parser is GENERALISED rather than copied three times, since the shape is
identical: one parse per stage, not a parser per stage. The combining rule is deliberately **not
worst-of** -- it returns the composition, so "every stage measured, none degraded" stays
distinguishable from "some stage never measured", and an unreadable signal does not light the badge
as though the studio had named a limit.

No user-visible change until `vivijure-core` #317 lands and the pin bumps: with the keys absent every
stage reads `unmeasured` and nothing renders, which is the ladder's first rung working as designed.

Also corrects a stale claim in `public/finish-degrade.d.ts` that `film_finish.degraded` "does not
exist yet". It exists, `vivijure-core` emits it on both the single-film and scatter paths; what is
true is that nothing in `public/` reads it yet. Wiring that is tracked separately.
