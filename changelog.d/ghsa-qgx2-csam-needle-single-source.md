### fix(finish): a single shared CSAM needle, and a guard that keeps it single (GHSA-qgx2-5crw-9m4j)

The CSAM refusal discriminator is now declared **once**, in `modules/_shared/finish-soft-degrade.ts`,
and `modules/cloud-keyframe/src/image-gen.ts` imports it instead of declaring its own. A refusal is a
HARD FAIL and never a polish degrade; that was always the intent, and it is now enforced by one
predicate rather than promised by a docstring.

Details of the prior behaviour are in advisory **GHSA-qgx2-5crw-9m4j**.

**The drift surface is closed, not just the drift.** `tests/csam-needle-one-copy.test.ts` scans the
shipped trees and fails if any file other than the single source applies a string test to a CSAM
needle, so a second copy cannot be reintroduced. It carries its own controls: a positive control that
the scanner can still see the real needle, so the count cannot pass vacuously on an empty population
if the predicate is ever renamed out of its reach; a check that it does NOT flag the three `finish-*`
modules that legitimately BUILD a `"csam refusal: "` message after calling the shared discriminator,
because a guard that cries wolf on a legitimate caller is a guard someone disables; and it was
verified by injecting a second matcher into a real file and confirming it named the exact file and
line rather than only passing on synthetic input.

**Widening is one-way, and that is documented in the code.** A false negative on this predicate is a
missed refusal; a false positive is a film that hard-fails and gets looked at. Those costs are not
comparable, so the needle only ever grows.

**Two structural lessons kept in the code rather than here**, because they generalise past this fix:

- `BACKEND_SOFT_DEGRADE` exists in that same file so "the four call sites cannot drift into four
  spellings of it". Sharing a constant to prevent drift while duplicating the predicate beside it is
  the shape to watch for; the comment says so at the point where someone would repeat it.
- The existing suite was green throughout, because its positive cases were written against the same
  single spelling as the implementation. **A test that shares its input vocabulary with the code it
  tests cannot observe a divergence from a second implementation elsewhere.** That reasoning is now a
  header comment in `tests/finish-soft-degrade-csam.test.ts` so the pattern is not restored. The new
  cases were driven RED before the fix, against all three consumers rather than the predicate alone.
