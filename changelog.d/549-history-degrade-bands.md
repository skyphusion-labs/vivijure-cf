### feat(planner): render history states what it knows about degradation, in four bands (cf#549)

A film that soft-degraded at assemble (per-shot clips instead of an assembled film) or at mux (a
silent film) was recorded and DISPLAYED in render history byte-identically to one that shipped
complete: `done`, `errors: []`, same row. The observable was not missing from the system, only from
the place anyone looks -- cf#118 has put `output.finish_unavailable {at, reason, delivered}` on the
poll view all along, the live render view consumes it through `public/finish-degrade.js`, and
`planner.html` loads that helper (line 606) BEFORE `planner-history-row.js` (line 624). Measured
with a control in the same command: the same matchers return 3 hits against `finish-degrade.js` and
`planner-render.js` and **0** against `planner-history-row.js` and `planner-history-list.js`, while
the row reads `r.output` for eight other fields. The projection was on the page and the row never
called it.

`degradeFrom()` returns `null` for "no degrade" and for a junk payload alike, deliberately: on the
live view a parse failure must never tell a user their good film is broken. That forgiveness is
correct there and insufficient here, because history has to be COUNTABLE and a null meaning three
things is the defect itself. So this adds a SECOND, wider projection over the same field --
`degradeFrom` is untouched and still owns the parse. `degradeBand()` returns `unmeasured` (no
readable payload), `none-reported` (readable, reports no degrade), `unreadable` (reported something
we could not read) or `reported`.

**`none-reported` is deliberately not "clean" and nothing renders it as a verdict.** It means this
payload reports no assemble/mux soft-degrade and nothing more; `film_finish.degraded`
(vivijure-core#203) is unmerged and absent from every row today, so title-card and subtitle
degradation is outside what any band here can see. No UI pretends that field exists and no clean
verdict is derived from its absence. A comment records what dropping it in later requires, including
that the combining rule must not be worst-of, because a partially-measured row is its own fact.

Every row carries the band as `data-finish-degrade`, in all four values, so a degraded row is
distinguishable by something it POSITIVELY renders rather than by a missing badge, and the
unmeasurable rows are countable too -- that second number is what stops a run of unmeasurable rows
scoring as a clean run. Only the two bands needing a human are badged, because a badge firing on
every healthy row is a badge people learn to ignore. The expanded row shows the structural sentence
from `deliveredSummary()` and then the studio reason verbatim.

Also fixed here, found while wiring the above: `resumeRender()` repainted the render panel from a
history row and never touched the cf#118 degrade disclosure or the CLEARED state of the download
anchors, both written only by `renderDeliverable()` on the live-poll path. Viewing a clean row after
a degraded one left the previous render's warning standing over it; the other direction left the
download button hidden on a row that has a film. Routed through the same projection, which writes
the anchors on every branch. Which source wins is measured against the shipped core
(`dist/renders-db.js`): the advance path writes `output_key = COALESCE(?, output_key)` beside an
unconditional `output_json = ?`, so the column is STICKY and the blob is the fresh truth; the blob
wins wherever there is one, and the column is used only when there is none.

`tests/finish-degrade.test.ts` gains 11 assertions, each driven RED by a mutation with its siblings
shown green in the same run. Collapsing any band into a neighbour reddens that band's own assertion
plus the shared collapse test and leaves 25 of 27 green, which is what distinguishes three
assertions from one check wearing three names. The mutation pass also caught a vacuous assertion in
this change's own tests (two badge notes compared for inequality stayed green when one went
missing), now fixed by asserting both non-null first.

**Refs #549, does not close it.** `film_finish.degraded` is core-side and unmerged, so the
title-card and subtitle half of this gap is untouched.
