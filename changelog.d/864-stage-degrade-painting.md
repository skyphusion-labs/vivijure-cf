### test(panel): the stage-degrade projection is now asserted to reach the screen, in both directions

Four stage signals (`speech`, `master`, `dialogue`, `film_finish`) were decided by thoroughly tested
logic and rendered by DOM code nothing asserted. The gap is closed, and the half that mattered is the
negative one: **a clean stage and a never-reached stage must render nothing.** A block that appears on
a healthy render is worse than none, because people learn to ignore it and then it reads as coverage.

**A new shared seam, `public/stage-degrade-view.js`.** cf#853 wired the signals into two surfaces by
writing the same block-building loop twice, in `planner-render.js` and `planner-history-row.js` -- two
loops that must agree forever with nothing asserting they do. There is now one place a stage degrade
becomes DOM, both consumers go through it, and a ratchet asserts no third copy comes back.

It also made the rendering testable at all. Neither host function can be unit-called
(`buildHistoryRow` is ~980 lines reaching ~40 helpers declared in sibling planner files;
`renderDegradeNote` resolves live DOM through `$()`), which is why the wiring had only been asserted
by grep. `document` is a parameter rather than a global read, so the builder runs under plain Node
with a small element stub, the same pattern `finish-degrade.js` uses.

**The enumeration moved into the seam too, and that is load-bearing.** `stageBlocks()` alone can only
ever be handed already-reported stages, so asserting it returns nothing for an empty list is trivially
true and proves nothing about a clean payload. With `reportedStages()` in the same module, a test
drives a RAW payload end to end and watches the negative direction actually hold. It also means the
`limited` flag and the blocks share one enumeration and cannot disagree about which stages reported.

**Every zero-block assertion carries a witness that the path ran.** A negative assertion is the
easiest kind to make hollow: "no block rendered" passes just as happily when the enumeration was never
entered as when it ran and correctly declined. Each such case therefore asserts either that a spy saw
all four stage keys interrogated, or that a sibling stage in the same call DID render. Seven planted
defects were each driven red first, including one that short-circuits the enumeration -- which is what
proves the witness can tell those two states apart.
