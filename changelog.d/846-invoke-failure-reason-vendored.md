### feat(modules): vendor `reason?: InvokeFailureReason` into all 34 module contracts, with one test holding them identical

core#291 added an optional `reason?: InvokeFailureReason` to the module contract's `/invoke` failure
arm: a closed union of eleven fault classes. This adopts it on the module side. **ABSENT still means
the module has not adopted the field, and is never defaulted to a class.**

**Why 34 copies rather than one import.** All 34 `modules/*/src/contract.ts` files are **import-free**,
measured (`grep -l "^import "` returns 0), and four of them state the rationale: *"Dependency-free,
which is the point: a module must be buildable and deployable without the core package."* So the union
cannot be imported into them. Sharing a file would have been one line each and was rejected for
breaking an invariant that currently holds in 34 of 34.

**Why 34 of the 65 identical failure arms, which is a decision and not a partial migration.** The
string `| { ok: false; error: string };` appears **65** times and serves **three** types:
`InvokeResponse` 34, `PollResponse` 29, `CancelResponse` 2. The string cannot tell you which; only the
enclosing declaration can, so a global replace would have widened the contract in **31** places with a
diff that looked uniform and correct.

`PollResponse` is excluded on core#306's own reasoning: it already carries a closed `outcome` set, and
adding `reason` beside it would put two closed unions on one object **sharing two spellings with
different meanings** (`backend-error` and `cancelled` are members of both, meaning "RunPod reported a
backend error" in one and "our module classified this as a backend error" in the other). A shared
spelling is not a shared meaning. That exclusion is now **asserted**, not merely omitted, so 34-of-65
cannot be misread as unfinished.

**The drift surface is closed by a test rather than a generator.** 34 copies of a closed vocabulary is
the structure that produced GHSA-qgx2-5crw-9m4j earlier today: two copies of one safety rule that
diverged, with the narrower copy's docstring asserting they were the same. A generator only helps if
someone runs it, and a generator nobody runs is a rule with no mechanism. So
`tests/invoke-failure-reason-vendored.test.ts` **derives the expected block from core's own
`INVOKE_FAILURE_REASONS` at test time** and compares it byte-for-byte against all 34 files, printing
the exact expected text on failure so the fix is a paste.

Verified by watching it fail, not by assuming:

- a **hand-edited copy** with the near-miss `not_configured` in one contract went red and named
  `modules/cf-veo/src/contract.ts`
- **core drift** went red end to end: a twelfth member added to the installed core's
  `INVOKE_FAILURE_REASONS` failed both the count assertion and all 34 comparisons, and printed the new
  canonical block including the new member

Also asserted: the 34-contract denominator, so a shrinking sweep cannot pass; that the four plausible
non-members (`not_configured`, `quota`, `rate_limited`, `backendError`) are rejected; and the bare-arm
count **in both instruments**, because 31 arms are owned by the excluded types while only 30 are a
standalone line (one `CancelResponse` is declared inline). Which number is "wrong" depends entirely on
the instrument, so both are pinned and named.

Core pin moves to `^1.24.0`, which is what makes the test able to read the canonical set from core.
The 34 contract edits themselves need no pin, being vendored; the single-source **mechanism** does.
