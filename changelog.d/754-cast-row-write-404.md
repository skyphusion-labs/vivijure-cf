### fix(cast-media): a failed cast-row write answers 404 with a diagnostic, not `200 { cast: null }`

Port of `vivijure-local#351` to the hosted door (cf#754). Every image-registration POST on
`src/cast-media.ts` answered `200 { cast: null }` when the D1 row write produced no row: a failed
write reported as a success, with the failure and the success rendering as the same state to any
caller that does not inspect a field legitimately absent in neither case.

This was never a tidiness fix. The panel assigns `state.cast[idx] = data.cast` before it reads
anything, so the null landed in panel state; the editor populate then threw a JavaScript
null-property error instead of naming the write that failed, and the list kept rendering stale data
until an unrelated re-render hit the null. With a 404 the panel `api()` helper throws
`Error(body.error)` and every existing catch produces the right message, with no panel change.

**The failure body carries no `cast` field at all.** `404 { cast: null }` would still put null into
panel state, so the status alone does not close this; both halves are asserted separately.

Measured denominator on `main` at 4e2fe52, because the issue body's count was stale:
`grep -c "row ? toPublicCast(row) : null" src/cast-media.ts` returned **9**, not two -- 3 doors
(portrait / ref / source) x 3 entry forms (chat-artifact copy, staged key, raw bytes). Six were
live defects; the three staged-key sites already threw 404 one line above, so their null arm was
unreachable dead code. Two further `result.row ? ... : null` dead ternaries in the REMOVE handlers,
which that grep string does not match, were removed in the same pass: unreachable, but the exact
shape a new handler gets written by copying.

All nine now route through one `castRowResponse(row, op, id)` helper whose diagnostic names the
door and the entry form, so the nine 404s stay distinguishable from each other and from the
`cast not found` 404 for a missing member.

The truthy-`row` delete guard from #753 is KEPT, deliberately. It is redundant against the new
throw, but the ordering claim lives in the guard, not in the throw, and
`tests/cast-portrait-delete-ordering-local407.test.ts` still passes. Two cases in that file moved
from `status: 200` to `status: 404`; their claim (the superseded object survives a row write that
produced nothing) is untouched, only the expected literal.

Covered by `tests/cast-row-write-404-754.test.ts`: 9 failure cases and **9 positive controls**,
because nine 404s are otherwise exactly as consistent with nine handlers that never ran. Each
control proves by the recorded R2 op log and the key handed to the db mock that THAT site executed
(the copy form reads the source first, the raw-bytes form only puts, the staged form touches R2 not
at all). The structural guard strips comments before matching and carries a control of its own
showing each matcher producing a positive, since both this file and `cast-media.ts` quote
`{ cast: null }` in their prose.

Driven red first: with the source change stashed and the tests kept, 11 of 21 fail (all 9 failure
cases plus both structural guards), and the 9 controls stay green, which is what a control is for.
