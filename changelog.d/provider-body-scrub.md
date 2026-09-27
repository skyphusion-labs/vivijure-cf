### fix(modules): drop provider response bodies from thrown errors and returned error strings, keeping enumerated fields

A module that calls a provider now reports a refusal using the provider's ENUMERATED fields
(`error.code`, `error.type`) plus the HTTP status, and never the provider's free-text prose. Where a
path has no enumerated field, the prose is replaced by `untrustedLabel()` from `src/log-scrub.ts`, so
two reports of the same refusal still correlate and an operator can still see that a body was present.

Three call sites changed: `modules/image-generate/src/image-gen.ts` on both its OpenAI-direct and
AI-Gateway paths, and `modules/plan-enhance/src/provider.ts` on its Anthropic path.

**The invariant is now load-bearing rather than hygiene, and is stated in the code and the docs:**
`modules/plan-enhance/src/index.ts` folds an exception message into `output.notes` and into its
returned `error`, so "no throw on a provider path carries a fetched body" is what keeps provider text
out of persisted output. Two gates hold it: `tests/log-scrub.test.ts` behaviourally, against all
three live call sites through the same specifiers the modules use, and
`tests/modules-log-scrub-reexport.test.ts` statically, asserting no identifier assigned from a
response body reaches a thrown template. The static half is file-scoped and says so: a ratchet, not
a proof.

`src/providers/openai-image.ts` is **deleted**. It had no production importer, so it was a second
implementation of a live path that nothing ran; a patched file with no importer terminates a search.
The shared label vocabulary now reaches modules through `modules/_shared/log-scrub.ts`, a re-export
pointer at `src/log-scrub.ts` on the `modules/_shared/runpod-route.ts` precedent, because a copied
helper forks at copy time. `src/log-scrub.ts` imports nothing, so a module bundling it gets three pure
functions and no host coupling.

`docs/privacy-residual-dataset.md` is corrected. Its census said "the studio source" while being
scoped to `src/`, so every statement in it was true as written and false as read: `modules/` was never
swept. It now publishes its denominator, carries the commands to reproduce it, and covers both trees.

`tests/image-generate-module.test.ts` asserted that a provider's prose appeared in the returned error
string, so it pinned the old behaviour in place and went red on this change. Its intent (fail loud on
a refusal, never soft-degrade, name the model) is kept and the assertion is inverted.
