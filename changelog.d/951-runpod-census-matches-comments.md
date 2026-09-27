### fix(tests): the RunPod-reaching census classified COMMENTS as code, and four copies of it drifted from their own comment (cf#951)

Four census tests classified a module as RunPod-reaching with a substring match over the whole
file. `cf#289`'s own comment states the assumption that rested on: those strings "only ever live in
index.ts" as RUNTIME CODE. **Nothing enforced it.** A module that merely CITES
`_shared/runpod-route` in a comment was enrolled in the RunPod population and then required to
carry a plane-refusal guard for a plane it never calls.

Found building `modules/fal-wan-27`, a fal-only door with no RunPod import anywhere, enrolled by
one comment line. **In CI that is a loud red. In the cf#289 / cf#578 / cf#604 censuses it silently
inflates a denominator published as fact**, and it trains authors to delete accurate citations to
go green, which is the wrong pressure to put on anyone.

The suite already had a sharp negative control for a lookalike **behaviour** (`local-gpu` polls
`<LOCAL_BACKEND_URL>/status/<id>` and is correctly excluded) and none for a lookalike **mention**.
Right instinct, one level too shallow.

**The fix is one shared classifier**, `tests/runpod-census.ts`, imported by all four censuses in
place of four inline copies. It strips comments and then applies the same two-part predicate, so
the author's stated intent (runtime code only) is now enforced rather than assumed.

**The stripper is string-aware, and that is the sharp edge rather than a detail.** The host matched
for is `https://api.runpod.ai/...`, which CONTAINS `//`. A naive line-comment stripper deletes the
rest of that line and the host half of the predicate silently goes to ZERO. That is not
hypothetical: this suite already survived it once, when cf#394 moved the base URL into the shared
helper and, in cf#289's own words, "THE HOST-ONLY PREDICATE WENT TO ZERO THE MOMENT THAT LANDED".
`tests/runpod-census.test.ts` asserts the stripper preserves a URL inside a string literal, across
single quotes, double quotes, backticks and escapes.

**Proven behaviour-preserving before landing:** both predicates were run over all 35 modules.
Old 16, new 16, zero dropped and zero added. With the offending comment restored in the fal door,
old 17 and new 16, dropped exactly `fal-wan-27`. The fix removes the false positive and moves
nothing else.

**A second defect, in the comment that described the first.** `cf#398` said the predicate was
shared with "the cf#289 and cf#394 censuses" and that "the three cannot drift into three different
populations". Both halves were wrong: **cf#394 does not carry the predicate, and the files that do
are four, not three** (cf#289, cf#398, cf#578, cf#604). Anyone following that comment to fix all
three would have edited a file with nothing to fix and missed two that had, producing the exact
drift the sentence warned against. Corrected, and the wish is now a mechanism: one function, four
importers.

Gate: `npm run typecheck` exit 0; `npm test` exit 0; `npm run guard:resolve`, `npm run
check:catalog`, `npm run check:matrix` exit 0.
